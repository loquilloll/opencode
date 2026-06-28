import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { InstanceContext } from "@/project/instance-context"

// Shared between Session.plan (path computation) and Agent.list (permission globs).
// Kept pure so it can be imported without pulling the DB-backed Session module.
export function resolveDir(template: string | undefined, instance: InstanceContext) {
  if (!template) {
    return instance.project.vcs
      ? path.join(instance.worktree, ".opencode", "plans")
      : path.join(Global.Path.data, "plans")
  }
  if (template.startsWith("~/")) return path.join(Global.Path.home, template.slice(2))
  if (path.isAbsolute(template)) return template
  return path.join(instance.worktree, template)
}
