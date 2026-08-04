import type { AgentChange } from "./domain"
import {
  readConfigSnapshot,
  writeConfigChanges,
  type ConfigScope,
  type ConfigSnapshot,
  type RuntimePaths,
} from "./persistence"

// Hot-apply mechanics validated on OpenCode 1.17.15 (see docs/hot-reload.md):
// - Project scope: POST /instance/dispose?directory= makes the next request rebuild
//   the instance from the on-disk project config.
// - Global scope: the global config is cached with an infinite TTL and no disposal
//   re-reads it; only PATCH /global/config that changes on-disk bytes invalidates
//   the cache (and disposes all instances). Its deep-merge cannot delete keys, so
//   removals are written locally first and ride the reload triggered by the PATCH.

export type ApplyOutcome = {
  file: string
  hotApplied: boolean
  detail?: string
}

export type HotApplyResult = { applied: true } | { applied: false; reason: string }

export type GlobalAgentPatch = {
  agent: Record<string, { model: string; variant?: string }>
}

export type GlobalHotApplyPlan =
  | { strategy: "patch"; preludeChanges: AgentChange[]; patch: GlobalAgentPatch; fallbackChanges: AgentChange[] }
  | { strategy: "write-only"; reason: string }

type FieldsResult = {
  data?: unknown
  error?: unknown
  response?: { status?: number }
}

// The TUI hands plugins the @opencode-ai/sdk/v2 client, whose generated groups
// take parameters directly (no hey-api {query}/{body} envelopes). The groups are
// class instances whose methods read this.client — always invoke them on their
// receiver; a detached call throws "undefined is not an object".
type HotApplyClient = {
  instance?: {
    dispose?: (parameters: { directory: string }) => Promise<FieldsResult>
  }
  global?: {
    config?: {
      update?: (parameters: { config: unknown }) => Promise<FieldsResult>
    }
  }
}

export async function applyConfigChanges(
  client: unknown,
  scope: ConfigScope,
  runtime: RuntimePaths,
  snapshot: ConfigSnapshot,
  changes: readonly AgentChange[],
): Promise<ApplyOutcome> {
  if (scope === "project") {
    const result = await writeConfigChanges(snapshot, changes)
    const hot = await disposeProjectInstance(client, runtime)
    return outcome(result.file, hot)
  }

  const plan = planGlobalHotApply(changes)
  if (plan.strategy === "write-only") {
    const result = await writeConfigChanges(snapshot, changes)
    return { file: result.file, hotApplied: false, detail: plan.reason }
  }

  await writeConfigChanges(snapshot, plan.preludeChanges)
  const hot = await patchGlobalConfig(client, plan.patch)
  if (hot.applied) return { file: snapshot.file, hotApplied: true }

  const fresh = await readConfigSnapshot(snapshot.file)
  const result = await writeConfigChanges(fresh, plan.fallbackChanges)
  return outcome(result.file, hot)
}

export function planGlobalHotApply(changes: readonly AgentChange[]): GlobalHotApplyPlan {
  const sets = changes.filter((change) => change.action === "set" && change.after.model !== undefined)
  // The PATCH only reloads the global config when it changes on-disk bytes, so it
  // needs at least one leaf whose value differs from what is already written.
  const effective = sets.some(
    (change) =>
      change.after.model !== change.before.model ||
      (change.after.variant !== undefined && change.after.variant !== change.before.variant),
  )
  if (!effective) {
    return { strategy: "write-only", reason: "removal-only changes cannot be hot-applied at global scope" }
  }

  const preludeChanges: AgentChange[] = changes.filter((change) => change.action === "inherit")
  for (const change of sets) {
    if (change.before.variant === undefined || change.after.variant !== undefined || change.before.model === undefined) continue
    // Deep-merge cannot delete the stale variant key; drop it locally and let the
    // PATCH below set the model and trigger the reload that picks the deletion up.
    preludeChanges.push({ agent: change.agent, before: change.before, after: { model: change.before.model }, action: "set" })
  }

  const agent: GlobalAgentPatch["agent"] = {}
  for (const change of sets) {
    const model = change.after.model
    if (model === undefined) continue
    agent[change.agent] = change.after.variant === undefined ? { model } : { model, variant: change.after.variant }
  }
  return { strategy: "patch", preludeChanges, patch: { agent }, fallbackChanges: sets }
}

export async function disposeProjectInstance(client: unknown, runtime: RuntimePaths): Promise<HotApplyResult> {
  const instance = asHotApplyClient(client)?.instance
  if (typeof instance?.dispose !== "function") {
    return { applied: false, reason: "this OpenCode client does not expose instance disposal" }
  }
  const directory = runtime.directory || runtime.worktree
  if (!directory) return { applied: false, reason: "the project instance directory is unknown" }
  try {
    const result = await instance.dispose({ directory })
    if (result?.error !== undefined || result?.data !== true) {
      return { applied: false, reason: rejectionReason("instance disposal", result) }
    }
    return { applied: true }
  } catch (error) {
    return { applied: false, reason: errorReason(error) }
  }
}

export async function patchGlobalConfig(client: unknown, patch: GlobalAgentPatch): Promise<HotApplyResult> {
  const config = asHotApplyClient(client)?.global?.config
  if (typeof config?.update !== "function") {
    return { applied: false, reason: "this OpenCode client does not expose the global config route" }
  }
  try {
    const result = await config.update({ config: patch })
    if (result?.error !== undefined || result?.data === undefined) {
      return { applied: false, reason: rejectionReason("global config update", result) }
    }
    return { applied: true }
  } catch (error) {
    return { applied: false, reason: errorReason(error) }
  }
}

function outcome(file: string, hot: HotApplyResult): ApplyOutcome {
  return hot.applied ? { file, hotApplied: true } : { file, hotApplied: false, detail: hot.reason }
}

function asHotApplyClient(client: unknown): HotApplyClient | undefined {
  return typeof client === "object" && client !== null ? (client as HotApplyClient) : undefined
}

function rejectionReason(operation: string, result: FieldsResult | undefined): string {
  const status = result?.response?.status
  return typeof status === "number" ? `${operation} failed with status ${status}` : `${operation} was rejected`
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown hot-apply error"
}
