export * as ConfigFork from "./fork"

import path from "path"
import { mergeDeep } from "remeda"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"

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
  template: Schema.optional(Schema.String).annotate({
    description:
      "Path to a plan-file template used to seed new plan files. Supports ~ and relative-to-project paths. Variables: ${title}, ${slug}, ${iteration}, ${timestamp}, ${parent}.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "Inline plan-mode reminder prompt. Supports a ${planInfo} placeholder (resolved to the plan-file status line).",
  }),
})

// Mirrors opencode.json's `agent` section so the fork can configure agents (including plan)
// via JSON without affecting a coexisting vanilla opencode.
const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    plan: Schema.optional(ConfigAgentV1.Info),
    build: Schema.optional(ConfigAgentV1.Info),
    general: Schema.optional(ConfigAgentV1.Info),
    explore: Schema.optional(ConfigAgentV1.Info),
    title: Schema.optional(ConfigAgentV1.Info),
    summary: Schema.optional(ConfigAgentV1.Info),
    compaction: Schema.optional(ConfigAgentV1.Info),
  }),
  [Schema.Record(Schema.String, ConfigAgentV1.Info)],
)

export const Info = Schema.Struct({
  plan: Schema.optional(PlanSchema).annotate({ description: "Plan-mode configuration" }),
  agent: Schema.optional(AgentSchema).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
}).annotate({ identifier: "ConfigFork" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  readonly get: () => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ForkConfig") {}

export const use = serviceUse(Service)

function mergeFork(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

const loadFile = Effect.fnUntraced(function* (filepath: string) {
  const fs = yield* FSUtil.Service
  yield* Effect.logDebug("loading fork config", { path: filepath })
  const text = yield* fs.readFileStringSafe(filepath)
  if (!text) return {} as Info
  const parsed = ConfigParse.jsonc(text, filepath)
  return ConfigParse.schema(Info, parsed, filepath)
})

const loadInstanceState = Effect.fnUntraced(function* (ctx: InstanceContext) {
  let result: Info = {}

  const safe = <E, R>(filepath: string, eff: Effect.Effect<Info, E, R>) =>
    eff.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to load fork config", { path: filepath, error: String(error) }).pipe(
          Effect.as({} as Info),
        ),
      ),
    )

  for (const file of [
    path.join(Global.Path.config, "opencode-fork.jsonc"),
    path.join(Global.Path.config, "opencode-fork.json"),
  ]) {
    result = mergeFork(result, yield* safe(file, loadFile(file)))
  }

  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    for (const file of yield* ConfigPaths.files("opencode-fork", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
      result = mergeFork(result, yield* safe(file, loadFile(file)))
    }
  }

  const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)
  for (const dir of directories) {
    if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
      for (const file of ["opencode-fork.json", "opencode-fork.jsonc"]) {
        const filepath = path.join(dir, file)
        result = mergeFork(result, yield* safe(filepath, loadFile(filepath)))
      }
    }
  }

  return result
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const state = yield* InstanceState.make<Info>((ctx) =>
      loadInstanceState(ctx).pipe(
        Effect.tapError((error) => Effect.logError("failed to load fork config, using defaults", { error: String(error) })),
        Effect.orElseSucceed((): Info => ({} as Info)),
        Effect.provideService(FSUtil.Service, fs),
      ),
    )

    const get = Effect.fn("ConfigFork.get")(function* () {
      return yield* InstanceState.use(state, (s) => s)
    })

    return Service.of({ get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node])
