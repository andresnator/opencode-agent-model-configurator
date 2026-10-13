import type { AgentChange } from "./domain"
import { writeConfigChanges, type ConfigScope, type ConfigSnapshot, type PersistenceHooks, type RuntimePaths } from "./persistence"

export type ApplyOutcome = { file: string; hotApplied: boolean; detail?: string }
export type ApplyOptions = { forceWrite?: boolean }

/** V2 reload rebuilds every loaded location after the complete atomic file write. */
export async function applyConfigChanges(
  client: unknown,
  _scope: ConfigScope,
  _runtime: RuntimePaths,
  snapshot: ConfigSnapshot,
  changes: readonly AgentChange[],
  hooks: PersistenceHooks = {},
  options: ApplyOptions = {},
): Promise<ApplyOutcome> {
  const result = await writeConfigChanges(snapshot, changes, hooks, { force: options.forceWrite })
  const location = (client as { location?: { reload?: () => Promise<void> } } | undefined)?.location
  if (typeof location?.reload !== "function") {
    return { file: result.file, hotApplied: false, detail: "this OpenCode client does not expose configuration reload" }
  }
  try {
    await location.reload()
    return { file: result.file, hotApplied: true }
  } catch (error) {
    return { file: result.file, hotApplied: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
