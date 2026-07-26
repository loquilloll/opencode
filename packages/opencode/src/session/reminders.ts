import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigFork } from "@/config/fork"
import { InstanceState } from "@/effect/instance-state"
import { PartID } from "./schema"
import { Session } from "./session"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const { path: plan } = yield* Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const fork = yield* ConfigFork.Service
  const cfg = yield* fork.get()
  const { path: plan, iteration } = yield* Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  const dirRel = path.relative(ctx.worktree, path.dirname(plan)) || path.dirname(plan)
  const planRel = path.relative(ctx.worktree, plan) || plan
  const convention = describeNameTemplate(cfg.plan?.name ?? "${iteration}-${slug}.md")
  const folderNote = `Plan folder: ${dirRel} — you may create, read, and edit any file in this folder, not only the active plan. Naming convention for new plans: ${convention}; subplans nest the iteration as <parent-iteration>.NN (e.g. 00.01-${input.session.slug}.md).`
  const planInfo = exists
    ? `Active plan: ${planRel}. ${folderNote}`
    : `No plan file exists yet. Create your plan in ${dirRel} using the write tool, following the convention ${convention} — use iteration ${iteration} (e.g. ${path.basename(plan)}). ${folderNote} After writing it, call plan_create with the filename you used (via the \`name\` parameter) so the session points at it.`

  const prompt = cfg.plan?.prompt ?? PLAN_MODE
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: prompt.replace("${planInfo}", () => planInfo),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

function describeNameTemplate(template: string) {
  return template
    .replaceAll("${iteration}", "<iteration>")
    .replaceAll("${slug}", "<slug>")
    .replaceAll("${sessionId}", "<sessionId>")
}

export * as SessionReminders from "./reminders"
