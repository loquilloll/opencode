# Plan Mode & Implementation Lifecycle

## Overview

Plan mode is a structured workflow that guides the agent through planning, review, implementation, and code review before declaring a task complete. It prevents the agent from rushing to implementation without a validated plan, and ensures every change set passes review before finishing.

## The Full Flow

```
User switches to Plan agent (Tab)
         │
         ▼
┌─────────────────────────────────────────┐
│  PHASE 1: Explore                       │
│  Launch @explore subagents to understand │
│  the codebase and the request            │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  PHASE 2: Design                        │
│  Launch @general subagent(s) to design   │
│  the implementation approach             │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  PHASE 3: Review Design                 │
│  Read critical files, ensure alignment   │
│  with user intent, ask clarifications    │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  PHASE 4: Write Plan                    │
│  Write the final plan to the active plan │
│  file (.opencode/plans/NN-slug.md)       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  PHASE 5: @plan-review                  │
│  Spawn @plan-review subagent on the plan │
│  file. Remediate any blocking findings.  │
│  Must complete before plan_exit.         │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  PHASE 6: plan_exit                     │
│  Agent calls plan_exit. User confirms    │
│  "Yes" to start implementation.          │
└────────────────┬────────────────────────┘
                 │
         ┌───────┴───────┐
         │ planImpl mode │
         │   activated   │
         └───────┬───────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  IMPLEMENTATION                         │
│  Build agent executes the plan.          │
│  Plugin auto-resumes on idle with a       │
│  continuation prompt. Sidebar shows       │
│  title, timer, and controls.              │
└────────────────┬────────────────────────┘
                 │  agent calls plan_complete
                 ▼
┌─────────────────────────────────────────┐
│  CODE REVIEW                            │
│  Plugin injects REVIEW_PROMPT. Agent      │
│  spawns @code-reviewer, notes task_id.    │
│  Remediate HIGH/MEDIUM findings.          │
│  Re-review by resuming same task_id.      │
│  Repeat until clean.                      │
└────────────────┬────────────────────────┘
                 │
                 ▼
            ✅ DONE
     Agent reports final status
```

---

## Plan Mode (Phases 1-6)

### How it activates

Plan mode is always available. The user switches to the **plan** agent by pressing `Tab` in the TUI. No environment variables or flags are required.

### The plan file

Each plan session gets a file at `.opencode/plans/NN-<slug>.md` (VCS projects) or `~/.local/share/opencode/plans/` (non-VCS). The filename uses an iteration number (`00`, `01`, `02`, ...) and the session's random slug.

The file is seeded from a template (`plan-template.txt`) with frontmatter:

```yaml
---
created: <timestamp>
iteration: <NN>
slug: <session-slug>
parent: <parent-plan-path-or-empty>
---
```

### Active plan pointer

The active plan is tracked by `session.metadata.activePlanPath` — a persistent pointer written by `plan_create` and consulted by `Session.plan()`. This decouples *which plan is active* from filesystem globbing, so agent switches and config changes never silently move the agent off its current plan.

Resolution order in `Session.plan()`:
1. `session.metadata.activePlanPath` (if the file still exists)
2. Existing file matching this session's slug + id
3. Next iteration (max existing + 1)

### Managing plans

The `plan_create` tool lets the agent decide when to start a new plan or subplan:

| Situation | Action |
|---|---|
| Request fits the current plan | Edit the plan file in place (no tool needed) |
| New, unrelated concern | `plan_create` (no parent) — fresh independent plan |
| Refinement or breakdown of current plan | `plan_create` with `parent: true` — subplan linked via frontmatter |

### @plan-review (Phase 5)

After writing the plan, the agent **must** spawn a `@plan-review` subagent before calling `plan_exit`. The reviewer checks for gaps, incorrect assumptions, missing verification steps, and scope concerns. The agent reads the feedback and remediates the plan file in place. Skipping this step is not permitted.

### plan_exit (Phase 6)

When the plan is written, reviewed, and remediated, the agent calls `plan_exit`. This asks the user:

> Plan at `.opencode/plans/NN-slug.md` is complete. Would you like to switch to the build agent and start implementing?

If the user confirms **Yes**, `plan_exit`:
1. Switches to the **build** agent
2. Writes `session.metadata.planImpl` to start implementation mode
3. Injects a synthetic message: *"You are now in implementation mode — execute the plan. When implementation is complete and verified, call the plan_complete tool to trigger code review."*

---

## Implementation Mode

### State machine

```
implementing ←──────→ paused
     │                     │
     │ plan_complete       │ /plan_impl resume
     ▼                     │
  reviewing ←──────────────┘
     │
     │ review clean
     ▼
  completed
```

State is stored in `session.metadata.planImpl`:

```typescript
{
  status: "implementing" | "paused" | "reviewing" | "completed",
  title: string,              // plan title for sidebar display
  planPath: string,           // absolute path to the plan file
  startedAt: number,          // wall-clock start
  activeStartedAt: number,    // tracks pause/resume boundaries
  timeUsedSeconds: number,    // accumulated active time
  reviewIteration: number,    // review cycle counter
}
```

### Idle auto-resume

The plan implementation plugin listens for `session.status` idle events. When the session goes idle and `planImpl.status` is `implementing` or `reviewing`, the plugin sends a continuation prompt via `client.session.promptAsync()`.

- **2-second debounce** prevents rapid-fire resumes.
- **Stagnation detection**: after 3 consecutive idle-resume cycles without progress, the plugin escalates to a stronger prompt: *"You appear to be stuck. Re-read the plan, identify what is blocking you..."*

### Controls

| Control | How | Effect |
|---|---|---|
| **Pause** | `/plan_impl pause` or sidebar `[pause]` | Halts auto-resume. Timer freezes. State preserved. |
| **Resume** | `/plan_impl resume` or sidebar `[resume]` | Restarts auto-resume. Timer continues. |
| **Stop** | `/plan_impl stop` or sidebar `[stop]` | Halts auto-resume permanently. State preserved for later resume. |
| **Status** | `/plan_impl` (no args) | Shows title, status, elapsed time, plan path. |

### TUI sidebar

A built-in sidebar component (`order: 350`, between LSP and Todo) shows:

```
● Plan Impl
hello function in src/hello.ts
implementing 2m 15s
[pause] [stop]
```

- **Status indicator**: green dot (implementing), yellow dot (reviewing), pause icon (paused)
- **Live timer**: 1-second refresh via `setInterval`
- **Clickable controls**: `[pause]`, `[resume]`, `[stop]` — send `/plan_impl` commands via the session API

The sidebar is hidden when status is `completed` or no implementation is active.

### plan_complete

When the build agent finishes implementing and verifying the plan, it calls the `plan_complete` tool. This transitions `planImpl.status` to `"reviewing"`, which triggers the code review phase on the next idle-resume.

### Code review loop

When `planImpl.status` is `"reviewing"`, the idle-resume injects `REVIEW_PROMPT`:

> 1. Generate a comprehensive prompt for the @code-reviewer subagent covering the entire change set.
> 2. Spawn @code-reviewer. **Note the task_id** returned.
> 3. Remediate all HIGH and MEDIUM findings.
> 4. Re-review by **resuming the same task_id** (not spawning a new code-reviewer). This preserves the reviewer's context across iterations.
> 5. Repeat until all HIGH and MEDIUM items are resolved.

The same @code-reviewer task is reused for every re-review, maintaining full context of previous findings and remediations.

---

## Architecture

### Key files

| File | Responsibility |
|---|---|
| `src/session/reminders.ts` | `SessionReminders.apply` — injects plan-file path and workflow prompt each plan-agent turn |
| `src/session/session.ts` | `Session.plan()` — resolves active plan path (pointer → match → bump) |
| `src/session/plan-path.ts` | `resolveDir()` — shared plan directory resolution |
| `src/session/prompt/plan-mode.txt` | The 6-phase workflow prompt with `${planInfo}` placeholder |
| `src/session/prompt/plan-template.txt` | Plan file seed template |
| `src/tool/plan.ts` | `PlanExitTool` (starts impl mode) + `PlanCreateTool` (new plans/subplans) |
| `src/plugin/plan-impl.ts` | Implementation plugin: state machine, idle-resume, tools, commands |
| `src/config/fork.ts` | `ConfigFork` — fork-specific plan config (path, name, template, prompt) |
| `src/agent/agent.ts` | Plan/build agent permissions (plan_create, plan_exit, plan_complete) |
| `packages/tui/.../sidebar/plan-impl.tsx` | TUI sidebar with timer and controls |

### ConfigFork layer

Fork-specific configuration lives in `opencode-fork.jsonc` (separate from vanilla `opencode.json`):

```jsonc
{
  "plan": {
    "path": ".opencode/plans",       // custom plan directory
    "name": "${iteration}-${slug}.md", // filename template
    "template": "~/plan-template.md",  // custom seed template
    "prompt": "..."                    // override the plan-mode reminder text
  }
}
```

ConfigFork is wired into the app-runtime, prompt processing, tool registry, and test layers via `Layer.provideMerge(ConfigFork.defaultLayer)`.

### Plugin hooks

The plan implementation plugin (`plan-impl.ts`) uses these hooks:

| Hook | Purpose |
|---|---|
| `config` | Registers `/plan_impl` slash command |
| `tool` | Exposes `plan_complete` tool to the build agent |
| `event` | Listens for `session.status` idle → auto-resume |
| `command.execute.before` | Handles `/plan_impl pause\|resume\|stop\|status` |
| `experimental.session.compacting` | Preserves plan-impl context through compaction |

### Session metadata

All plan state lives in `session.metadata` (a freeform JSON column):

| Key | Written by | Purpose |
|---|---|---|
| `activePlanPath` | `plan_create` | Which plan file is active |
| `planImpl` | `plan_exit` (start), plugin (updates) | Implementation state machine + timer |

`session.setMetadata` replaces the entire metadata object, so all writes use read-modify-write: GET current metadata, spread it, update the key, PATCH it back.
