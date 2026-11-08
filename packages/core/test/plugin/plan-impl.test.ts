import { describe, expect } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { PlanImplPlugin } from "@opencode/core/plugin/plan-impl"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { Event } from "@opencode/schema/event"
import { Session } from "@opencode/schema/session"
import { Global } from "@opencode/util/global"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_plan_impl_test")
const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")
const home = "/home/plan-impl-test"

const implementing = {
  status: "implementing",
  title: "Test plan",
  planPath: "/workspace/.opencode/plans/00-test.md",
  startedAt: 1_000,
  activeStartedAt: 1_000,
  timeUsedSeconds: 0,
  reviewIteration: 0,
}

const agentSelected = (agent: Agent.ID, previous: Agent.ID): SessionEvent.AgentSelected => ({
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type: "session.agent.selected",
  data: { sessionID, agent, previous },
})

/**
 * Activates the PlanImpl plugin against stubbed domains with an in-memory session,
 * then plays the given agent-switch events through the event subscription.
 */
const run = Effect.fnUntraced(function* (
  events: ReadonlyArray<SessionEvent.AgentSelected>,
  metadata: Record<string, unknown> = {},
  expectedSynthetics = 1,
) {
  const updates: Array<Record<string, unknown>> = []
  const synthetics: Array<string> = []
  const session = {
    hook: () => Effect.succeed({ dispose: Effect.void }),
    get: () => Effect.succeed({ id: sessionID, title: "Plan impl test", metadata: { ...metadata } }),
    update: (input: { sessionID: Session.ID; metadata?: Record<string, unknown> }) => {
      Object.assign(metadata, input.metadata)
      updates.push(input.metadata ?? {})
      return Effect.void
    },
    synthetic: (input: { sessionID: Session.ID; text: string }) => {
      synthetics.push(input.text)
      return Effect.succeed(
        SessionInbox.Synthetic.make({
          id: SessionMessage.ID.make("msg_plan_impl"),
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
  const editor = {
    add: () => {},
    list: () => [],
    get: () => undefined,
    namespace: () => undefined,
    update: () => {},
    remove: () => {},
  }
  yield* PlanImplPlugin.Plugin.effect(
    host({
      session,
      tool: {
        transform: (callback) => {
          callback(editor)
          return Effect.succeed({ dispose: Effect.void })
        },
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
      command: {
        transform: (callback) => {
          callback({ ...editor, add: () => {} })
          return Effect.succeed({ dispose: Effect.void })
        },
        reload: () => Effect.die("unused command.reload"),
        list: () => Effect.die("unused command.list"),
      },
      event: { subscribe: () => Stream.fromIterable(events) },
    }),
  ).pipe(
    Effect.provideService(
      Permission.Service,
      Permission.Service.of({
        close: Effect.void,
        ask: () => Effect.die("unused ask"),
        assert: () => Effect.die("unused assert"),
        assertNotDenied: () => Effect.die("unused assertNotDenied"),
        allows: () => Effect.die("unused allows"),
        reply: () => Effect.die("unused reply"),
        get: () => Effect.die("unused get"),
        forSession: () => Effect.die("unused forSession"),
        list: () => Effect.die("unused list"),
      }),
    ),
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })),
  )
  const settle = (expected: number, remaining = 500): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      // Give the forked event subscription a beat; for expected=0 (nothing
      // should happen) this brief wait is the whole check.
      yield* Effect.promise(() => Bun.sleep(20))
      if (expected === 0 || synthetics.length >= expected) return
      if (remaining === 0) return yield* Effect.fail(new Error(`Timed out waiting for ${expected} synthetics, saw ${synthetics.length}`))
      yield* settle(expected, remaining - 1)
    })
  yield* settle(expectedSynthetics)
  return { updates, synthetics, metadata }})

describe("plan-impl pause on plan-mode switch", () => {
  it.effect("pauses an in-flight implementation when switching back to plan", () =>
    Effect.gen(function* () {
      const { updates, synthetics } = yield* run([agentSelected(plan, build)], { planImpl: implementing })
      expect(updates).toHaveLength(1)
      const state = updates[0]?.["planImpl"] as { status: string; activeStartedAt: number | null }
      expect(state.status).toBe("paused")
      expect(state.activeStartedAt).toBeNull()
      expect(synthetics[0]).toContain("paused")
      expect(synthetics[0]).toContain("plan mode")
    }),
  )

  it.effect("leaves a paused implementation alone", () =>
    Effect.gen(function* () {
      const { updates, synthetics } = yield* run(
        [agentSelected(plan, build)],
        { planImpl: { ...implementing, status: "paused", activeStartedAt: null } },
        0,
      )
      expect(updates).toHaveLength(0)
      expect(synthetics).toHaveLength(0)
    }),
  )

  it.effect("ignores switches that do not enter plan mode", () =>
    Effect.gen(function* () {
      const { updates, synthetics } = yield* run([agentSelected(build, plan)], { planImpl: implementing }, 0)
      expect(updates).toHaveLength(0)
      expect(synthetics).toHaveLength(0)
    }),
  )
})
