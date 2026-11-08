export * as PlanTool from "./plan.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import path from "path"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { ConfigFork } from "../../config/fork.js"
import { SessionPlan } from "../../session/plan.js"
import CREATE_DESCRIPTION from "./plan/create.txt"
import EXIT_DESCRIPTION from "./plan/exit.txt"

const plan = Agent.ID.make("plan")

const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description:
      "Filename for the plan (e.g. `01-feature-x.md` for a new top-level plan, or `00.01-detail.md` for a subplan of `00`). Must be a safe markdown basename following the naming convention. If omitted, the next top-level iteration is generated. The agent decides new-vs-subplan by the filename: a dotted iteration makes it a subplan.",
  }),
})

const CreateOutput = Schema.Struct({
  path: Schema.String,
  iteration: Schema.String,
  parent: Schema.optional(Schema.String),
})

const ExitInput = Schema.Struct({})

const ExitOutput = Schema.Struct({
  plan: Schema.String,
  switched: Schema.Boolean,
})

export const Plugin = {
  id: "opencode.tool.plan",
  effect: Effect.fn("PlanTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service
    const fork = yield* ConfigFork.loadForLocation(ctx.location)
    // Primary agent that takes over after plan approval (fork plan.agent, default build).
    const exitAgent = Agent.ID.make(fork.plan?.agent ?? "build")
    const exitName = fork.plan?.agent ?? "build"

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "plan_create",
        options: { codemode: false },
        description: CREATE_DESCRIPTION.replaceAll("${planAgent}", exitName),
        input: CreateInput,
        output: CreateOutput,
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: "plan_create",
              resources: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            const info = yield* ctx.session.get({ sessionID: context.sessionID })
            // The agent decides whether this is a new plan or a subplan by the
            // filename it passes: a dotted iteration (e.g. 00.01-x.md) is a subplan;
            // a plain name (e.g. 01-x.md) or an omitted name is a new top-level plan.
            // This tool never writes the file — the agent authors it with write/edit.
            const plan = yield* SessionPlan.plan(
              { id: info.id, title: info.title, metadata: info.metadata },
              ctx.location,
              fork,
              input.name ? { name: input.name } : { forceNew: true },
            )
            yield* ctx.session.update({
              sessionID: context.sessionID,
              metadata: { ...info.metadata, activePlanPath: plan.path },
            })
            const planRel = path.relative(ctx.location.directory, plan.path)
            const parentRel = plan.parent ? path.relative(ctx.location.directory, plan.parent) : undefined
            return {
              output: { path: planRel, iteration: plan.iteration, parent: parentRel },
              content: parentRel
                ? `Active plan is now ${planRel} (subplan ${plan.iteration} of ${parentRel}). Write the plan content to ${planRel} with the write tool and record \`parent: ${parentRel}\` in its frontmatter.`
                : `Active plan is now ${planRel}. Write the plan content to ${planRel} with the write tool.`,
              metadata: {},
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: "plan_create failed", error }),
            ),
          ),
      }),
    )

    // Shared exit tail for plan_exit and the submit_plan approval hook: mark
    // the session implementing, switch to the build agent, and admit the
    // synthetic prompt that starts the plan_complete review lifecycle.
    const startImplementation = Effect.fn("PlanTool.startImplementation")(function* (sessionID: Session.ID) {
      const info = yield* ctx.session.get({ sessionID })
      const resolved = yield* SessionPlan.plan({ id: info.id, title: info.title, metadata: info.metadata }, ctx.location, fork)
      const planRel = path.relative(ctx.location.directory, resolved.path)
      const now = Date.now()
      yield* ctx.session.update({
        sessionID,
        metadata: {
          ...info.metadata,
          planImpl: {
            status: "implementing",
            title: info.title ?? planRel,
            planPath: resolved.path,
            startedAt: now,
            activeStartedAt: now,
            timeUsedSeconds: 0,
            reviewIteration: 0,
          },
        },
      })
      yield* ctx.session.switchAgent({ sessionID, agent: exitAgent })
      yield* ctx.session.synthetic({
        sessionID,
        text: `The plan at ${planRel} has been approved. You are now in implementation mode — execute the plan. When implementation is complete and verified, call the plan_complete tool to trigger code review.`,
      })
    })

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "plan_exit",
        options: { codemode: false },
        description: EXIT_DESCRIPTION.replaceAll("${planAgent}", exitName),
        input: ExitInput,
        output: ExitOutput,
        execute: (_input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: "plan_exit",
              resources: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            const info = yield* ctx.session.get({ sessionID: context.sessionID })
            const plan = yield* SessionPlan.plan(
              { id: info.id, title: info.title, metadata: info.metadata },
              ctx.location,
              fork,
            )
            const planRel = path.relative(ctx.location.directory, plan.path)
            const exists = yield* SessionPlan.fileExists(plan.path)
            if (!exists) {
              return {
                output: { plan: planRel, switched: false },
                content: `No plan file exists at ${planRel} (or the active-plan pointer). Write the plan first, then call plan_exit again.`,
                metadata: {},
              }
            }

            const state = yield* forms
              .ask({
                sessionID: context.sessionID,
                title: "Build Agent",
                metadata: { kind: "question", tool: { messageID: context.messageID, id: context.id } },
                fields: [
                  {
                    key: "q0",
                    title: "Build Agent",
                    description: `Plan at ${planRel} is complete. Would you like to switch to the ${exitName} agent and start implementing?`,
                    type: "string",
                    custom: true,
                    options: [
                      { value: "Yes", label: "Yes", description: `Switch to the ${exitName} agent and start implementing the plan` },
                      { value: "No", label: "No", description: "Stay with plan agent to continue refining the plan" },
                    ],
                  },
                ],
              })
              .pipe(Effect.orDie)
            if (state.status === "cancelled") {
              return yield* Effect.fail(
                new ToolFailure({ message: state.message ?? "The user dismissed the plan approval question" }),
              )
            }
            if (state.answer["q0"] === "No") {
              return yield* Effect.fail(new ToolFailure({ message: `The user declined switching to the ${exitName} agent` }))
            }

            yield* startImplementation(context.sessionID)
            return {
              output: { plan: planRel, switched: true },
              content: `User approved switching to the ${exitName} agent. Wait for further instructions.`,
              metadata: {},
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: "plan_exit failed", error }),
            ),
          ),
      }),
    )

    // Plannotator integration: an approved submit_plan review IS the user
    // approving the plan in the web UI, so run the plan_exit tail directly
    // (the approval replaces the Build Agent Yes/No form) and the
    // plan_complete review loop starts without waiting for the plan agent
    // to call plan_exit itself.
    // shortcut: approval is detected by the "Plan approved" tool-result
    // prefix; a customized plannotator plan.approved prompt that drops that
    // prefix silently skips this hook (the agent then falls back to plan_exit).
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.tool !== "submit_plan" || event.agent !== plan || event.status !== "completed") return
        const content = event.result.content
        // The tool runtime normalizes string results into text parts before
        // this hook fires, so accept both shapes.
        const text =
          typeof content === "string" ? content : content?.map((part) => (part.type === "text" ? part.text : "")).join("")
        if (!text?.startsWith("Plan approved")) return
        const info = yield* ctx.session.get({ sessionID: event.sessionID })
        if (info.metadata?.["planImpl"] !== undefined) return
        yield* startImplementation(event.sessionID)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to start implementation after plan approval", {
            sessionID: event.sessionID,
            cause,
          }),
        ),
      ),
    )
  }),
}
