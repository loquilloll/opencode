import { describe, expect, test } from "bun:test"
import { ConfigFork } from "@/config/fork"

describe("ConfigFork search config", () => {
  test("DEFAULT_SEARCH_IGNORE covers noisy hidden dirs and keeps .opencode visible", () => {
    expect(ConfigFork.DEFAULT_SEARCH_IGNORE.length).toBeGreaterThan(0)
    expect(ConfigFork.DEFAULT_SEARCH_IGNORE).toContain("**/.git/**")
    expect(ConfigFork.DEFAULT_SEARCH_IGNORE).toContain("**/.cache/**")
    // opencode-owned paths must stay indexable
    expect(ConfigFork.DEFAULT_SEARCH_IGNORE.every((glob) => !glob.includes(".opencode"))).toBe(true)
  })

  test("resolveSearchConfig applies fork defaults when search is unset", () => {
    const cfg = ConfigFork.resolveSearchConfig({} as ConfigFork.Info)
    expect(cfg.hidden).toBe(true)
    expect(cfg.ignore).toEqual(ConfigFork.DEFAULT_SEARCH_IGNORE)
  })

  test("resolveSearchConfig honors explicit overrides", () => {
    const cfg = ConfigFork.resolveSearchConfig({
      search: { hidden: false, ignore: ["**/node_modules/**"] },
    } as ConfigFork.Info)
    expect(cfg.hidden).toBe(false)
    expect(cfg.ignore).toEqual(["**/node_modules/**"])
  })
})
