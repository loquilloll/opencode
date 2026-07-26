# Modifications

This file tracks fork-specific changes ported onto `release/v1.18.5` (upstream tag `v1.18.5`, `e5cc278dec`) so they are easy to audit, carry forward, or revert when syncing with upstream. The fork design mirrors `release/v1.17.9` (opf17): the **plan agent authors plan files itself** (no system pre-seed). v1.18.5 architectural adaptations are noted inline (`LayerNode.make({service,layer,deps})` object form, `AppNodeBuilderV1`, no `defaultLayer` exports).

## ConfigFork (separate `opencode-fork.jsonc`)

- Added `packages/opencode/src/config/fork.ts` so fork-only settings live in `opencode-fork.jsonc` / `opencode-fork.json` (vanilla opencode never reads them). Self-export `ConfigFork`, `Service`, `loadGlobal` (global files only), per-instance `layer`, and `node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })`.
- `PlanSchema` = `{ path?, name?, prompt? }` (configurable plan dir, filename template, plan-mode reminder prompt). `SearchSchema` = `{ hidden?, ignore? }`. `AgentSchema` mirrors `opencode.json` `agent` for fork-only agent overrides. `resolveSearchConfig` applies fork defaults (`hidden: true`, `DEFAULT_SEARCH_IGNORE` preset).
- Wired `ConfigFork.node` into the consuming layers' `deps` (`Agent.node`, `SessionPrompt.node`, `ToolRegistry.node`) and via `Effect.provideService(ConfigFork.Service, fork)` at call sites (`prompt.ts` for `SessionReminders.apply`, `tool/plan.ts`).

## Agent-Driven Plan Mode (agent authors plans; no pre-seed)

- `Session.plan` (`packages/opencode/src/session/session.ts`) is `Effect.fn`-based, reads `ConfigFork` + `FSUtil`, and resolves `{ path, iteration, parent }`. Supports an `options` bag (`{ forceNew?, name? }`), the session's `metadata.activePlanPath` pointer, dotted hierarchical iterations (`\d+(?:\.\d+)*` → `00`, `00.01`, `00.01.02`), and a `parent` result for subplans. Helpers: `namePattern`, `matchIteration`, `iterationsIn`, `nextIteration`, `isTopLevel`, `parentPlanFile`, `isSafePlanName`, `renderName`.
- `packages/opencode/src/session/plan-path.ts` exports `resolveDir(template, instance)` shared between `Session.plan` and the plan-agent permission globs. **v1.18.5 hardening:** `resolveDir` contains configured paths to the worktree / `Global.Path.data` / `Global.Path.config` (falling back to the default plan dir) so a cloned repo's `.opencode/opencode-fork.jsonc` cannot redirect plan files or the plan-agent edit glob to arbitrary locations (a gap inherited from opf17, closed here).
- `SessionReminders.apply` (`packages/opencode/src/session/reminders.ts`) no longer pre-seeds anything. It resolves the plan folder + naming convention + next iteration via `Session.plan`, builds a rich `${planInfo}` (active-plan path, naming convention, folder note, "create it with the write tool then call `plan_create`"), and injects it into the (configurable) plan-mode prompt. `describeNameTemplate` renders the convention. **Plan mode is always-on** — the `experimentalPlanMode` gate and `RuntimeFlags`/`PROMPT_PLAN` imports were removed.
- `plan-mode.txt` (`packages/opencode/src/session/prompt/plan-mode.txt`) is the agent-driven workflow: edit any file in the plan folder, "Managing Plans" (active-plan concept, new-plan-vs-subplan via filename), Phase 1–6 including mandatory `@plan-review` before `plan_exit`.

## Plan Tools (`plan_create` + `plan_exit`)

- `packages/opencode/src/tool/plan.ts` defines both `PlanCreateTool` and `PlanExitTool`.
  - `plan_create` (`name?` param) registers a file as the active plan via `session.setMetadata({ activePlanPath })`; never writes content. A dotted name = subplan (returns the parent path for frontmatter); plain/omitted = new top-level.
  - `plan_exit` confirms the switch to build, verifies the plan file exists, and writes `session.metadata.planImpl = { status: "implementing", ... }`.
- Registered both in `packages/opencode/src/tool/registry.ts` (always available; agent permissions restrict them to the plan agent) and added a `plan_create` CLI display rule (`packages/opencode/src/cli/cmd/run/tool.ts`).
- Plan-agent permissions (`packages/opencode/src/agent/agent.ts`) allow `plan_create`/`plan_exit`/`plan_complete` (and edit/external-directory globs derived from `resolveDir`, so a configured `plan.path` actually works for the plan agent — an improvement over opf17's hardcoded globs); all three are denied for other agents.

## Plan Implementation Plugin (`plan_complete` lifecycle)

- `packages/opencode/src/plugin/plan-impl.ts` (built-in server plugin) drives the post-`plan_exit` lifecycle. State machine `implementing → paused → reviewing → completed` persisted in `session.metadata.planImpl`. On `session.status` idle it auto-resumes (2s debounce) with an implementation/review prompt; provides the `plan_complete` tool (→ `reviewing`, triggers the `@code-reviewer` loop) and `/plan_impl pause|resume|stop|status`; injects context during compaction. Registered in `packages/opencode/src/plugin/index.ts`.
- `packages/tui/src/feature-plugins/sidebar/plan-impl.tsx` (order 350) shows plan title, status badge, live elapsed timer, and clickable `[pause]`/`[resume]`/`[stop]` controls; hidden when completed. Registered in `packages/tui/src/feature-plugins/builtins.ts`.

## Configurable `@`-mention Search Index (ripgrep backend)

- `packages/core/src/filesystem/search.ts` exports `SearchConfigOptions`, `configureSearch`, `getSearchConfig`, `defaultSearchConfig`; the `ripgrepLayer` reads `hidden` + `ignore`.
- `packages/core/src/ripgrep.ts` `FindInput` gained `exclude?: readonly string[]`, applied as `--glob=!…` in `find`.
- `packages/opencode/src/effect/app-runtime.ts` runs a `searchConfigBoot` `Layer.effectDiscard` at boot that calls `configureSearch(resolveSearchConfig(globalFork))` before any per-location index is built (carries its own `Layer.provide(AppNodeBuilderV1.build(FSUtil.node))` since the outer `provideMerge` makes it a provider to the app, not a consumer of the group). `ConfigFork.node` is in the `LayerNode.group`.

## Notes

- `experimentalPlanMode` flag remains in `RuntimeFlags` for compatibility but is no longer read.
- **`search.*` is honored from GLOBAL config only.** `searchConfigBoot` runs once at app boot via `ConfigFork.loadGlobal()` (reads `~/.config/opencode/opencode-fork.{jsonc,json}`) and sets the `searchConfig` singleton before any per-location ripgrep index builds. A project-local `.opencode/opencode-fork.jsonc` `search.hidden`/`search.ignore` does NOT affect the index (project-local fork config still drives `plan`/`agent` via the per-instance `ConfigFork.layer`). Use global config for search-index tuning.
- fff search backend has no hidden toggle and is unaffected; `.opencode/plans` visibility on fff-only platforms remains a follow-up.
- opf17's `tui/routes/home.tsx` workspace-reset bugfix was NOT ported (tangential TUI fix, API-drift risk) — can be added separately.
