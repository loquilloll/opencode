import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { resolveDir } from "@/session/plan-path"
import type { InstanceContext } from "@/project/instance-context"

// resolveDir only reads `worktree` and `project.vcs` off the instance; cast a
// minimal stand-in rather than constructing a full InstanceContext.
const instance = (worktree: string, vcs = true) => ({ worktree, project: { vcs } }) as unknown as InstanceContext

describe("plan-path resolveDir", () => {
  // Use a platform-appropriate absolute worktree (outside the global opencode
  // data/config dirs) so containment checks behave the same on Windows and POSIX.
  const wt = process.platform === "win32" ? "C:\\tmp\\opf-resolve-test" : "/tmp/opf-resolve-test"
  const defaultVcs = path.join(wt, ".opencode", "plans")

  test("undefined template resolves to the default plan dir", () => {
    expect(resolveDir(undefined, instance(wt))).toBe(defaultVcs)
    expect(resolveDir(undefined, instance(wt, false))).toBe(path.join(Global.Path.data, "plans"))
  })

  test("worktree-relative path is accepted (inside the worktree)", () => {
    expect(resolveDir("custom/plans", instance(wt))).toBe(path.join(wt, "custom", "plans"))
  })

  test("absolute path inside Global.Path.config is accepted", () => {
    const p = path.join(Global.Path.config, "my-plans")
    expect(resolveDir(p, instance(wt))).toBe(p)
  })

  test("absolute path inside Global.Path.data is accepted", () => {
    const p = path.join(Global.Path.data, "plans-custom")
    expect(resolveDir(p, instance(wt))).toBe(p)
  })

  test("absolute path OUTSIDE worktree/data/config falls back to default (security)", () => {
    const evil = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc"
    expect(resolveDir(evil, instance(wt))).toBe(defaultVcs)
  })

  test("relative `..` escape falls back to default (security)", () => {
    expect(resolveDir("../escape", instance(wt))).toBe(defaultVcs)
    expect(resolveDir("../../etc", instance(wt))).toBe(defaultVcs)
  })

  test("~/../ escape falls back to default (security)", () => {
    expect(resolveDir("~/../../../etc", instance(wt))).toBe(defaultVcs)
  })
})
