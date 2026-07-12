# Modifications

This file tracks fork-specific changes made to opencode so they are easy to audit, carry forward, or revert when syncing with upstream.

## Experimental Plan Configuration

- Added `opencode-fork.jsonc` / `opencode-fork.json` support through `packages/opencode/src/config/fork.ts` so this fork can keep fork-only settings separate from vanilla opencode config.
- Added fork config fields under `plan`:
  - `path` — override the directory where plan files are stored.
  - `name` — override the generated plan filename template with `${iteration}`, `${slug}`, and `${sessionId}` placeholders.
  - `template` — point to a plan seed-template file.
  - `prompt` — override the experimental plan-mode reminder text at runtime without editing the built-in source prompt.
- Added a fork config `agent` section that mirrors `opencode.json` agent config and merges into the agent registry, allowing fork-only agent overrides such as `agent.plan`.
- Changed plan file naming to iteration-based names, defaulting to `${iteration}-${slug}.md`, and made `Session.plan` Effect-based so it can read fork config and the filesystem.
- Added validation for configured plan filenames so rendered names must be safe markdown basenames and cannot escape the plan directory.
- Added custom-template lookup logic so existing plan files remain stable for configured `plan.name` templates and new iterations use the current maximum plus one.
- Added `packages/opencode/src/session/plan-path.ts` for shared plan directory resolution between session path computation and plan-agent permissions.
- Added plan seed-template support in `SessionReminders.apply`, using `ConfigFork.plan.template` when configured and falling back to the built-in `packages/opencode/src/session/prompt/plan-template.txt`.
- Hardened plan template loading so project-configured templates must stay inside the worktree or global opencode config directory; disallowed or missing templates fall back to the built-in default.
- Made plan seed write failures non-fatal; failures are logged and the model is instructed to create the plan manually.
- Updated plan-agent permissions to allow editing generated markdown plan files in the configured plan directory while continuing to deny unrelated edits.
- Reapplied the dynamic plan-file edit/external-directory permission overlay after custom agent config merges so users can keep a custom `.opencode/agent/plan.md` or global `agent/plan.md` prompt without losing permission to write the resolved plan file.
- Added regression tests that verify custom plan-agent prompts preserve dynamic plan-file permissions, arbitrary source edits remain denied, and `opencode-fork.jsonc -> plan.path` changes the allowed plan directory.
- Wired `ConfigFork` into app runtime, prompt processing, tool registry, agent layers, and affected tests.

## Agent-Driven Plan Management

- Added a persistent active-plan pointer stored in `session.metadata.activePlanPath`. `Session.plan` now consults it first (when the file still exists), then falls back to the existing slug/id match, then to iteration bump. This decouples *which plan is active* from the filesystem glob, so agent switches and config changes no longer silently move the agent off its current plan.
- Added a `forceNew` option to `Session.plan` that skips the pointer and existing-match resolution to compute a fresh iteration path. Used by the `plan_create` tool.
- Added an agent-called `plan_create` tool (`packages/opencode/src/tool/plan.ts`) with a `parent` boolean parameter. It creates a new plan at the next iteration, seeds it from the configured template, and points the session at it. With `parent: true` it records the current active plan's relative path in the new plan's frontmatter as a subplan link.
- Wired the previously-stubbed `${parent}` template variable (`packages/opencode/src/session/reminders.ts:renderPlanTemplate`) so subplan files carry their parent's path. Added `parent: ${parent}` to the default plan template frontmatter.
- Exported `loadPlanTemplate` and `renderPlanTemplate` from `SessionReminders` so the `plan_create` tool reuses the same template loading/rendering as the seeding path (no duplication).
- Registered `plan_create` alongside `plan_exit` in the built-in tool set (`packages/opencode/src/tool/registry.ts`), always available (agent permissions still restrict them to the plan agent).
- Updated plan-agent permissions to allow `plan_create` and denied it for non-plan agents (`packages/opencode/src/agent/agent.ts`), mirroring the existing `plan_exit` permission handling.
- Added a TUI display rule for `plan_create` (`packages/opencode/src/cli/cmd/run/tool.ts`).
- Updated the plan-mode reminder prompt (`packages/opencode/src/session/prompt/plan-mode.txt`) to document the active-plan concept and when to update in place vs call `plan_create` for a new plan or subplan.

## Plan Mode Always-On

- Removed the `experimentalPlanMode` and `client === "cli"` gating on plan tools and the plan-file reminder path so the full plan-mode system is always active when the plan agent is selected. Previously the plan agent was always defined but its tooling (`plan_create`, `plan_exit`) and the plan-file injection (`SessionReminders.apply`) were hidden unless `OPENCODE_EXPERIMENTAL_PLAN_MODE=1` was set, causing the agent to improvise with unrelated tools (e.g. `continuity`) instead of using the plan file.
- `registry.ts` now unconditionally registers `plan_create` and `plan_exit` in the built-in tool set (agent permissions still restrict them to the plan agent).
- `SessionReminders.apply` now always takes the full plan-file path (pointer resolution, seeding, `${planInfo}` injection) instead of falling back to the bare `PROMPT_PLAN` text. The `RuntimeFlags` and `PROMPT_PLAN` imports were removed from reminders.
- The `experimentalPlanMode` flag remains in `RuntimeFlags` for compatibility but is no longer read by any code.

## Mandatory Plan Review Before Exit

- Added Phase 5 (Plan Review & Remediation) to the plan-mode workflow prompt (`packages/opencode/src/session/prompt/plan-mode.txt`) requiring the plan agent to launch a `@plan-review` subagent on the active plan file and remediate any issues before calling `plan_exit`. The old Phase 5 (Call plan_exit) became Phase 6 and now requires the review to be done first. This prevents the agent from writing a plan and immediately requesting build-mode approval without a quality gate.

## Plan-Mode Reminder Wording

- Updated the `${planInfo}` status line in `SessionReminders.apply` (`packages/opencode/src/session/reminders.ts`) so every case explicitly states "You are in plan mode." The existing-plan case now instructs the agent to "update it in place or call `plan_create` for a new plan or subplan based on the user's request" instead of passively noting the file can be edited. This ensures the agent understands its role — update or create plans — whenever it enters or returns to plan mode.

## Agent-Owned Plan Files

- Stopped pre-seeding the plan file when entering plan mode. `SessionReminders.apply` (`packages/opencode/src/session/reminders.ts`) no longer writes a scaffold from any template; it resolves the plan folder, the naming convention, and the next iteration via `Session.plan` and injects them into the `${planInfo}` reminder so the agent creates the file itself with the write tool.
- The plan agent may now create, read, and edit **any** file in the plan folder, not only the active plan. The `plan-mode` prompt (`packages/opencode/src/session/prompt/plan-mode.txt`) was updated to drop the "only the active plan" edit restriction and to describe the new create-then-register workflow.
- Reworked the `plan_create` tool (`packages/opencode/src/tool/plan.ts`) so it no longer writes plan content. It accepts a `name` parameter (a safe markdown basename following the convention) and only registers the file as the active plan, optionally recording it as a subplan and returning the parent path for the agent to put in frontmatter. `Session.plan` gained a `name` option that resolves an agent-supplied name under the plan directory.
- Added hierarchical subplan naming. The `${iteration}` token now matches dotted decimals (`\d+(?:\.\d+)*`), so plans can be `00-...md`, `00.01-...md`, `00.01.01-...md`. The plan agent decides new-plan-vs-subplan entirely through the filename it passes to `plan_create`: a plain name (`01-x.md`) is a new top-level plan; a dotted name (`00.01-x.md`) is a subplan. `Session.plan` now returns the inferred parent plan path whenever the resolved plan is a subplan, and `plan_create` returns that path so the agent can record `parent:` in frontmatter. Top-level iterations are zero-indexed (`00` first); subplan segments are one-indexed (first child of `00` is `00.01`). The `plan_create` `parent` boolean was removed — the filename declares the hierarchy. The slug/id fallback discovery prefers top-level plans so a stray subplan never shadows the main plan.
- `plan_exit` now returns a clear "No plan file found" result instead of switching to build when the active plan file does not exist.
- Removed the now-dead plan template machinery: `loadPlanTemplate`/`renderPlanTemplate` and the `PLAN_TEMPLATE` import in `reminders.ts`, the `plan.template` config field from `ConfigFork.PlanSchema` (`packages/opencode/src/config/fork.ts`), and the `packages/opencode/src/session/prompt/plan-template.txt` asset.

## Plan Implementation Plugin

- Added a built-in server plugin (`packages/opencode/src/plugin/plan-impl.ts`) that manages the plan implementation lifecycle after `plan_exit` is confirmed. State machine: `implementing` → `paused` → `reviewing` → `completed`. State is stored in `session.metadata.planImpl` (status, title, planPath, timer fields).
- **Idle auto-resume**: the `event` hook listens for `session.status` idle events. When `planImpl.status` is `implementing` or `reviewing`, it sends a continuation prompt via `client.session.promptAsync` with a 2-second debounce. The implementation prompt tells the agent to continue working or call `plan_complete`; the review prompt instructs it to spawn `@code-reviewer`, remediate high/medium findings, and re-review until clean.
- **`plan_complete` tool**: agent-called (build agent only — denied for all others via `agent.ts`). Transitions status to `reviewing`, which triggers the code review loop on the next idle-resume.
- **Slash commands**: `/plan_impl pause|resume|stop|status` — pause halts auto-resume (preserves state), resume restarts it, stop disables auto-resume entirely (state preserved for later resume).
- **Compaction preservation**: the `experimental.session.compacting` hook injects plan implementation context into the compaction prompt so state survives context compression.
- Registered the plugin alongside the other built-in auth plugins in `packages/opencode/src/plugin/index.ts`.
- Modified `plan_exit` (`packages/opencode/src/tool/plan.ts`) to write `session.metadata.planImpl = { status: "implementing", ... }` when the user confirms the switch to build. The synthetic build message now tells the agent about `plan_complete`.
- Added `plan_complete: "allow"` for the build agent and `plan_complete: "deny"` for all other agents (`packages/opencode/src/agent/agent.ts`).
- Added a TUI sidebar (`packages/tui/src/feature-plugins/sidebar/plan-impl.tsx`, order 350) showing plan title, status badge, and live elapsed timer. Includes clickable `[pause]`/`[resume]`/`[stop]` controls that invoke `/plan_impl` via the session command API. Hidden when status is `completed` or no implementation is active.
- Registered the sidebar as a built-in TUI plugin in `packages/tui/src/feature-plugins/builtins.ts`.


## Global Config Created For This Workspace

- Created `~/.config/opencode/agent/plan.md` as the global plan agent prompt config.
- Created `~/.config/opencode/plan-template.md` as the global plan seed template.
- Created `~/.config/opencode/opencode-fork.jsonc` pointing `plan.template` at the global plan template.


## CLI Lazy Command Loading (Startup Performance)

- Changed packages/opencode/src/index.ts to register all ~23 yargs commands via a lazy() helper that dynamic-imports each command module (un, mcp, cp, 	ui, db, etc.) only when that command is actually invoked, instead of eagerly importing every command module at process start.
- Motivation: the dev/source launch path (un run ./src/index.ts, i.e. how this fork is started as opf17) eagerly evaluated the full command-module graph on every invocation. mcp (@modelcontextprotocol/sdk + @clack/prompts) and un alone added ~1.8s of cold-start cost; the eager set added ~1.5s+ even for --version/--help/the default TUI. Lazy loading cuts fork cold start from ~2.7s to ~1.6s (--version), bringing it within ~0.8s of the published compiled binary.
- Each command already defers its own heavy work (Effect runtime, providers) via dynamic imports inside its handler, so deferring the module itself is safe; builders run on demand under yargs strict mode, and aliases (uth, plug) are preserved.
- --help now uses the promise form parse() (the legacy parse(args, cb) callback returns an empty help string with async builders), with the logo prepended only for top-level help to match prior behavior.
