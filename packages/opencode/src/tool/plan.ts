import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { SessionReminders } from "@/session/reminders"
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
  parent: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, the new plan is recorded as a subplan of the current active plan. When false or omitted, the new plan is independent.",
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
          const cfg = yield* fork.get()

          const parentRel = params.parent
            ? yield* Effect.gen(function* () {
                const current = yield* Session.plan(info, instance).pipe(
                  Effect.provideService(ConfigFork.Service, fork),
                  Effect.provideService(FSUtil.Service, fsys),
                )
                const exists = yield* fsys.existsSafe(current.path)
                return exists ? path.relative(instance.worktree, current.path) : undefined
              })
            : undefined

          const { path: planAbs, iteration } = yield* Session.plan(info, instance, { forceNew: true }).pipe(
            Effect.provideService(ConfigFork.Service, fork),
            Effect.provideService(FSUtil.Service, fsys),
          )

          const template = yield* SessionReminders.loadPlanTemplate(cfg, instance.worktree).pipe(
            Effect.provideService(FSUtil.Service, fsys),
          )
          const rendered = SessionReminders.renderPlanTemplate(template, { ...info, iteration, parent: parentRel })
          yield* fsys.ensureDir(path.dirname(planAbs)).pipe(Effect.andThen(fsys.writeFileString(planAbs, rendered)))

          yield* session.setMetadata({
            sessionID: ctx.sessionID,
            metadata: { ...info.metadata, activePlanPath: planAbs },
          })

          const planRel = path.relative(instance.worktree, planAbs)
          return {
            title: `Created plan ${iteration}`,
            output: parentRel
              ? `Created subplan at ${planRel} (parent: ${parentRel}). It is now the active plan.`
              : `Created plan at ${planRel}. It is now the active plan.`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
