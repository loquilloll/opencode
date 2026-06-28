import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show, createSignal, onCleanup } from "solid-js"

const id = "internal:sidebar-plan-impl"

type PlanImplState = {
  status: string
  title: string
  planPath: string
  startedAt: number
  activeStartedAt: number | null
  timeUsedSeconds: number
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function liveTime(state: PlanImplState, nowMs: number): number {
  const base = Math.max(0, Math.floor(state.timeUsedSeconds))
  if (state.status !== "implementing" && state.status !== "reviewing") return base
  if (state.activeStartedAt === null) return base
  return base + Math.max(0, Math.floor((nowMs - state.activeStartedAt) / 1000))
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [nowMs, setNowMs] = createSignal(Date.now())
  const timer = setInterval(() => setNowMs(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const state = createMemo(() => {
    props.api.state.session.messages(props.session_id)
    const session = props.api.state.session.get(props.session_id)
    const meta = session?.metadata as Record<string, unknown> | undefined
    return meta?.planImpl as PlanImplState | undefined
  })

  const elapsed = createMemo(() => {
    const s = state()
    return s ? liveTime(s, nowMs()) : 0
  })

  const statusIcon = (status: string) => {
    if (status === "implementing") return { icon: "●", color: theme().success ?? theme().text }
    if (status === "reviewing") return { icon: "●", color: theme().warning ?? theme().text }
    if (status === "paused") return { icon: "⏸", color: theme().textMuted }
    return { icon: "✓", color: theme().textMuted }
  }

  const sendCommand = (args: string) => {
    props.api.client.session
      .command({ sessionID: props.session_id, command: "plan_impl", arguments: args } as any)
      .then(() => props.api.ui.toast({ message: `plan_impl ${args}`, variant: "success" }))
      .catch(() => props.api.ui.toast({ message: "command failed", variant: "error" }))
  }

  return (
    <Show when={state()}>
      {(s) => (
        <Show when={s().status !== "completed"}>
          <box>
            <box flexDirection="row" gap={1}>
              <text fg={statusIcon(s().status).color}>{statusIcon(s().status).icon}</text>
              <text fg={theme().text}>
                <b>Plan Impl</b>
              </text>
            </box>
            <text fg={theme().textMuted}>{s().title}</text>
            <box flexDirection="row" gap={1}>
              <text fg={theme().textMuted}>{s().status}</text>
              <text fg={theme().textMuted}>{formatElapsed(elapsed())}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <Show when={s().status === "implementing" || s().status === "reviewing"}>
                <text fg={theme().textMuted} onMouseDown={() => sendCommand("pause")}>[pause]</text>
              </Show>
              <Show when={s().status === "paused"}>
                <text fg={theme().textMuted} onMouseDown={() => sendCommand("resume")}>[resume]</text>
              </Show>
              <text fg={theme().textMuted} onMouseDown={() => sendCommand("stop")}>[stop]</text>
            </box>
          </box>
        </Show>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
