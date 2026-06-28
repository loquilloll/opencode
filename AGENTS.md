- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash activity recovery requires a separate explicit design before it may retry provider work.
- Keep delivery vocabulary explicit. Prompts steer by default and coalesce into the active activity at the next safe provider-turn boundary. Explicit `queue` inputs open FIFO future activities one at a time after the active activity settles.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## Tool Development

Adding a new built-in tool requires four changes, not just the definition:

1. **Define** the tool in `packages/opencode/src/tool/<name>.ts` using `Tool.define(id, Effect.gen(...))`. The `execute` function's Effect must have `R = never` (no unprovided services) — yield services in the outer `Effect.gen`, then `Effect.provideService(Service, value)` any service that inner calls (like `Session.plan` which requires `ConfigFork.Service` and `FSUtil.Service`) require.
2. **Register** in `packages/opencode/src/tool/registry.ts`: yield the tool in the `Effect.all` block, add it to the `tool` object, and add it to the `builtin` array (conditionally gated if needed).
3. **Permission** in `packages/opencode/src/agent/agent.ts`: add `tool_name: "deny"` to `defaults` and `tool_name: "allow"` to the specific agent(s) that should use it. The `defaults` object has `"*": "allow"`, so without an explicit deny every agent sees every tool.
4. **TUI display rule** in `packages/opencode/src/cli/cmd/run/tool.ts`: add the tool type to `ToolDefs`, add a `run<Tool>(p)` function, and add an entry to the `TOOL_RULES` object. Without this the TUI falls back to generic formatting.

Export parameter schemas at module scope (`export const Parameters = Schema.Struct({...})`) so `test/tool/parameters.test.ts` can import them for JSON-schema snapshots without running the tool's Effect init.

## Built-in Plugins

Built-in server plugins are registered in `packages/opencode/src/plugin/index.ts`'s `internalPlugins()` function alongside the auth plugins. They use the same `Plugin` type (`(input: PluginInput) => Promise<Hooks>`) as external npm plugins but can import internal modules directly.

Key hooks and their purposes:
- `event` — receives `{ type, properties }`. For session idle detection: `event.type === "session.status"` and `properties.status.type === "idle"`, with `properties.sessionID`.
- `config` — mutates the config object to register slash commands: `cfg.command[name] = { template: "", description: "..." }`.
- `command.execute.before` — handles slash commands. Match `input.command`, parse `input.arguments`, write `output.parts` (cast to `any` since the SDK `Part` type requires server-assigned fields like `id`/`messageID`).
- `tool` — exposes agent-callable tools via the `tool()` helper from `@opencode-ai/plugin`.
- `experimental.session.compacting` — inject context strings into the compaction prompt so plugin state survives context compression.

The `input.client` (opencode SDK client) is used for session operations: `client.session.get({ path: { id } })`, `client.session.update({ path: { id }, body: { metadata } })`, `client.session.promptAsync({ path: { id }, body: { parts: [...] } })`.

Session metadata (`session.metadata`, a freeform `Record<string, any>`) is the lightweight way to store per-session plugin state without a schema migration. `session.setMetadata` replaces the entire metadata object, so use read-modify-write: GET current metadata, spread it, add/update the key, PATCH it back.

## TUI Sidebar Plugins

Built-in TUI sidebar components live in `packages/tui/src/feature-plugins/sidebar/<name>.tsx` and are registered in `builtins.ts`'s `createBuiltinPlugins()` return array.

The slot registration pattern:
```tsx
const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,  // 100=context, 200=mcp, 300=lsp, 400=todo, 500=files
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}
```

Reactive state: call `api.state.session.messages(session_id)` inside a `createMemo` to trigger re-renders when messages change. Read session metadata via `api.state.session.get(session_id)?.metadata`. Use a 1-second `setInterval` + `createSignal` for live timers, cleaned up with `onCleanup`.

Controls: clickable elements use `onMouseDown={() => ...}` handlers. Send commands via `api.client.session.command({ sessionID, command, arguments })`. Show toast feedback via `api.ui.toast({ message, variant })`.

Theme colors: use `api.theme.current.success`, `.warning`, `.text`, `.textMuted`. Do not use raw color names like `.green` or `.yellow` — they don't exist on the theme type.

## Plan Mode Architecture

Plan mode is driven by `packages/opencode/src/session/reminders.ts` (`SessionReminders.apply`), which runs each turn and pushes synthetic text parts into the last user message:

- **Plan agent turn** (current agent is `plan`, previous assistant was not `plan`): resolves the active plan path via `Session.plan()`, seeds the plan file from template if it doesn't exist, and injects `${planInfo}` (the plan-file status line) into the `PLAN_MODE` prompt.
- **Build switch** (current agent is not `plan`, previous assistant was `plan`): injects `BUILD_SWITCH` text with the plan path, telling the build agent to execute the plan.

The active plan is tracked by `session.metadata.activePlanPath` (a persistent pointer). `Session.plan()` consults it first, then falls back to slug/id filename matching, then to iteration bump. The `forceNew` option skips the pointer/match to compute a fresh iteration.

Plan tools (`plan_create`, `plan_exit`, `plan_complete`) are registered unconditionally in `registry.ts` but restricted by agent permissions in `agent.ts` (allowed for plan/build, denied for all others). The `plan_exit` tool starts implementation mode by writing `session.metadata.planImpl`.

The plan-mode workflow prompt lives in `packages/opencode/src/session/prompt/plan-mode.txt` with `${planInfo}` as the only runtime-substituted placeholder. The plan file template is `plan-template.txt` with `${timestamp}`, `${iteration}`, `${slug}`, `${parent}`, `${title}`, `${sessionId}` placeholders.

## Live Testing with psmux

On Windows, use psmux (the tmux-compatible multiplexer) instead of tmux:

```powershell
psmux new-session -d -s octest -c "packages/opencode"
psmux send-keys -t octest 'bun dev' Enter
Start-Sleep 8; psmux capture-pane -p -t octest -S -30
```

- Send literal text with `send-keys -l 'text'` then `send-keys Enter` separately (sending them together can cause the TUI to misinterpret input as a shell command).
- Cycle agents with `send-keys Tab`.
- Navigate dialog options with `send-keys Down` / `send-keys Enter`.
- The `capture-pane -p -S -N` flag captures N lines of scrollback.
- Kill with `psmux kill-session -t octest` when done.

Query session state directly from the SQLite DB for debugging:
```ts
const db = new Database(`${home}/.local/share/opencode/opencode.db`, { readonly: true })
const row = db.query(`SELECT id, agent, metadata FROM session WHERE id = ?`).get(sid)
```
The main project DB is `opencode.db`; the local-scope DB is `opencode-local.db`. Sessions have a `metadata` JSON column.

