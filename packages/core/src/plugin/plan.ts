export * as PlanPlugin from "./plan.js"

import { Message, ToolFailure } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import path from "path"
import { Permission } from "../permission.js"
import { ConfigFork } from "../config/fork.js"
import { PlanPath } from "../session/plan-path.js"
import { SessionPlan } from "../session/plan.js"
import PLAN_MODE from "./plan/plan-mode.txt"

const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")

const PLAN_PREFIX = "<system-reminder>\nPlan mode is active"

const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`

// Fork agent-driven plan mode: the plan agent authors plan files itself (no
// system pre-seed) in a configurable plan folder with a naming convention,
// registers the active plan via plan_create, and exits via plan_exit which
// switches to the build agent and starts the plan_complete lifecycle.
export const Plugin = define({
  id: "opencode.plan",
  effect: Effect.fn(function* (ctx) {
    const fork = yield* ConfigFork.loadForLocation(ctx.location)
    const directory = PlanPath.resolveDir(fork.plan?.path, ctx.location)
    const convention = SessionPlan.describeNameTemplate(fork.plan?.name ?? "${iteration}-${slug}.md")
    const prompt = fork.plan?.prompt ?? PLAN_MODE
    const dirRel = path.relative(ctx.location.directory, directory)
    const outsideWorktree = dirRel.startsWith("..")

    const enter = Effect.fn("PlanPlugin.enter")(function* (sessionID: Session.ID) {
      const info = yield* ctx.session.get({ sessionID })
      const resolved = yield* SessionPlan.plan(
        { id: info.id, title: info.title, metadata: info.metadata },
        ctx.location,
        fork,
      )
      const exists = yield* SessionPlan.fileExists(resolved.path)
      const planRel = path.relative(ctx.location.directory, resolved.path)
      const folderNote = `Plan folder: ${dirRel} — you may create, read, and edit any file in this folder, not only the active plan. Naming convention for new plans: ${convention}; subplans nest the iteration as <parent-iteration>.NN (e.g. 00.01-<slug>.md).`
      const planInfo = exists
        ? `Active plan: ${planRel}. ${folderNote}`
        : `No plan file exists yet. Create your plan in ${dirRel} using the write tool, following the convention ${convention} — use iteration ${resolved.iteration} (e.g. ${path.basename(resolved.path)}). ${folderNote} After writing it, call plan_create with the filename you used (via the \`name\` parameter) so the session points at it.`
      return prompt.replace("${planInfo}", () => planInfo)
    })

    yield* ctx.agent.transform((editor) => {
      editor.update(plan, (item) => {
        item.name = Agent.Name.make("Plan")
        item.description = "Explores the codebase and authors plan files before implementation."
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
        item.permissions.push({ action: "plan_create", resource: "*", effect: "allow" })
        item.permissions.push({ action: "plan_exit", resource: "*", effect: "allow" })
        item.permissions.push({ action: "plan_complete", resource: "*", effect: "allow" })
        item.permissions.push({ action: "edit", resource: "*", effect: "deny" })
        item.permissions.push({ action: "edit", resource: path.join(directory, "*"), effect: "allow" })
        if (outsideWorktree) item.permissions.push({ action: "external_directory", resource: "*", effect: "allow" })
      })
      editor.update(build, (item) => {
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
        item.permissions.push({ action: "plan_complete", resource: "*", effect: "allow" })
      })
      for (const id of ["general", "explore", "compaction", "title", "summary"]) {
        editor.update(Agent.ID.make(id), (item) => {
          item.permissions.push({ action: "plan_create", resource: "*", effect: "deny" })
          item.permissions.push({ action: "plan_exit", resource: "*", effect: "deny" })
          item.permissions.push({ action: "plan_complete", resource: "*", effect: "deny" })
        })
      }
      // Fork-only agent overrides from opencode-fork.jsonc (vanilla opencode never reads them).
      for (const [id, override] of Object.entries(fork.agent ?? {})) {
        if (override.disabled) {
          editor.remove(Agent.ID.make(id))
          continue
        }
        editor.update(Agent.ID.make(id), (item) => {
          if (override.system !== undefined) item.system = override.system
          if (override.description !== undefined) item.description = override.description
          if (override.mode !== undefined) item.mode = override.mode
          if (override.hidden !== undefined) item.hidden = override.hidden
          if (override.color !== undefined) item.color = override.color
          if (override.steps !== undefined) item.steps = override.steps
          if (override.model !== undefined)
            item.model = { id: override.model.model, providerID: override.model.providerID, variant: override.model.variant }
          if (override.permissions !== undefined) item.permissions.push(...override.permissions)
        })
      }
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.status !== "error") return Effect.void
      if (event.tool !== "edit" && event.tool !== "write" && event.tool !== "patch") return Effect.void
      if (!(event.error.error instanceof Permission.BlockedError)) return Effect.void
      event.error = new ToolFailure({
        message: `Cannot use ${event.tool} to modify files outside the Plan directory: ${directory}`,
      })
      return Effect.void
    })

    // Compaction and committed reverts can strip reminders while the session's agent stays
    // put. Reconcile per request, appending near the tail so the cached prefix stays warm.
    // The enter reminder is dynamic (it reflects the active plan), so any stale copy is
    // replaced, not just missing ones.
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const reminder = lastPlanReminder(event.messages)
        if (event.agent === plan) {
          const text = yield* enter(event.sessionID)
          if (reminder !== undefined && reminder !== "leave" && reminder === text) return
          splice(event.messages, text)
          yield* persist(event.sessionID, text)
          return
        }
        if (reminder !== undefined && reminder !== "leave") {
          splice(event.messages, leave)
          yield* persist(event.sessionID, leave)
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to reconcile Plan mode reminder", { sessionID: event.sessionID, cause }),
        ),
      ),
    )

    yield* ctx.event.subscribe({ types: ["session.created", "session.agent.selected"] }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "session.created") {
            if (event.data.agent === plan) yield* persist(event.data.sessionID, yield* enter(event.data.sessionID))
            return
          }
          if (event.type !== "session.agent.selected") return
          if (event.data.agent === event.data.previous) return
          if (event.data.agent === plan) {
            yield* persist(event.data.sessionID, yield* enter(event.data.sessionID))
            return
          }
          if (event.data.previous === plan) yield* persist(event.data.sessionID, leave)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to inject Plan mode reminder", { sessionID: event.data.sessionID, cause }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    function splice(messages: Array<Message>, text: string) {
      // Before the user's prompt, matching where agent-switch reminders land.
      const at = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length
      messages.splice(at, 0, Message.user(text))
    }

    function persist(sessionID: Session.ID, text: string) {
      return ctx.session.synthetic({ sessionID, text, resume: false }).pipe(Effect.asVoid)
    }
  }),
})

function reminderText(message: Message): string | undefined {
  if (message.role !== "user" || message.content.length !== 1) return undefined
  const part = message.content[0]
  return part?.type === "text" ? part.text : undefined
}

// Returns the text of the last plan-enter reminder in the transcript, "leave"
// when the last plan reminder was a leave, or undefined when there is none.
function lastPlanReminder(messages: ReadonlyArray<Message>): string | "leave" | undefined {
  return messages.reduce<string | "leave" | undefined>((found, message) => {
    const text = reminderText(message)
    if (text === undefined) return found
    if (text.startsWith(PLAN_PREFIX)) return text
    if (text === leave) return "leave"
    return found
  }, undefined)
}
