import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"

type PlanImplState = {
  status: string
  title: string
  planPath: string
  timeUsedSeconds: number
  activeStartedAt: number | null
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

export function SidebarPlanImpl(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const [nowMs, setNowMs] = createSignal(Date.now())
  const timer = setInterval(() => setNowMs(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const state = createMemo(() => props.context.data.session.get(props.sessionID)?.metadata?.["planImpl"] as
    | PlanImplState
    | undefined)

  const elapsed = createMemo(() => {
    const current = state()
    return current ? liveTime(current, nowMs()) : 0
  })

  const statusColor = (status: string) => {
    if (status === "implementing") return theme.text.feedback.success.base
    if (status === "reviewing") return theme.text.feedback.warning.base
    return theme.text.muted
  }

  const sendCommand = (arg: string) => {
    void props.context.client.session
      .command({ sessionID: props.sessionID, name: "plan_impl", text: arg })
      .then(() => props.context.ui.toast.show({ message: `plan_impl ${arg}`, variant: "success" }))
      .catch(() => props.context.ui.toast.show({ message: "command failed", variant: "error" }))
  }

  return (
    <Show when={state()}>
      {(current) => (
        <Show when={current().status !== "completed"}>
          <box>
            <box flexDirection="row" gap={1}>
              <text fg={statusColor(current().status)}>●</text>
              <text fg={theme.text.base}>
                <b>Plan Impl</b>
              </text>
            </box>
            <text fg={theme.text.muted}>{current().title}</text>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text.muted}>{current().status}</text>
              <text fg={theme.text.muted}>{formatElapsed(elapsed())}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <Show when={current().status === "implementing" || current().status === "reviewing"}>
                <text fg={theme.text.muted} onMouseDown={() => sendCommand("pause")}>
                  [pause]
                </text>
              </Show>
              <Show when={current().status === "paused"}>
                <text fg={theme.text.muted} onMouseDown={() => sendCommand("resume")}>
                  [resume]
                </text>
              </Show>
              <text fg={theme.text.muted} onMouseDown={() => sendCommand("stop")}>
                [stop]
              </text>
            </box>
          </box>
        </Show>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.plan-impl",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarPlanImpl context={context} sessionID={props.sessionID} />,
    })
  },
})
