// Warm `filesystem.ts` before `search.ts`: the two are mutually recursive
// (`filesystem.ts` references `FileSystemSearch.node`, `search.ts` imports
// `FileSystem`), so importing `search.ts` first hits a TDZ. filesystem.ts loads
// its `search.ts` dependency in the safe order.
import "../../src/filesystem.ts"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { configureSearch, defaultSearchConfig, getSearchConfig } from "@opencode-ai/core/filesystem/search"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

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
    const cfg = getSearchConfig()
    expect(cfg.hidden).toBe(true)
    expect(cfg.ignore).toEqual(["**/.cache/**", "**/.git/**"])
  })
})
