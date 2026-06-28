import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ConfigFork } from "@/config/fork"
import { InstanceState } from "@/effect/instance-state"
import { PartID } from "./schema"
import { Session } from "./session"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PLAN_TEMPLATE from "./prompt/plan-template.txt"

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
  let seeded = false
  if (!exists) {
    const template = yield* loadPlanTemplate(cfg, ctx.worktree)
    seeded = yield* fsys.ensureDir(path.dirname(plan)).pipe(
      Effect.andThen(fsys.writeFileString(plan, renderPlanTemplate(template, { ...input.session, iteration }))),
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("failed to seed plan file", { path: plan, error: String(error) }).pipe(Effect.as(false)),
      ),
    )
  }
  const prompt = cfg.plan?.prompt ?? PLAN_MODE
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: prompt.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You are in plan mode. Read the plan, then update it in place or call plan_create for a new plan or subplan based on the user's request.`
        : seeded
          ? `A plan has been started at ${plan}. You are in plan mode. Fill it in using the edit tool.`
          : `No plan file exists yet. You are in plan mode. Create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export const loadPlanTemplate = Effect.fnUntraced(function* (cfg: ConfigFork.Info, worktree: string) {
  const fsys = yield* FSUtil.Service
  const configured = cfg.plan?.template
  if (!configured) return PLAN_TEMPLATE
  const expanded = configured.startsWith("~/")
    ? path.join(Global.Path.home, configured.slice(2))
    : path.isAbsolute(configured)
      ? configured
      : path.join(worktree, configured)
  if (!FSUtil.contains(worktree, expanded) && !FSUtil.contains(Global.Path.config, expanded)) {
    yield* Effect.logWarning("plan template path is outside the worktree and global config, using default", { path: expanded })
    return PLAN_TEMPLATE
  }
  const text = yield* fsys.readFileStringSafe(expanded).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!text) {
    yield* Effect.logWarning("plan template not found, using default", { path: expanded })
    return PLAN_TEMPLATE
  }
  return text
})

export function renderPlanTemplate(
  source: string,
  vars: {
    slug: string
    title: string
    id: string
    iteration: string
    time: { created: number }
    parent?: string
  },
) {
  return source
    .replaceAll("${timestamp}", new Date(vars.time.created).toISOString())
    .replaceAll("${iteration}", vars.iteration)
    .replaceAll("${slug}", vars.slug)
    .replaceAll("${sessionId}", vars.id)
    .replaceAll("${title}", vars.title || vars.slug)
    .replaceAll("${parent}", vars.parent ?? "")
}

export * as SessionReminders from "./reminders"
