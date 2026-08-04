import type { AgentChange, AgentMapping } from "./domain";
export type ConfigScope = "global" | "project";
export type RuntimePaths = {
    config: string;
    worktree: string;
    directory: string;
};
export type ConfigSnapshot = {
    file: string;
    exists: boolean;
    content: string;
    mode: number;
    mappings: Record<string, AgentMapping>;
};
export type WriteResult = {
    file: string;
};
export type PersistenceStep = "temporary-open" | "temporary-write" | "temporary-flush" | "rename" | "destination-flush" | "post-validate";
export type PersistenceHooks = {
    before?: (step: PersistenceStep) => void | Promise<void>;
};
export declare function resolveConfigFile(scope: ConfigScope, runtime: RuntimePaths): Promise<string>;
export declare function readConfigSnapshot(file: string): Promise<ConfigSnapshot>;
export declare function renderConfigChanges(snapshot: ConfigSnapshot, changes: readonly AgentChange[]): string;
export declare function writeConfigChanges(snapshot: ConfigSnapshot, changes: readonly AgentChange[], hooks?: PersistenceHooks): Promise<WriteResult>;
export declare function higherPrecedenceWarning(): string | undefined;
export declare function globalConfigRoot(runtime: RuntimePaths): string;
export declare function displayConfigFile(scope: ConfigScope, file: string, runtime: RuntimePaths): string;
