import { readdir, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_PROFILE_NAME = "default"

const AGENT_LIST_ERROR = "This OpenCode server did not return an agent list (GET /agent). Update OpenCode and retry."

export type AgentMode = "primary" | "subagent" | "all"

export type TaskAction = "allow" | "deny" | "ask"

export type TaskRule = {
  pattern: string
  action: TaskAction
}

export type LiveAgent = {
  name: string
  description?: string
  mode: AgentMode
  native: boolean
  hidden: boolean
  taskRules: TaskRule[]
}

export type AgentGroup = {
  parent: LiveAgent
  children: LiveAgent[]
  openDelegation: boolean
}

export type AgentHierarchy = {
  groups: AgentGroup[]
  otherSubagents: LiveAgent[]
}

export type AgentMapping = {
  model?: string
  variant?: string
}

export type AgentDecision =
  | { action: "keep" }
  | { action: "inherit" }
  | { action: "set"; model: string; variant?: string }

export type AgentChange = {
  agent: string
  before: AgentMapping
  after: AgentMapping
  action: "inherit" | "set"
}

export type ModelOption = {
  id: string
  variants: string[]
}

export type ProviderOption = {
  id: string
  models: ModelOption[]
}

export type TierProfile = {
  description: string
  variant?: string
  agents: string[]
}

export type ModelProfile = {
  name: string
  description: string
  tiers: Record<string, TierProfile>
}

export type ProfileValidation = {
  profile?: ModelProfile
  errors: string[]
  warnings: string[]
}

export type ProfileFile = {
  path: string
  profile: ModelProfile
  warnings: string[]
}

export type InvalidProfile = {
  path: string
  errors: string[]
}

export type ProfileLoad = {
  profiles: ProfileFile[]
  invalid: InvalidProfile[]
}

export async function resolveProfilesRoot(
  moduleUrl: string,
  configuredProfilesDir?: string,
  baseDirectory: string = process.cwd(),
): Promise<string> {
  if (configuredProfilesDir) {
    if (configuredProfilesDir.startsWith("file://")) return fileURLToPath(configuredProfilesDir)
    if (configuredProfilesDir === "~") return homedir()
    if (configuredProfilesDir.startsWith(`~${path.sep}`)) {
      return path.join(homedir(), configuredProfilesDir.slice(2))
    }
    return path.resolve(baseDirectory, configuredProfilesDir)
  }
  return path.join(path.dirname(await realpath(fileURLToPath(moduleUrl))), "profiles")
}

/**
 * Normalizes the response of the OpenCode `GET /agent` endpoint, which already merges built-in,
 * repo and user agents. Entries without a usable name are skipped rather than aborting the wizard;
 * only an unusable envelope (an older server that cannot answer at all) throws.
 */
export function normalizeLiveAgents(result: unknown): LiveAgent[] {
  const root = isRecord(result) && "data" in result ? result.data : result
  if (!Array.isArray(root)) throw new Error(AGENT_LIST_ERROR)

  const byName = new Map<string, LiveAgent>()
  for (const entry of root) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue
    const agent: LiveAgent = {
      name: entry.name,
      mode: entry.mode === "primary" || entry.mode === "all" ? entry.mode : "subagent",
      native: entry.native === true,
      hidden: entry.hidden === true,
      taskRules: normalizeTaskRules(entry.permission),
    }
    if (typeof entry.description === "string" && entry.description.length > 0) agent.description = entry.description
    byName.set(agent.name, agent)
  }
  return [...byName.values()].sort(byAgentName)
}

export function visibleAgents(agents: readonly LiveAgent[], showHidden: boolean): LiveAgent[] {
  return showHidden ? [...agents] : agents.filter((agent) => !agent.hidden)
}

/** Mirrors OpenCode's permission evaluation: the last matching rule wins, absent rules allow. */
export function effectiveTaskAction(rules: readonly TaskRule[], subagent: string): TaskRule {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (wildcardMatch(subagent, rules[index].pattern)) return rules[index]
  }
  return { pattern: "*", action: "allow" }
}

/**
 * Builds the parent/child view of the live agent list. A subagent is a child of a primary only when
 * a rule with a specific pattern permits it, so a primary that simply inherits the catch-all `allow`
 * (every built-in) is flagged as open delegation instead of adopting every subagent on the server.
 */
export function buildAgentHierarchy(agents: readonly LiveAgent[]): AgentHierarchy {
  const parents = agents.filter((agent) => agent.mode === "primary" || agent.mode === "all")
  const delegable = agents.filter((agent) => agent.mode === "subagent" || agent.mode === "all")
  const claimed = new Set<string>()

  const groups = parents
    .map((parent) => {
      const children: LiveAgent[] = []
      for (const candidate of delegable) {
        if (candidate.name === parent.name) continue
        const rule = effectiveTaskAction(parent.taskRules, candidate.name)
        if (rule.action === "deny" || rule.pattern === "*") continue
        children.push(candidate)
        claimed.add(candidate.name)
      }
      return {
        parent,
        children: children.sort(byAgentName),
        openDelegation: catchAllTaskAction(parent.taskRules) !== "deny",
      }
    })
    .sort(
      (left, right) =>
        Number(left.parent.native) - Number(right.parent.native) || left.parent.name.localeCompare(right.parent.name),
    )

  const otherSubagents = agents
    .filter((agent) => agent.mode === "subagent" && !claimed.has(agent.name))
    .sort(byAgentName)

  return { groups, otherSubagents }
}

/** Anchored glob match with OpenCode's semantics: `*` spans anything, `?` spans one character. */
export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${source}$`, "s").test(value)
}

export async function loadProfiles(profilesRoot: string, agents: readonly string[]): Promise<ProfileLoad> {
  let entries
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissingPath(error)) return { profiles: [], invalid: [] }
    throw error
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))

  const profiles: ProfileFile[] = []
  const invalid: InvalidProfile[] = []
  for (const file of files) {
    const profilePath = path.join(profilesRoot, file.name)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(profilePath, "utf8")) as unknown
    } catch (error) {
      invalid.push({ path: profilePath, errors: [error instanceof Error ? error.message : "unreadable profile"] })
      continue
    }
    const validation = validateProfile(raw, agents)
    if (!validation.profile) {
      invalid.push({ path: profilePath, errors: validation.errors })
      continue
    }
    profiles.push({ path: profilePath, profile: validation.profile, warnings: validation.warnings })
  }
  return { profiles, invalid }
}

export function validateProfile(raw: unknown, agents: readonly string[]): ProfileValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(raw)) return { errors: ["profile must be an object"], warnings }
  if (!isRecord(raw.tiers)) return { errors: ["profile must contain a tiers object"], warnings }

  const knownAgents = new Set(agents)
  const coveredAgents = new Set<string>()
  const tiers: Record<string, TierProfile> = {}

  for (const [tierName, tierValue] of Object.entries(raw.tiers)) {
    if (!isRecord(tierValue) || !Array.isArray(tierValue.agents)) {
      errors.push(`tier '${tierName}' must contain an agents array`)
      continue
    }
    const tierAgents = tierValue.agents.filter((agent): agent is string => typeof agent === "string")
    if (tierAgents.length !== tierValue.agents.length) errors.push(`tier '${tierName}' contains a non-string agent`)
    // Unknown agents only warn: a profile authored for the full harness stays usable on a partial install.
    const unknown: string[] = []
    const knownTierAgents: string[] = []
    for (const agent of tierAgents) {
      if (!knownAgents.has(agent)) {
        unknown.push(agent)
        continue
      }
      if (coveredAgents.has(agent)) errors.push(`agent '${agent}' appears in more than one tier`)
      coveredAgents.add(agent)
      knownTierAgents.push(agent)
    }
    if (unknown.length > 0) warnings.push(`tier '${tierName}' skips agents missing on this server: ${unknown.join(", ")}`)
    const tier: TierProfile = {
      description: typeof tierValue.description === "string" ? tierValue.description : "",
      agents: knownTierAgents,
    }
    if (typeof tierValue.variant === "string") tier.variant = tierValue.variant
    tiers[tierName] = tier
  }

  if (errors.length > 0) return { errors, warnings }

  return {
    profile: {
      name: typeof raw.name === "string" ? raw.name : "unnamed",
      description: typeof raw.description === "string" ? raw.description : "",
      tiers,
    },
    errors,
    warnings,
  }
}

export function normalizeProviderCatalog(result: unknown): ProviderOption[] {
  const root = isRecord(result) && "data" in result ? result.data : result
  if (!isRecord(root)) return []

  const connected = new Set(
    Array.isArray(root.connected) ? root.connected.filter((provider): provider is string => typeof provider === "string") : [],
  )
  const providers = Array.isArray(root.all) ? root.all : []

  return providers
    .filter(isRecord)
    .filter((provider) => typeof provider.id === "string" && connected.has(provider.id))
    .map((provider) => ({ id: provider.id as string, models: normalizeModels(provider.models) }))
    .filter((provider) => provider.models.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function flattenModels(providers: readonly ProviderOption[]): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({ id: `${provider.id}/${model.id}`, variants: model.variants })),
  )
}

export function calculateChanges(
  current: Readonly<Record<string, AgentMapping>>,
  decisions: ReadonlyMap<string, AgentDecision>,
): AgentChange[] {
  const changes: AgentChange[] = []
  for (const [agent, decision] of decisions) {
    if (decision.action === "keep") continue
    const before = normalizeMapping(current[agent])
    const after =
      decision.action === "inherit"
        ? {}
        : decision.variant
          ? { model: decision.model, variant: decision.variant }
          : { model: decision.model }
    if (sameMapping(before, after)) continue
    changes.push({ agent, before, after, action: decision.action })
  }
  return changes.sort((left, right) => left.agent.localeCompare(right.agent))
}

export function formatMapping(mapping: AgentMapping): string {
  if (!mapping.model) return "inherits"
  return mapping.variant ? `${mapping.model} @${mapping.variant}` : mapping.model
}

function normalizeTaskRules(raw: unknown): TaskRule[] {
  if (!Array.isArray(raw)) return []
  const rules: TaskRule[] = []
  for (const rule of raw) {
    if (!isRecord(rule) || typeof rule.permission !== "string" || typeof rule.pattern !== "string") continue
    if (!wildcardMatch("task", rule.permission)) continue
    if (rule.action !== "allow" && rule.action !== "deny" && rule.action !== "ask") continue
    rules.push({ pattern: rule.pattern, action: rule.action })
  }
  return rules
}

function catchAllTaskAction(rules: readonly TaskRule[]): TaskAction {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (rules[index].pattern === "*") return rules[index].action
  }
  return "allow"
}

function byAgentName(left: LiveAgent, right: LiveAgent): number {
  return left.name.localeCompare(right.name)
}

function isMissingPath(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

function normalizeModels(raw: unknown): ModelOption[] {
  const entries = Array.isArray(raw)
    ? raw.filter(isRecord).map((model) => [model.id, model] as const)
    : isRecord(raw)
      ? Object.entries(raw)
      : []

  return entries
    .filter((entry): entry is readonly [string, Record<string, unknown>] => typeof entry[0] === "string" && isRecord(entry[1]))
    .map(([id, model]) => ({ id, variants: normalizeVariants(model.variants) }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function normalizeVariants(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((variant): variant is string => typeof variant === "string").sort()
  if (isRecord(raw)) return Object.keys(raw).sort()
  return []
}

function normalizeMapping(mapping: AgentMapping | undefined): AgentMapping {
  if (!mapping?.model) return {}
  return mapping.variant ? { model: mapping.model, variant: mapping.variant } : { model: mapping.model }
}

function sameMapping(left: AgentMapping, right: AgentMapping): boolean {
  return left.model === right.model && left.variant === right.variant
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
