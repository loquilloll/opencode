import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  configureSearch,
  defaultSearchConfig,
  getSearchConfig,
} from "../../src/filesystem/search.js"

describe("FileSystemSearch.configureSearch", () => {
  // The search-index config is a process-wide singleton; reset it before and
  // after each test so mutations don't leak between tests or into other suites.
  beforeEach(() => {
    configureSearch(defaultSearchConfig)
  })
  afterEach(() => {
    configureSearch(defaultSearchConfig)
  })

  test("defaults to no hidden files and no ignore globs", () => {
    expect(getSearchConfig()).toEqual(defaultSearchConfig)
    expect(getSearchConfig().hidden).toBe(false)
    expect(getSearchConfig().ignore).toEqual([])
  })

  test("applies a partial update, preserving untouched fields", () => {
    configureSearch({ hidden: true })
    expect(getSearchConfig().hidden).toBe(true)
    expect(getSearchConfig().ignore).toEqual([])
  })

  test("round-trips hidden + ignore globs together", () => {
    configureSearch({ hidden: true, ignore: ["**/.cache/**", "**/.git/**"] })
    const config = getSearchConfig()
    expect(config.hidden).toBe(true)
    expect(config.ignore).toEqual(["**/.cache/**", "**/.git/**"])
  })

  test("applies ignore files through partial update", () => {
    configureSearch({ ignoreFiles: [".opencodeignore"] })
    expect(getSearchConfig().ignoreFiles).toEqual([".opencodeignore"])
  })
})
