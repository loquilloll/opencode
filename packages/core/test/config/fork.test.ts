import { describe, expect, test } from "bun:test"
import { ConfigFork } from "../../src/config/fork.js"

describe("ConfigFork.resolveSearchConfig", () => {
  test("applies fork defaults when search is unset", () => {
    const config = ConfigFork.resolveSearchConfig({})
    expect(config.hidden).toBe(true)
    expect(config.ignore).toBe(ConfigFork.DEFAULT_SEARCH_IGNORE)
  })

  test("passes explicit values through", () => {
    const config = ConfigFork.resolveSearchConfig({ search: { hidden: false, ignore: ["**/.cache/**"] } })
    expect(config.hidden).toBe(false)
    expect(config.ignore).toEqual(["**/.cache/**"])
  })

  test("hidden defaults when only ignore is set", () => {
    const config = ConfigFork.resolveSearchConfig({ search: { ignore: [] } })
    expect(config.hidden).toBe(true)
    expect(config.ignore).toEqual([])
  })
})
