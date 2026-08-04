export declare const DEFAULT_PROFILE_NAME = "default";
export type AgentMode = "primary" | "subagent" | "all";
export type TaskAction = "allow" | "deny" | "ask";
export type TaskRule = {
    pattern: string;
    action: TaskAction;
};
export type LiveAgent = {
    name: string;
    description?: string;
    mode: AgentMode;
    native: boolean;
    hidden: boolean;
    taskRules: TaskRule[];
};
export type AgentGroup = {
    parent: LiveAgent;
    children: LiveAgent[];
    openDelegation: boolean;
};
export type AgentHierarchy = {
    groups: AgentGroup[];
    otherSubagents: LiveAgent[];
};
export type AgentMapping = {
    model?: string;
    variant?: string;
};
export type AgentDecision = {
    action: "keep";
} | {
    action: "inherit";
} | {
    action: "set";
    model: string;
    variant?: string;
};
export type AgentChange = {
    agent: string;
    before: AgentMapping;
    after: AgentMapping;
    action: "inherit" | "set";
};
export type ModelOption = {
    id: string;
    variants: string[];
};
export type ProviderOption = {
    id: string;
    models: ModelOption[];
};
export type TierProfile = {
    description: string;
    variant?: string;
    agents: string[];
};
export type ModelProfile = {
    name: string;
    description: string;
    tiers: Record<string, TierProfile>;
};
export type ProfileValidation = {
    profile?: ModelProfile;
    errors: string[];
    warnings: string[];
};
export type ProfileFile = {
    path: string;
    profile: ModelProfile;
    warnings: string[];
};
export type InvalidProfile = {
    path: string;
    errors: string[];
};
export type ProfileLoad = {
    profiles: ProfileFile[];
    invalid: InvalidProfile[];
};
export declare function resolveProfilesRoot(moduleUrl: string, configuredProfilesDir?: string, baseDirectory?: string): Promise<string>;
/**
 * Normalizes the response of the OpenCode `GET /agent` endpoint, which already merges built-in,
 * repo and user agents. Entries without a usable name are skipped rather than aborting the wizard;
 * only an unusable envelope (an older server that cannot answer at all) throws.
 */
export declare function normalizeLiveAgents(result: unknown): LiveAgent[];
export declare function visibleAgents(agents: readonly LiveAgent[], showHidden: boolean): LiveAgent[];
/** Mirrors OpenCode's permission evaluation: the last matching rule wins, absent rules allow. */
export declare function effectiveTaskAction(rules: readonly TaskRule[], subagent: string): TaskRule;
/**
 * Builds the parent/child view of the live agent list. A subagent is a child of a primary only when
 * a rule with a specific pattern permits it, so a primary that simply inherits the catch-all `allow`
 * (every built-in) is flagged as open delegation instead of adopting every subagent on the server.
 */
export declare function buildAgentHierarchy(agents: readonly LiveAgent[]): AgentHierarchy;
/** Anchored glob match with OpenCode's semantics: `*` spans anything, `?` spans one character. */
export declare function wildcardMatch(value: string, pattern: string): boolean;
export declare function loadProfiles(profilesRoot: string, agents: readonly string[]): Promise<ProfileLoad>;
export declare function validateProfile(raw: unknown, agents: readonly string[]): ProfileValidation;
export declare function normalizeProviderCatalog(result: unknown): ProviderOption[];
export declare function flattenModels(providers: readonly ProviderOption[]): ModelOption[];
export declare function calculateChanges(current: Readonly<Record<string, AgentMapping>>, decisions: ReadonlyMap<string, AgentDecision>): AgentChange[];
export declare function formatMapping(mapping: AgentMapping): string;
