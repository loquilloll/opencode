import { describe, expect } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { DateTime, Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Agent } from "@opencode/core/agent"
import { Environment } from "@opencode/core/environment/index"
import { Form } from "@opencode/core/form"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { PlanTool } from "@opencode/core/tool/plugin/plan"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Global } from "@opencode/util/global"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_plan_tool_test")
const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")
const home = "/home/plan-tool-test"

const die = () => Effect.die("unused")

/**
 * Activates the PlanTool plugin against stubbed domains with an in-memory session,
 * capturing the registered execute.after hook and every session mutation.
 * `location` overrides the plugin location (fork config is read per location);
 * `initial` seeds session metadata (e.g. a prior planImpl state).
 */
const run = Effect.fnUntraced(function* (location?: Location.Info, initial?: Record<string, unknown>) {
  const metadata: Record<string, unknown> = { ...initial }
  const updates: Array<Record<string, unknown>> = []
  const switches: Array<Agent.ID> = []
  const synthetics: Array<string> = []
  let toolHook: ((input: ToolHooks["execute.after"]) => Effect.Effect<void>) | undefined
  const session = {
    get: () => Effect.succeed({ id: sessionID, title: "Plan tool test", metadata: { ...metadata } }),
    update: (input: { sessionID: Session.ID; metadata?: Record<string, unknown> }) => {
      Object.assign(metadata, input.metadata)
      updates.push(input.metadata ?? {})
      return Effect.void
    },
    switchAgent: (input: { sessionID: Session.ID; agent: Agent.ID }) => {
      switches.push(input.agent)
      return Effect.void
    },
    synthetic: (input: { sessionID: Session.ID; text: string }) => {
      synthetics.push(input.text)
      return Effect.succeed(
        SessionInbox.Synthetic.make({
          id: SessionMessage.ID.make("msg_plan_tool"),
          sessionID,
          time: { created: DateTime.makeUnsafe(0) },
          type: "synthetic",
          payload: { text: input.text },
          delivery: "steer",
        }),
      )
    },
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  } as unknown as Plugin.Context["session"]
  const driver = Environment.makeMemoryDriver()
  yield* PlanTool.Plugin.effect(
    host({
      ...(location ? { location } : {}),
      session,
      tool: {
        transform: (callback) => {
          callback({
            add: () => {},
            list: () => [],
            get: () => undefined,
            namespace: () => undefined,
            update: () => {},
            remove: () => {},
          })
          return Effect.succeed({ dispose: Effect.void })
        },
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: (name, callback) => {
          if (name === "execute.after") {
            // Hook names and callbacks are correlated, but TypeScript does not narrow this generic registration API.
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            toolHook = callback as unknown as (input: ToolHooks["execute.after"]) => Effect.Effect<void>
          }
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    }),
  ).pipe(
    Effect.provideService(
      Form.Service,
      Form.Service.of({ close: Effect.void, create: die, ask: die, get: die, list: die, state: die, reply: die, cancel: die }),
    ),
    Effect.provideService(
      Permission.Service,
      Permission.Service.of({
        close: Effect.void,
        ask: die,
        assert: die,
        assertNotDenied: die,
        allows: die,
        reply: die,
        get: die,
        forSession: die,
        list: die,
      }),
    ),
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })),
    Effect.provideService(
      Environment.Service,
      Environment.Service.of({ files: Environment.makeFiles(driver), spawner: driver.spawner }),
    ),
  )
  if (!toolHook) return yield* Effect.die("plan tool plugin did not register a tool hook")
  return { toolHook, updates, switches, synthetics }
})

type CompletedEvent = Extract<ToolHooks["execute.after"], { readonly status: "completed" }>

// The tool runtime normalizes string results into text parts before
// execute.after fires; production events always carry the array form.
const submitResult = (content: string, agent: Agent.ID = plan): CompletedEvent => ({
  tool: "submit_plan",
  input: {},
  sessionID,
  agent,
  messageID: SessionMessage.ID.make("msg_plan_tool"),
  id: Tool.CallID.make("call_plan_tool"),
  status: "completed",
  result: { content: [{ type: "text", text: content }] },
})

const APPROVED = "Plan approved! Saved to: /tmp/plan.md"
const DENIED = "YOUR PLAN WAS NOT APPROVED.\n\nAddress the feedback below before calling submit_plan again."

describe("plan tool submit_plan approval hook", () => {
  it.effect("starts the plan_exit tail on an approved submit_plan result", () =>
    Effect.gen(function* () {
      const { toolHook, updates, switches, synthetics } = yield* run()
      yield* toolHook(submitResult(APPROVED))
      expect(switches).toEqual([build])
      expect(updates).toHaveLength(1)
      const planImpl = updates[0]?.["planImpl"] as { status: string; planPath: string }
      expect(planImpl.status).toBe("implementing")
      expect(planImpl.planPath).toContain("00-")
      expect(synthetics).toHaveLength(1)
      expect(synthetics[0]).toContain("has been approved")
      expect(synthetics[0]).toContain("plan_complete")
    }),
  )

  it.effect("ignores denied submit_plan results", () =>
    Effect.gen(function* () {
      const { toolHook, updates, switches, synthetics } = yield* run()
      yield* toolHook(submitResult(DENIED))
      expect(updates).toHaveLength(0)
      expect(switches).toHaveLength(0)
      expect(synthetics).toHaveLength(0)
    }),
  )

  it.effect("ignores submit_plan from other agents", () =>
    Effect.gen(function* () {
      const { toolHook, updates, switches, synthetics } = yield* run()
      yield* toolHook(submitResult(APPROVED, build))
      expect(updates).toHaveLength(0)
      expect(switches).toHaveLength(0)
      expect(synthetics).toHaveLength(0)
    }),
  )

  it.effect("starts implementation only once", () =>
    Effect.gen(function* () {
      const { toolHook, updates, switches } = yield* run()
      yield* toolHook(submitResult(APPROVED))
      yield* toolHook(submitResult(APPROVED))
      expect(switches).toEqual([build])
      expect(updates).toHaveLength(1)
    }),
  )

  it.effect("switches to the fork-configured plan agent when set", () =>
    Effect.gen(function* () {
      // Project-local fork config through the real loadForLocation path.
      const dir = path.join(os.tmpdir(), `plan-agent-test-${Date.now()}`)
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".opencode"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(dir, ".opencode", "opencode-fork.json"), JSON.stringify({ plan: { agent: "impl-custom" } })),
      )
      const { toolHook, switches } = yield* run(
        new Location.Info({
          directory: AbsolutePath.make(dir),
          project: {
            id: Project.ID.global,
            directory: AbsolutePath.make(dir),
            canonical: AbsolutePath.make(dir),
          },
        }),
      )
      yield* toolHook(submitResult(APPROVED))
      expect(switches).toEqual([Agent.ID.make("impl-custom")])
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

  it.effect("restarts a paused implementation on re-approval", () =>
    Effect.gen(function* () {
      const { toolHook, updates, switches } = yield* run(undefined, {
        planImpl: { status: "paused", title: "old", planPath: "/old.md", startedAt: 1, activeStartedAt: null, timeUsedSeconds: 30, reviewIteration: 0 },
      })
      yield* toolHook(submitResult(APPROVED))
      expect(switches).toEqual([build])
      expect(updates).toHaveLength(1)
      expect((updates[0]?.["planImpl"] as { status: string }).status).toBe("implementing")
    }),
  )

  it.effect("does not restart an in-flight implementation", () =>
    Effect.gen(function* () {
      const { toolHook, updates, switches } = yield* run(undefined, {
        planImpl: { status: "implementing", title: "old", planPath: "/old.md", startedAt: 1, activeStartedAt: 1, timeUsedSeconds: 0, reviewIteration: 0 },
      })
      yield* toolHook(submitResult(APPROVED))
      expect(updates).toHaveLength(0)
      expect(switches).toHaveLength(0)
    }),
  )
})
