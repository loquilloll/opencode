export * as PlanPath from "./plan-path.js"

import path from "path"
import os from "os"
import { roots } from "@opencode/util/global-roots"
import type { Location } from "@opencode/schema/location"

// Global data/config roots for plan-dir containment checks.
const global = roots("opencode")

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

// Shared between SessionPlan.plan (path computation) and the plan agent's
// permission globs. Kept pure so it can be imported without pulling the
// DB-backed session module.
export function resolveDir(template: string | undefined, location: Location.Info) {
  const worktree = location.directory
  const defaultDir = path.join(worktree, ".opencode", "plans")
  if (!template) return defaultDir

  const resolved = template.startsWith("~/")
    ? path.join(os.homedir(), template.slice(2))
    : path.isAbsolute(template)
      ? template
      : path.join(worktree, template)

  // Containment: a configured plan dir must stay inside the worktree or the
  // opencode global data/config roots. This prevents a cloned repo's
  // `.opencode/opencode-fork.jsonc` from redirecting plan files — and the plan
  // agent's edit-permission glob — to arbitrary locations (e.g. `/etc`).
  // Untrusted or unknown locations fall back to the default plan dir.
  const root = path.parse(worktree).root
  const insideWorktree = worktree !== root && contains(worktree, resolved)
  if (insideWorktree || contains(global.data, resolved) || contains(global.config, resolved)) {
    return resolved
  }
  return defaultDir
}
