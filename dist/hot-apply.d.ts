import type { AgentChange } from "./domain";
import { type ConfigScope, type ConfigSnapshot, type PersistenceHooks, type RuntimePaths } from "./persistence";
export type ApplyOutcome = {
    file: string;
    hotApplied: boolean;
    detail?: string;
};
export type ApplyOptions = {
    forceWrite?: boolean;
};
/** V2 reload rebuilds every loaded location after the complete atomic file write. */
export declare function applyConfigChanges(client: unknown, _scope: ConfigScope, _runtime: RuntimePaths, snapshot: ConfigSnapshot, changes: readonly AgentChange[], hooks?: PersistenceHooks, options?: ApplyOptions): Promise<ApplyOutcome>;
