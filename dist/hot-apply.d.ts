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
export type HotApplyResult = {
    applied: true;
} | {
    applied: false;
    reason: string;
};
export type GlobalAgentPatch = {
    agent: Record<string, {
        model: string;
        variant?: string;
    }>;
};
export type GlobalHotApplyPlan = {
    strategy: "patch";
    preludeChanges: AgentChange[];
    patch: GlobalAgentPatch;
    fallbackChanges: AgentChange[];
} | {
    strategy: "write-only";
    reason: string;
};
export declare function applyConfigChanges(client: unknown, scope: ConfigScope, runtime: RuntimePaths, snapshot: ConfigSnapshot, changes: readonly AgentChange[], hooks?: PersistenceHooks, options?: ApplyOptions): Promise<ApplyOutcome>;
export declare function planGlobalHotApply(changes: readonly AgentChange[]): GlobalHotApplyPlan;
export declare function disposeProjectInstance(client: unknown, runtime: RuntimePaths): Promise<HotApplyResult>;
export declare function patchGlobalConfig(client: unknown, patch: GlobalAgentPatch): Promise<HotApplyResult>;
