import { describe, expect, test } from "bun:test"
import path from "path"
import { PlanPath } from "../../src/session/plan-path.js"
import type { Location } from "@opencode/schema/location"

const location = (input: { directory: string }): Location.Info =>
  ({
    directory: input.directory,
    project: { id: "test", directory: input.directory, canonical: input.directory },
  }) as unknown as Location.Info

const worktree = path.resolve("/work/repo")

describe("PlanPath.resolveDir", () => {
  test("defaults to .opencode/plans under the location directory", () => {
    const dir = PlanPath.resolveDir(undefined, location({ directory: worktree }))
    expect(dir).toBe(path.join(worktree, ".opencode", "plans"))
  })

  test("relative template resolves inside the worktree", () => {
    const dir = PlanPath.resolveDir("docs/plans", location({ directory: worktree }))
    expect(dir).toBe(path.join(worktree, "docs", "plans"))
  })

  test("absolute template inside the worktree is honored", () => {
    const dir = PlanPath.resolveDir(path.join(worktree, "plans"), location({ directory: worktree }))
    expect(dir).toBe(path.join(worktree, "plans"))
  })

  test("absolute template outside the worktree and global roots falls back to the default", () => {
    const outside = process.platform === "win32" ? "D:\\elsewhere\\plans" : "/elsewhere/plans"
    const dir = PlanPath.resolveDir(outside, location({ directory: worktree }))
    expect(dir).toBe(path.join(worktree, ".opencode", "plans"))
  })
})
