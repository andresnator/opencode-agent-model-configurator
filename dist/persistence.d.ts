import type { AgentChange, AgentMapping } from "./domain";
declare const CONFIG_WRITE_OWNERSHIP: unique symbol;
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
type WriteArtifacts = {
    directory: string;
    temporary: string;
    claim: string;
    recovery: string;
};
type ConfigWriteOwnershipState = {
    snapshot: ConfigSnapshot;
    content: string;
    mode: number;
    artifacts: WriteArtifacts;
    active: boolean;
};
export type ConfigWriteOwnership = {
    readonly file: string;
    readonly [CONFIG_WRITE_OWNERSHIP]: ConfigWriteOwnershipState;
};
export declare function resolveConfigFile(scope: ConfigScope, runtime: RuntimePaths): Promise<string>;
export declare function readConfigSnapshot(file: string): Promise<ConfigSnapshot>;
export declare function renderConfigChanges(snapshot: ConfigSnapshot, changes: readonly AgentChange[]): string;
export declare function writeConfigChanges(snapshot: ConfigSnapshot, changes: readonly AgentChange[], hooks?: PersistenceHooks): Promise<WriteResult>;
export declare function writeConfigChangesWithOwnership(snapshot: ConfigSnapshot, changes: readonly AgentChange[], hooks?: PersistenceHooks): Promise<ConfigWriteOwnership | undefined>;
export declare function writeConfigChangesFromOwnership(ownership: ConfigWriteOwnership, changes: readonly AgentChange[], hooks?: PersistenceHooks): Promise<WriteResult>;
export declare function releaseConfigWriteOwnership(ownership: ConfigWriteOwnership): Promise<void>;
export declare function restoreOwnedConfigSnapshot(ownership: ConfigWriteOwnership): Promise<void>;
export declare function isConfigWriteConflictError(error: unknown): boolean;
export declare function restoreConfigSnapshot(snapshot: ConfigSnapshot, expectedContent: string): Promise<void>;
export declare function higherPrecedenceWarning(): string | undefined;
export declare function globalConfigRoot(runtime: RuntimePaths): string;
export declare function displayConfigFile(scope: ConfigScope, file: string, runtime: RuntimePaths): string;
export {};
