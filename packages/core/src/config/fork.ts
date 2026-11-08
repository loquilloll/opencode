export * as ConfigFork from "./fork.js"

import { parse, type ParseError } from "jsonc-parser"
import fs from "fs/promises"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { roots } from "@opencode/util/global-roots"
import { ConfigAgent } from "@opencode/schema/config/agent"
import type { Location } from "@opencode/schema/location"

// Fork-specific config lives in `opencode-fork.jsonc` so a vanilla opencode and this fork can coexist:
// vanilla never reads this file. Add new top-level sections here as the fork grows.

const PlanSchema = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description:
      "Directory for plan files. Supports ~ and relative-to-project paths. Defaults to .opencode/plans (VCS projects) or the global plans dir.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description:
      "Plan filename template. Variables: ${iteration}, ${slug}, ${sessionId}. Default: ${iteration}-${slug}.md",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "Inline plan-mode reminder prompt. Supports a ${planInfo} placeholder (resolved to the plan-file status line).",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description:
      "Primary agent id that takes over after plan approval (plan_exit or an approved submit_plan review). Must be an existing primary agent. Default: build.",
  }),
})

// Mirrors opencode.json's `agents` section so the fork can configure agents (including plan)
// via JSON without affecting a coexisting vanilla opencode.
const AgentSchema = Schema.Record(Schema.String, ConfigAgent.Info)

// Controls the ripgrep file-index backend used by `@`-mention fuzzy search and
// directory listing. The fork enables hidden files by default so opencode-owned
// paths like `.opencode/plans` are mentionable, while a preset ignore list keeps
// noisy caches out of results. `ignoreFiles` adds extra gitignore-formatted
// ignore files to every ripgrep search (grep/glob tools included), additively
// over .gitignore/.ignore/.rgignore. Only the ripgrep backend honors these; the
// fff backend (default off on Windows) has no hidden toggle.
const SearchSchema = Schema.Struct({
  hidden: Schema.optional(Schema.Boolean).annotate({
    description:
      "Index hidden (dot-prefixed) files and directories for `@`-mention search. Default: true (fork override).",
  }),
  ignore: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "ripgrep glob patterns to exclude from the search index (e.g. `**/.cache/**`). Defaults to a preset covering common noisy hidden directories.",
  }),
  ignoreFiles: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Extra gitignore-formatted ignore files (e.g. `.opencodeignore`) applied to every search, additive over .gitignore/.ignore/.rgignore. Relative entries resolve against the searched directory; `~/`-prefixed entries against the home directory. File-level patterns share `.gitignore` semantics under an explicit glob include (directory patterns always prune). Default: none.",
  }),
})

/**
 * Default ignore preset applied when `search.hidden` is true. Keeps the most
 * common noisy hidden directories out of `@`-mention results while leaving
 * opencode-owned paths (`.opencode/**`) visible.
 */
export const DEFAULT_SEARCH_IGNORE = [
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/.cache/**",
  "**/.turbo/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.parcel-cache/**",
  "**/.svelte-kit/**",
  "**/.docusaurus/**",
  "**/.gradle/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/.DS_Store",
]

export const Info = Schema.Struct({
  plan: Schema.optional(PlanSchema).annotate({ description: "Plan-mode configuration" }),
  agent: Schema.optional(AgentSchema).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
  search: Schema.optional(SearchSchema).annotate({
    description: "File-search index options for `@`-mention (ripgrep backend).",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>

/** Resolve effective search options from fork config, applying fork defaults. Shape matches `FileSystemSearch.SearchConfigOptions`. */
export function resolveSearchConfig(info: Info) {
  const search = info.search ?? {}
  return {
    hidden: search.hidden ?? true,
    ignore: search.ignore ?? DEFAULT_SEARCH_IGNORE,
    ignoreFiles: search.ignoreFiles ?? [],
  }
}

function mergeFork(target: Info, source: Info): Info {
  const merge = (a: unknown, b: unknown): unknown => {
    if (
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const out: Record<string, unknown> = { ...a }
      for (const [key, value] of Object.entries(b as Record<string, unknown>)) out[key] = merge(out[key], value)
      return out
    }
    return b === undefined ? a : b
  }
  return merge(target, source) as Info
}

const global = roots("opencode")
// Honor OPENCODE_CONFIG_DIR the same way the Global service does.
const configDir = process.env.OPENCODE_CONFIG_DIR ?? global.config

const decodeInfo = Schema.decodeUnknownOption(Info, { onExcessProperty: "ignore" } as const)

const safeLoad = Effect.fnUntraced(function* (file: string) {
  // Missing/unreadable files resolve to undefined inside the promise so a
  // rejection never becomes a defect (Effect.promise rejections die).
  const text = yield* Effect.promise(() => fs.readFile(file, "utf8").then(undefined, () => undefined))
  if (text === undefined) return {}
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  const info = Option.getOrUndefined(decodeInfo(parsed))
  if (info) return info
  yield* Effect.logWarning("failed to load fork config", { path: file, errors: JSON.stringify(errors) })
  return {}
})

/**
 * Read only the global fork config files (`~/.config/opencode/opencode-fork.{jsonc,json}`).
 * Used at boot to apply settings that must take effect before any per-location
 * search index is built (e.g. `search`). Does not require a location context.
 */
export const loadGlobal = Effect.fnUntraced(function* () {
  let result: Info = {}
  for (const file of [path.join(configDir, "opencode-fork.jsonc"), path.join(configDir, "opencode-fork.json")]) {
    result = mergeFork(result, yield* safeLoad(file))
  }
  return result
})

// Walk up from the location collecting `.opencode/opencode-fork.{json,jsonc}` files,
// root-most first so the closest project wins when merged in order.
function projectForkFiles(directory: string): string[] {
  const files: string[] = []
  let current = path.resolve(directory)
  while (true) {
    for (const name of ["opencode-fork.json", "opencode-fork.jsonc"]) {
      files.push(path.join(current, ".opencode", name))
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return files.reverse()
}

/** Global fork config merged with the location's project-local fork config (closest project wins). */
export const loadForLocation = Effect.fnUntraced(function* (location: Location.Info) {
  let result: Info = yield* loadGlobal()
  for (const file of projectForkFiles(location.directory)) {
    result = mergeFork(result, yield* safeLoad(file))
  }
  return result
})
