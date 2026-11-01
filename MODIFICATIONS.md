# Modifications

This file tracks fork-specific changes ported onto `release/v2.2.5` (upstream tag `v2.2.5`, `9bbb8ce18c`) so they are easy to audit, carry forward, or revert when syncing with upstream. The fork design mirrors `release/v1.18.5` (opf18): the **plan agent authors plan files itself** (no system pre-seed). v2.2.5 architectural adaptations are noted inline (the old `packages/opencode` monolith is gone — everything ported into `packages/core` with the new plugin/tool/command domains; Effect plugin API instead of the promise-hooks plugin API).

Upstream v2.2.5 ships its own conversational `opencode.plan` plugin (plan agent discusses a plan in chat, plan files optional in `~/.opencode/plan`, no tools). This fork **replaces** that plugin's behavior wholesale with the fork design below, keeping the same plugin id.

## ConfigFork (separate `opencode-fork.jsonc`)

- `packages/core/src/config/fork.ts` so fork-only settings live in `opencode-fork.jsonc` / `opencode-fork.json` (vanilla opencode never reads them). Pure Effect loaders — no service/LayerNode: `loadGlobal()` (global files only) and `loadForLocation(location)` (global + project `.opencode/` walk-up, closest project wins). `jsonc-parser` for parsing, deep-merge for stacking.
- `PlanSchema` = `{ path?, name?, prompt? }` (configurable plan dir, filename template, plan-mode reminder prompt). `SearchSchema` = `{ hidden?, ignore? }`. `AgentSchema` = record of `ConfigAgent.Info` for fork-only agent overrides.
- v1.18.5's per-instance `ConfigFork.Service`/`layer`/`node` wiring is gone: consumers call the loaders directly (plugins are location-scoped; `ctx.location` is fixed per plugin instance).

## Agent-Driven Plan Mode (agent authors plans; no pre-seed)

- `packages/core/src/plugin/plan.ts` reworked from upstream's conversational plan mode to the fork design. Keeps upstream's reminder-reconciliation structure (`ctx.session.hook("context")` splice + `ctx.session.synthetic(..., resume: false)` persistence, `session.created`/`session.agent.selected` switch reminders, `execute.after` BlockedError rewrite) but the enter reminder is **dynamic** — `${planInfo}` reflects the active plan and is recomputed each turn; a stale copy is replaced, not just a missing one.
- `packages/core/src/session/plan.ts` (`SessionPlan`): pure naming helpers + `plan` effect (ported from v1.18.5 `Session.plan`). Options bag `{ forceNew?, name? }`, `metadata.activePlanPath` pointer, dotted hierarchical iterations (`\d+(?:\.\d+)*` → `00`, `00.01`, `00.01.02`), `parent` result for subplans. v2 sessions have no `slug` — the slug is derived from the session title (fallback: id tail).
- `packages/core/src/session/plan-path.ts` (`PlanPath.resolveDir`): shared between `SessionPlan.plan` and the plan agent's edit-permission glob. **Containment hardening kept from v1.18.5:** a configured plan dir must stay inside the location directory or the opencode global data/config roots, else fall back to the default. Simplification vs v1.18.5: no VCS check — the default plan dir is always `<location>/.opencode/plans` (schema `Location.Info` carries no `vcs`).
- `packages/core/src/plugin/plan/plan-mode.txt` is the agent-driven workflow (Managing Plans, dotted subplans, Phase 1–6 incl. mandatory `@plan-review` before `plan_exit`). Overridable via fork `plan.prompt` (with `${planInfo}` placeholder).
- Plan agent permissions: `question`/`plan_create`/`plan_exit`/`plan_complete` allow; `edit` denied except the plan dir glob (plus `external_directory` allow only when the plan dir resolves outside the worktree). Build agent: `question` + `plan_complete` allow. Other built-ins (`general`, `explore`, `compaction`, `title`, `summary`) get all three plan tools denied. Config-defined agents keep default access (v1.18.5 applied the deny to every agent via the default ruleset — not portable without touching the agent assembly; acceptable, noted here).
- Fork agent overrides (`agent` section) applied in the same plugin via `ctx.agent.transform`: `system`/`description`/`mode`/`hidden`/`color`/`steps`/`model`/`permissions` (appended), `disabled` removes the agent.

## Plan Tools (`plan_create` + `plan_exit`)

- `packages/core/src/tool/plugin/plan.ts` (`PlanTool` plugin) defines both tools (v2.2.5 tool-plugin idiom: `ctx.tool.transform(editor => editor.add(...))`, permission asserted inside the executor). Registered in `packages/core/src/plugin/internal.ts` `pre` array. Descriptions: `tool/plugin/plan/{create,exit}.txt`.
- `plan_create` (`name?` param) registers a file as the active plan via `session.update({ metadata: { activePlanPath } })`; never writes content. A dotted name = subplan (returns the parent path); plain/omitted = new top-level.
- `plan_exit` confirms the switch via `Form.Service` (Build Agent Yes/No), verifies the plan file exists, writes `session.metadata.planImpl = { status: "implementing", ... }`, `switchAgent(build)`, and admits a synthetic build prompt (default resume — continues execution).
- v1.18.5's `run/tool.ts` CLI display rule for `plan_create` was **not** ported: v2.2.5's `packages/tui/src/mini/tool.ts` falls back to generic formatting for unlisted tools.

## Plan Implementation Plugin (`plan_complete` lifecycle)

- `packages/core/src/plugin/plan-impl.ts` (Effect plugin, registered in `internal.ts` `pre`). State machine `implementing → paused → reviewing → completed` persisted in `session.metadata.planImpl` (so the TUI sidebar and child sessions see it). Registered in `packages/core/src/plugin/internal.ts`.
- Continuation loop: `ctx.session.hook("experimental.idle", ...)` — input admitted by the hook runs in the same execution instead of the session going idle, so each continuation re-triggers it (this replaces v1.18.5's `session.status`-event listener + 2s debounce + pending set; v2.2.5 publishes no `session.status`). The dead stagnant-counter heuristic from v1.18.5 was dropped.
- `plan_complete` tool (via `ctx.tool.transform`) → `reviewing`, triggers the `@code-reviewer` loop per the REVIEW_PROMPT (sent exactly once per review cycle).
- `/plan_impl pause|resume|stop|status` implemented as a first-class plugin command (`ctx.command.transform`), replacing v1.18.5's config-command template + `command.execute.before` interception.
- Compaction context injection: `ctx.session.hook("compaction", ...)` pushes a plan-status system part.

## Configurable `@`-mention Search Index (ripgrep backend)

- `packages/core/src/filesystem/search.ts`: `SearchConfigOptions` + `configureSearch`/`getSearchConfig` process singleton (ported as-is). The ripgrep layer applies `ConfigFork.loadGlobal()` → `configureSearch` at layer init — before any per-location index builds — replacing v1.18.5's `app-runtime.ts` `searchConfigBoot` (v2.2.5 has no app-runtime; per-location layer init is the boot point). The scan passes `hidden` + the fork ignore list (merged with the home-dir `Protected` excludes).
- Upstream v2.2.5's ripgrep `FindInput` already supports `hidden` and `exclude`; no `ripgrep.ts` changes needed.
- **`search.*` is honored from GLOBAL config only** (layer init reads global fork config; project-local fork config still drives `plan`/`agent` via the per-plugin `loadForLocation`). fff backend unaffected.

## Notes

- CLI/TUI renames vs v1: `bash`→`shell`, `task`→`subagent`, `apply_patch`→`patch`.
- opf18's `fix(tui): show permission prompts from nested subagent chains` (collect-subtree) was **not** ported: the v2.2.5 TUI/permission architecture was rewritten (client-side folding of durable events); verify whether the bug still exists before porting.
- TUI sidebar `packages/tui/src/feature-plugins/sidebar/plan-impl.tsx` uses the v2.2.5 TUI plugin API (`Plugin.define` + `context.ui.slot({ append: "sidebar.content" })`, no `order` property) registered in `packages/tui/src/plugin/builtins.ts`. Controls call `client.session.command({ name: "plan_impl", text })`.
