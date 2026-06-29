import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

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

type SessionMeta = Record<string, unknown> | undefined

const RESUME_DEBOUNCE_MS = 2000
const STAGNANT_LIMIT = 3

const IMPL_PROMPT = `Continue implementing the plan at {planPath}.
Read the plan file, identify the next unfinished item, and implement it.
If every item in the plan is done, call the plan_complete tool to trigger code review.
Do not call plan_complete until you have verified the implementation against the plan's verification section.`

const REVIEW_PROMPT = `The plan at {planPath} has been implemented. Now run a code review:
1. Generate a comprehensive prompt for the @code-reviewer subagent covering the entire chat-to-agent change set. Reference the plan file so the reviewer can check completeness.
2. Spawn the @code-reviewer subagent with that prompt. Note the task_id returned — you will reuse it for every subsequent re-review.
3. Read the review findings. Remediate all HIGH and MEDIUM severity items.
4. Re-review by resuming the SAME @code-reviewer task using its task_id (pass the task_id to the task tool, do not spawn a new code-reviewer). This preserves the reviewer's context across iterations.
5. Repeat — always resuming the original task_id — until all HIGH and MEDIUM items are resolved.
When the review is clean, report the final status to the user. Do not call plan_complete again — the review IS the completion step.`

const STAGNANT_PROMPT = `You appear to be stuck. Re-read the plan at {planPath}, identify what is blocking progress, and either ask the user a clarifying question or adjust your approach. Do not repeat the same failed action.`

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

export async function PlanImplPlugin(input: PluginInput): Promise<Hooks> {
  const { client } = input

  // In-flight tracking (not persisted)
  const pending = new Set<string>()
  const lastResume = new Map<string, number>()
  const stagnantCount = new Map<string, number>()

  async function readState(sessionID: string): Promise<PlanImplState | undefined> {
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      const meta = (res.data as Record<string, unknown> | undefined)?.metadata as SessionMeta
      const raw = meta?.planImpl
      if (raw && typeof raw === "object" && "status" in raw) return raw as PlanImplState
    } catch {}
    return undefined
  }

  async function writeState(sessionID: string, next: PlanImplState): Promise<void> {
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      const metadata = (((res.data as Record<string, unknown> | undefined)?.metadata) ?? {}) as Record<string, unknown>
      metadata.planImpl = next
      await client.session.update({ path: { id: sessionID } as any, body: { metadata } } as any)
    } catch {}
  }

  async function sendPrompt(sessionID: string, text: string): Promise<void> {
    await client.session.promptAsync({
      path: { id: sessionID } as any,
      body: { parts: [{ type: "text", text }] } as any,
    } as any)
  }

  async function resume(sessionID: string, state: PlanImplState): Promise<void> {
    if (pending.has(sessionID)) return
    const now = Date.now()
    if (now - (lastResume.get(sessionID) ?? 0) < RESUME_DEBOUNCE_MS) return

    const accounted = account(state, now)
    await writeState(sessionID, accounted)

    const stagnant = stagnantCount.get(sessionID) ?? 0
    const isStagnant = stagnant >= STAGNANT_LIMIT
    const isReview = state.status === "reviewing"

    const template = isStagnant ? STAGNANT_PROMPT : isReview ? REVIEW_PROMPT : IMPL_PROMPT
    const text = template.replaceAll("{planPath}", state.planPath)

    pending.add(sessionID)
    lastResume.set(sessionID, now)
    await sendPrompt(sessionID, text)
  }

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command.plan_impl = {
        template: "",
        description: "Control plan implementation: pause, resume, stop, or show status",
      }
    },

    tool: {
      plan_complete: tool({
        description:
          "Signal that the plan implementation is complete and trigger the code review phase. Only call this after verifying the implementation against the plan's verification section.",
        args: {},
        execute: async (_args, context) => {
          const state = await readState(context.sessionID)
          if (!state) return { title: "No active plan", output: "No active plan implementation found.", metadata: {} }
          if (state.status === "reviewing") return { title: "Already reviewing", output: "Code review is already in progress.", metadata: {} }
          if (state.status === "completed") return { title: "Already completed", output: "Plan implementation is already completed.", metadata: {} }

          const accounted = account(state)
          await writeState(context.sessionID, {
            ...accounted,
            status: "reviewing",
            reviewIteration: 0,
          })
          stagnantCount.set(context.sessionID, 0)
          return {
            title: "Implementation complete — starting review",
            output:
              "Plan implementation marked complete. A code review will begin next using the @code-reviewer subagent. Continue working — the reviewer will check your changes against the plan.",
            metadata: {},
          }
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type !== "session.status") return
      const props = event.properties as { sessionID?: string; status?: { type: string } }
      if (!props.sessionID || props.status?.type !== "idle") return

      const sessionID = props.sessionID

      // Clear in-flight marker — the previous turn finished
      const wasPending = pending.delete(sessionID)
      if (wasPending) {
        // The session just finished a continuation turn. If it stopped without
        // visible progress, increment the stagnant counter.
        // (Heuristic: we can't easily diff file changes here, so we count
        // consecutive idle-after-resume cycles as potential stagnation.)
      }

      const state = await readState(sessionID)
      if (!state) return
      if (state.status !== "implementing" && state.status !== "reviewing") return

      await resume(sessionID, state)
    },

    "command.execute.before": async (cmdInput, cmdOutput) => {
      if (cmdInput.command !== "plan_impl") return
      const sessionID = cmdInput.sessionID
      const arg = cmdInput.arguments.trim().toLowerCase()

      const state = await readState(sessionID)

      const text = (t: string) => ({ type: "text", text: t }) as any

      if (!state) {
        cmdOutput.parts = [text("No active plan implementation.")]
        return
      }

      if (arg === "pause") {
        const accounted = account(state)
        await writeState(sessionID, { ...accounted, status: "paused", activeStartedAt: null })
        cmdOutput.parts = [text(`Plan implementation paused (${formatElapsed(accounted.timeUsedSeconds)} elapsed).`)]
        return
      }

      if (arg === "resume") {
        const accounted = account(state)
        await writeState(sessionID, { ...accounted, status: "implementing", activeStartedAt: Date.now() })
        stagnantCount.set(sessionID, 0)
        cmdOutput.parts = [text("Plan implementation resumed.")]
        return
      }

      if (arg === "stop") {
        const accounted = account(state)
        await writeState(sessionID, { ...accounted, status: "completed", activeStartedAt: null })
        cmdOutput.parts = [text(`Plan implementation stopped (${formatElapsed(accounted.timeUsedSeconds)} elapsed). Auto-resume disabled. State preserved — use /plan_impl resume to continue later.`)]
        return
      }

      // Default: show status
      const accounted = account(state)
      const liveElapsed = accounted.activeStartedAt !== null && (accounted.status === "implementing" || accounted.status === "reviewing")
        ? accounted.timeUsedSeconds + Math.floor((Date.now() - accounted.activeStartedAt) / 1000)
        : accounted.timeUsedSeconds
      cmdOutput.parts = [text(`Plan: ${state.title}\nStatus: ${state.status}\nTime: ${formatElapsed(liveElapsed)}\nPath: ${state.planPath}`)]
    },

    "experimental.session.compacting": async (compactInput, compactOutput) => {
      const state = await readState(compactInput.sessionID)
      if (state) {
        compactOutput.context.push(
          `Plan implementation in progress: "${state.title}" at ${state.planPath}. Status: ${state.status}. ${state.timeUsedSeconds}s elapsed.`,
        )
      }
    },
  }
}
