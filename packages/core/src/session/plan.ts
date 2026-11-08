export * as SessionPlan from "./plan.js"

import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import type { Location } from "@opencode/schema/location"
import { ConfigFork } from "../config/fork.js"
import { PlanPath } from "./plan-path.js"

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function namePattern(template: string, input?: { slug: string; id: string }) {
  const source = template
    .split(/(\$\{iteration\}|\$\{slug\}|\$\{sessionId\})/g)
    .map((part) => {
      if (part === "${iteration}") return "(?<iteration>\\d+(?:\\.\\d+)*)"
      if (part === "${slug}") return input ? escapeRegExp(input.slug) : "[^/\\\\]+?"
      if (part === "${sessionId}") return input ? escapeRegExp(input.id) : "[^/\\\\]+?"
      return escapeRegExp(part)
    })
    .join("")
  return new RegExp(`^${source}$`)
}

export function matchIteration(filepath: string, template: string) {
  return path.basename(filepath).match(namePattern(template))?.groups?.iteration
}

function matchesName(filepath: string, template: string, input: { slug: string; id: string }) {
  return namePattern(template, input).test(path.basename(filepath))
}

function renderName(template: string, vars: { iteration: string; slug: string; id: string }) {
  return template
    .replaceAll("${iteration}", vars.iteration)
    .replaceAll("${slug}", vars.slug)
    .replaceAll("${sessionId}", vars.id)
}

function isSafePlanName(name: string) {
  return name.endsWith(".md") && name === path.basename(name) && name === path.posix.basename(name)
}

// Iterations are dotted hierarchical strings: "00" (top level), "00.01" (subplan of 00),
// "00.01.02" (subplan of 00.01), etc. Each segment is zero-padded to 2 digits.

function iterationsIn(files: string[], template: string): string[] {
  return files.flatMap((file) => {
    const iteration = matchIteration(file, template)
    return iteration ? [iteration] : []
  })
}

export function nextIteration(iterations: string[]): string {
  // Next top-level iteration, ignoring subplans. Top-level plans are zero-indexed
  // ("00" first). Subplan numbering is supplied by the agent via dotted filenames.
  let max = -1
  for (const iteration of iterations) {
    if (iteration.split(".").length !== 1) continue
    const n = Number(iteration)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return String(max + 1).padStart(2, "0")
}

function isTopLevel(iteration: string | undefined): boolean {
  return !!iteration && iteration.split(".").length === 1
}

// For a subplan iteration like "00.01", return the absolute path of its parent
// plan (the file whose iteration is "00"). Returns undefined for top-level plans
// or when no matching parent file is present.
function parentPlanFile(files: string[], iteration: string, template: string): string | undefined {
  const parts = iteration.split(".")
  if (parts.length < 2) return undefined
  const parentIter = parts.slice(0, -1).join(".")
  return files.find((file) => matchIteration(file, template) === parentIter)
}

// v2 sessions carry no slug; derive one from the title, falling back to the id tail.
function slugOf(input: { id: string; title?: string }) {
  const slug = input.title
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || input.id.slice(-8)
}

const listPlanFiles = (dir: string) =>
  // Swallow readdir failures (e.g. missing plan dir on a fresh worktree) inside
  // the promise: a rejection in Effect.promise is a defect, so orElseSucceed
  // on the outside could never catch it (same idiom as ConfigFork loaders).
  Effect.promise(() => fs.readdir(dir).then(undefined, () => [] as string[])).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.endsWith(".md")).map((entry) => path.join(dir, entry))),
  )

export const fileExists = (file: string) => Effect.promise(() => fs.stat(file).then(() => true, () => false))

export const plan = Effect.fn("SessionPlan.plan")(function* (
  input: { id: string; title?: string; metadata?: Record<string, unknown> },
  location: Location.Info,
  fork: ConfigFork.Info,
  options?: { forceNew?: boolean; name?: string },
) {
  const dir = PlanPath.resolveDir(fork.plan?.path, location)

  const nameTemplate = fork.plan?.name ?? "${iteration}-${slug}.md"
  const slug = slugOf(input)
  const files = yield* listPlanFiles(dir)

  // Attach the parent plan path when the resolved plan is a subplan (dotted iteration).
  const finalize = (pathValue: string, iterationValue: string) => ({
    path: pathValue,
    iteration: iterationValue,
    parent: parentPlanFile(files, iterationValue, nameTemplate),
  })

  // Agent-supplied name: use it verbatim when it is a safe markdown basename. A
  // dotted name (e.g. 00.01-x.md) makes this a subplan; a plain name is a new
  // top-level plan. The agent decides by the filename it passes.
  if (options?.name) {
    if (isSafePlanName(options.name)) {
      return finalize(path.join(dir, options.name), matchIteration(options.name, nameTemplate) ?? "00")
    }
    yield* Effect.logWarning("unsafe plan name, falling back to convention", { name: options.name })
  }

  if (!options?.forceNew) {
    const pointer = input.metadata?.activePlanPath
    if (typeof pointer === "string" && pointer) {
      const exists = yield* fileExists(pointer)
      if (exists) return finalize(pointer, matchIteration(pointer, nameTemplate) ?? "00")
    }

    // Slug/id fallback: prefer a top-level plan so a stray subplan never shadows the main plan.
    const existing = files.find((file) => {
      if (!matchesName(file, nameTemplate, { slug, id: input.id })) return false
      return isTopLevel(matchIteration(file, nameTemplate))
    })
    if (existing) return finalize(existing, matchIteration(existing, nameTemplate) ?? "00")
  }

  const iteration = nextIteration(iterationsIn(files, nameTemplate))
  const name = renderName(nameTemplate, { iteration, slug, id: input.id })
  if (isSafePlanName(name)) return finalize(path.join(dir, name), iteration)

  yield* Effect.logWarning("invalid plan filename template, using default", { template: nameTemplate, name })
  const fallback = renderName("${iteration}-${slug}.md", { iteration, slug, id: input.id })
  const safe = isSafePlanName(fallback) ? fallback : `${iteration}-plan.md`
  return finalize(path.join(dir, safe), iteration)
})

export function describeNameTemplate(template: string) {
  return template
    .replaceAll("${iteration}", "<iteration>")
    .replaceAll("${slug}", "<slug>")
    .replaceAll("${sessionId}", "<sessionId>")
}
