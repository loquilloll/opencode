import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigFork } from "@/config/fork"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import CREATE_DESCRIPTION from "./plan-create.txt"

export const ExitParameters = Schema.Struct({})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const fork = yield* ConfigFork.Service
    const fsys = yield* FSUtil.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: ExitParameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const { path: planAbs } = yield* Session.plan(info, instance).pipe(
            Effect.provideService(ConfigFork.Service, fork),
            Effect.provideService(FSUtil.Service, fsys),
          )
          const plan = path.relative(instance.worktree, planAbs)
          const exists = yield* fsys.existsSafe(planAbs)
          if (!exists) {
            return {
              title: "No plan file found",
              output: `No plan file exists at ${plan} (or the active-plan pointer). Write the plan first, then call plan_exit again.`,
              metadata: {},
            }
          }
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "No") yield* new Question.RejectedError()

          const now = Date.now()
          yield* session.setMetadata({
            sessionID: ctx.sessionID,
            metadata: {
              ...info.metadata,
              planImpl: {
                status: "implementing",
                title: info.title || plan,
                planPath: planAbs,
                startedAt: now,
                activeStartedAt: now,
                timeUsedSeconds: 0,
                reviewIteration: 0,
              },
            },
          })

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved. You are now in implementation mode — execute the plan. When implementation is complete and verified, call the plan_complete tool to trigger code review.`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const CreateParameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description:
      "Filename for the plan (e.g. `01-feature-x.md` for a new top-level plan, or `00.01-detail.md` for a subplan of `00`). Must be a safe markdown basename following the naming convention. If omitted, the next top-level iteration is generated. The agent decides new-vs-subplan by the filename: a dotted iteration makes it a subplan.",
  }),
})

export const PlanCreateTool = Tool.define(
  "plan_create",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const fork = yield* ConfigFork.Service
    const fsys = yield* FSUtil.Service

    return {
      description: CREATE_DESCRIPTION,
      parameters: CreateParameters,
      execute: (params: Schema.Schema.Type<typeof CreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)

          // The agent decides whether this is a new plan or a subplan by the
          // filename it passes: a dotted iteration (e.g. 00.01-x.md) is a subplan;
          // a plain name (e.g. 01-x.md) or an omitted name is a new top-level plan.
          // This tool never writes the file — the agent authors it with write/edit.
          const { path: planAbs, iteration, parent: parentAbs } = yield* Session.plan(
            info,
            instance,
            params.name ? { name: params.name } : { forceNew: true },
          ).pipe(
            Effect.provideService(ConfigFork.Service, fork),
            Effect.provideService(FSUtil.Service, fsys),
          )

          yield* session.setMetadata({
            sessionID: ctx.sessionID,
            metadata: { ...info.metadata, activePlanPath: planAbs },
          })

          const planRel = path.relative(instance.worktree, planAbs)
          const parentRel = parentAbs ? path.relative(instance.worktree, parentAbs) : undefined
          return {
            title: `Registered plan ${iteration}`,
            output: parentRel
              ? `Active plan is now ${planRel} (subplan ${iteration} of ${parentRel}). Write the plan content to ${planRel} with the write tool and record \`parent: ${parentRel}\` in its frontmatter.`
              : `Active plan is now ${planRel}. Write the plan content to ${planRel} with the write tool.`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
