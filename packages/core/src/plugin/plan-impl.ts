export * as PlanImplPlugin from "./plan-impl.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import type { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { Permission } from "../permission.js"

type PlanImplStatus = "implementing" | "paused" | "reviewing" | "completed"

type PlanImplState = {
  status: PlanImplStatus
  title: string
  planPath: string
  startedAt: number
  activeStartedAt: number | null
  timeUsedSeconds: number
  reviewIteration: number
}

const IMPL_PROMPT = `Continue implementing the plan at {planPath}.
Read the plan file, identify the next unfinished item, and implement it.
If every item in the plan is done, call the plan_complete tool to trigger code review.
Do not call plan_complete until you have verified the implementation against the plan's verification section.`

const REVIEW_PROMPT = `The plan at {planPath} has been implemented. Now run a code review:
1. Generate a comprehensive prompt for the @code-reviewer subagent covering the entire chat-to-agent change set. Reference the plan file so the reviewer can check completeness.
2. Spawn the @code-reviewer subagent with that prompt. Note the task_id returned — you will reuse it for every subsequent re-review to preserve the reviewer's context.
3. Read the review findings. Remediate all HIGH and MEDIUM severity items in the code.
4. Resume the SAME @code-reviewer task (using its task_id) to re-review the remediated changes. Do not spawn a new code-reviewer.
5. If the re-review returns more items, remediate and resume the reviewer again. The code-reviewer session determines when the plan is done — when it reports no remaining HIGH or MEDIUM items, the review is complete.
Report the final status to the user. Do not call plan_complete again.`

const CompleteInput = Schema.Struct({})

const CompleteOutput = Schema.Struct({
  status: Schema.String,
})

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function account(state: PlanImplState, now = Date.now()): PlanImplState {
  if (state.activeStartedAt === null) return state
  if (state.status !== "implementing" && state.status !== "reviewing") return state
  const elapsed = Math.max(0, Math.floor((now - state.activeStartedAt) / 1000))
  return { ...state, activeStartedAt: now, timeUsedSeconds: state.timeUsedSeconds + elapsed }
}

// Drives the post-plan_exit lifecycle: implementing → (plan_complete) → reviewing → completed.
// State lives in session.metadata.planImpl so the TUI sidebar and child sessions see it.
// The idle hook continues the loop: input it admits runs in the same execution
// instead of the Session going idle, so each continuation re-triggers it.
export const Plugin = {
  id: "opencode.plan-impl",
  effect: Effect.fn("PlanImplPlugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service

    // REVIEW_PROMPT is sent exactly once per review cycle. After that the agent
    // runs the review loop autonomously — it does not need re-prompting.
    const reviewStarted = new Set<string>()

    const readState = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const info = yield* ctx.session.get({ sessionID })
        const raw = info.metadata?.["planImpl"]
        if (raw !== null && typeof raw === "object" && "status" in raw) return raw as PlanImplState
        return undefined
      })

    const writeState = (sessionID: Session.ID, next: PlanImplState) =>
      Effect.gen(function* () {
        const info = yield* ctx.session.get({ sessionID })
        yield* ctx.session.update({
          sessionID,
          metadata: { ...info.metadata, planImpl: next },
        })
      })

    const resume = (sessionID: Session.ID, state: PlanImplState) =>
      Effect.gen(function* () {
        if (state.status === "reviewing" && reviewStarted.has(sessionID)) return
        yield* writeState(sessionID, account(state))
        const template = state.status === "reviewing" ? REVIEW_PROMPT : IMPL_PROMPT
        if (state.status === "reviewing") reviewStarted.add(sessionID)
        yield* ctx.session.synthetic({ sessionID, text: template.replaceAll("{planPath}", state.planPath) })
      })

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "plan_complete",
        options: { codemode: false },
        description:
          "Signal that the plan implementation is complete and trigger the code review phase. Only call this after verifying the implementation against the plan's verification section.",
        input: CompleteInput,
        output: CompleteOutput,
        execute: (_input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: "plan_complete",
              resources: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            const state = yield* readState(context.sessionID)
            if (!state) {
              return {
                output: { status: "none" },
                content: "No active plan implementation found.",
                metadata: {},
              }
            }
            if (state.status === "reviewing") {
              return { output: { status: "reviewing" }, content: "Code review is already in progress.", metadata: {} }
            }
            if (state.status === "completed") {
              return { output: { status: "completed" }, content: "Plan implementation is already completed.", metadata: {} }
            }
            yield* writeState(context.sessionID, { ...account(state), status: "reviewing", reviewIteration: 0 })
            reviewStarted.delete(context.sessionID)
            return {
              output: { status: "reviewing" },
              content:
                "Plan implementation marked complete. A code review will begin next using the @code-reviewer subagent. Continue working — the reviewer will check your changes against the plan.",
              metadata: {},
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: "plan_complete failed", error }),
            ),
          ),
      }),
    )

    yield* ctx.command.transform((editor) =>
      editor.add({
        name: "plan_impl",
        description: "Control plan implementation: pause, resume, stop, or show status",
        execute: ({ sessionID, prompt }) =>
          Effect.gen(function* () {
            const state = yield* readState(sessionID)
            if (!state) return
            const arg = prompt.text.trim().toLowerCase()

            if (arg === "pause") {
              const accounted = account(state)
              yield* writeState(sessionID, { ...accounted, status: "paused", activeStartedAt: null })
              yield* ctx.session.synthetic({
                sessionID,
                text: `Plan implementation paused (${formatElapsed(accounted.timeUsedSeconds)} elapsed).`,
                resume: false,
              })
              return
            }

            if (arg === "resume") {
              yield* writeState(sessionID, { ...account(state), status: "implementing", activeStartedAt: Date.now() })
              yield* ctx.session.synthetic({
                sessionID,
                text: "Plan implementation resumed.",
                resume: false,
              })
              return
            }

            if (arg === "stop") {
              const accounted = account(state)
              yield* writeState(sessionID, { ...accounted, status: "completed", activeStartedAt: null })
              yield* ctx.session.synthetic({
                sessionID,
                text: `Plan implementation stopped (${formatElapsed(accounted.timeUsedSeconds)} elapsed). Auto-resume disabled. State preserved — use /plan_impl resume to continue later.`,
                resume: false,
              })
              return
            }

            const accounted = account(state)
            const live =
              accounted.activeStartedAt !== null && (accounted.status === "implementing" || accounted.status === "reviewing")
                ? accounted.timeUsedSeconds + Math.floor((Date.now() - accounted.activeStartedAt) / 1000)
                : accounted.timeUsedSeconds
            yield* ctx.session.synthetic({
              sessionID,
              text: `Plan: ${state.title}\nStatus: ${state.status}\nTime: ${formatElapsed(live)}\nPath: ${state.planPath}`,
              resume: false,
            })
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("plan_impl command failed", { sessionID, cause }))),
      }),
    )

    yield* ctx.session.hook("experimental.idle", (event) =>
      Effect.gen(function* () {
        const state = yield* readState(event.sessionID)
        if (state?.status !== "implementing" && state?.status !== "reviewing") return
        yield* resume(event.sessionID, state)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("plan implementation continuation failed", { sessionID: event.sessionID, cause }),
        ),
      ),
    )

    // Until the next continuation restates the plan, a compacted history may not show it.
    yield* ctx.session.hook("compaction", (event) =>
      Effect.gen(function* () {
        const state = yield* readState(event.sessionID)
        if (!state) return
        event.system.push({
          type: "text",
          text: `Plan implementation in progress: "${state.title}" at ${state.planPath}. Status: ${state.status}. ${state.timeUsedSeconds}s elapsed.`,
        })
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to inject compaction context", { cause }))),
    )
  }),
}
