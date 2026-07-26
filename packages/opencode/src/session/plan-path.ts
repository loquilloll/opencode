import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { InstanceContext } from "@/project/instance-context"

// Shared between Session.plan (path computation) and Agent.list (permission globs).
// Kept pure so it can be imported without pulling the DB-backed Session module.
export function resolveDir(template: string | undefined, instance: InstanceContext) {
  const defaultDir = instance.project.vcs
    ? path.join(instance.worktree, ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  if (!template) return defaultDir

  const resolved = template.startsWith("~/")
    ? path.join(Global.Path.home, template.slice(2))
    : path.isAbsolute(template)
      ? template
      : path.join(instance.worktree, template)

  // Containment: a configured plan dir must stay inside the worktree or the
  // opencode global data/config roots. This prevents a cloned repo's
  // `.opencode/opencode-fork.jsonc` from redirecting plan files — and the plan
  // agent's edit-permission glob — to arbitrary locations (e.g. `/etc`).
  // Untrusted or unknown locations fall back to the default plan dir.
  const insideWorktree = instance.worktree !== "/" && FSUtil.contains(instance.worktree, resolved)
  if (insideWorktree || FSUtil.contains(Global.Path.data, resolved) || FSUtil.contains(Global.Path.config, resolved)) {
    return resolved
  }
  return defaultDir
}
