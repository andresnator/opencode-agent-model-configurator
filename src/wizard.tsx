import type { TuiDialogSelectOption, TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  buildAgentHierarchy,
  calculateChanges,
  flattenModels,
  formatMapping,
  loadProfiles,
  normalizeLiveAgents,
  normalizeProviderCatalog,
  visibleAgents,
  type AgentDecision,
  type AgentMapping,
  type AgentMode,
  type LiveAgent,
  type ModelOption,
  type ProfileFile,
} from "./domain"
import { applyConfigChanges } from "./hot-apply"
import {
  displayConfigFile,
  higherPrecedenceWarning,
  readConfigSnapshot,
  resolveConfigFile,
  type ConfigScope,
  type ConfigSnapshot,
} from "./persistence"
import {
  deletePreset,
  loadPresets,
  partitionPresetAssignments,
  presetsFile,
  savePreset,
  type PresetAssignment,
  type StoredPreset,
} from "./presets"

const DONE = "__done__"
const ALL_AGENTS = "__all_agents__"
const KEEP_CURRENT = "__keep_current__"
const USE_TIER = "__use_tier__"
const INHERIT = "__inherit__"
const NO_VARIANT = "__no_variant__"
const NEXT_AGENT = "__next_agent__"
const PREV_AGENT = "__prev_agent__"
const OVERRIDE_YES = "__override_yes__"
const OVERRIDE_NO = "__override_no__"
const APPLY = "__apply__"
const APPLY_SAVE = "__apply_save__"
const CANCEL = "__cancel__"
const APPLY_PRESET = "__apply_preset__"
const DELETE_PRESET = "__delete_preset__"
const OVERWRITE_PRESET = "__overwrite_preset__"
const RENAME_PRESET = "__rename_preset__"
const PRESET_PREFIX = "__preset__:"
const GROUP_PREFIX = "__group__:"
const OTHER_GROUP = "__other_subagents__"
const TOGGLE_HIDDEN = "__toggle_hidden__"
const REVIEW_CHANGES = "__review_changes__"
const BACK_HINT = "esc: back"
const CLOSE_HINT = "esc: close"
const AGENTS_HINT = "esc: back to agents"
const OTHER_GROUP_TITLE = "Other subagents"
let configuratorRunning = false

type StepOutcome = "next" | "back" | "exit" | "done"

/** One selectable block of the agent hub: a primary with its delegates, or the unclaimed bucket. */
type AgentSection = {
  key: string
  title: string
  description: string
  agents: LiveAgent[]
}

type WizardState = {
  agents: LiveAgent[]
  profiles: ProfileFile[]
  presets: StoredPreset[]
  presetStorageAvailable: boolean
  models: ModelOption[]
  presetsPath: string
  showHidden: boolean
  scope?: ConfigScope
  configFile?: string
  snapshot?: ConfigSnapshot
  source?: { kind: "profile" | "preset" | "agents" }
  selectedProfile?: ProfileFile
  tierDecisions?: Map<string, AgentDecision>
  decisions?: Map<string, AgentDecision>
}

type WizardStep = {
  skip?: (state: WizardState) => boolean
  run: (state: WizardState) => Promise<StepOutcome>
}

export async function runModelConfigurator(api: TuiPluginApi, profilesRoot: string): Promise<void> {
  if (configuratorRunning) {
    api.ui.toast({ variant: "warning", message: "The model configurator is already open." })
    return
  }
  configuratorRunning = true
  const previousDialogSize = api.ui.dialog.size
  try {
    if (!api.state.ready || !api.state.path.directory) {
      api.ui.toast({ variant: "warning", message: "OpenCode paths are still syncing. Try again in a moment." })
      return
    }
    api.ui.dialog.setSize("large")

    const agents = await loadAgents(api)
    if (agents.length === 0) {
      api.ui.toast({ variant: "warning", message: "This OpenCode server reported no agents to configure." })
      return
    }

    const { profiles, invalid } = await loadProfiles(profilesRoot, agents.map((agent) => agent.name))
    for (const entry of invalid) {
      api.ui.toast({ variant: "warning", message: `Skipped profile ${entry.path}: ${entry.errors.join("; ")}` })
    }
    const presetsPath = presetsFile(api.state.path)
    let presets: StoredPreset[] = []
    let presetStorageAvailable = true
    try {
      presets = await loadPresets(presetsPath)
    } catch (error) {
      presetStorageAvailable = false
      api.ui.toast({
        variant: "warning",
        message: `Preset storage unavailable at ${presetsPath}: ${errorMessage(error)} Repair the file and reopen the configurator.`,
      })
    }

    const catalog = await loadCatalog(api)
    if (catalog.length === 0) {
      api.ui.toast({ variant: "warning", message: "No connected providers with models are available. Connect one and retry." })
      return
    }
    const models = flattenModels(catalog)

    const state: WizardState = { agents, profiles, presets, presetStorageAvailable, models, presetsPath, showHidden: false }
    await runSteps(api, state)
  } catch (error) {
    api.ui.toast({ variant: "error", title: "Model configurator failed", message: errorMessage(error), duration: 8000 })
  } finally {
    api.ui.dialog.clear()
    api.ui.dialog.setSize(previousDialogSize)
    configuratorRunning = false
  }
}

async function runSteps(api: TuiPluginApi, state: WizardState): Promise<void> {
  const steps: WizardStep[] = [
    { run: (s) => runScopeStep(api, s) },
    { run: (s) => runHubStep(api, s) },
    { skip: (s) => s.source?.kind !== "profile", run: (s) => runTiersStep(api, s) },
    { skip: (s) => s.source?.kind !== "profile", run: (s) => runOverridesStep(api, s) },
    { run: (s) => runReviewStep(api, s) },
  ]

  let index = 0
  let direction: 1 | -1 = 1
  while (index >= 0 && index < steps.length) {
    const step = steps[index]
    if (step.skip?.(state)) {
      index += direction
      continue
    }
    const outcome = await step.run(state)
    if (outcome === "exit" || outcome === "done") return
    direction = outcome === "next" ? 1 : -1
    index += direction
  }
  // index < 0 → esc past the first step → exit silently
}

async function runScopeStep(api: TuiPluginApi, state: WizardState): Promise<StepOutcome> {
  const [projectFile, globalFile] = await Promise.all([
    resolveConfigFile("project", api.state.path),
    resolveConfigFile("global", api.state.path),
  ])
  const warning = higherPrecedenceWarning()
  const suffix = warning ? ` — ${warning}` : ""
  const scope = await select(
    api,
    "Configuration scope",
    [
      { title: "Project", value: "project", description: `${displayConfigFile("project", projectFile, api.state.path)}${suffix}` },
      { title: "Global", value: "global", description: `${displayConfigFile("global", globalFile, api.state.path)}${suffix}` },
    ],
    CLOSE_HINT,
    state.scope,
  )
  if (!scope) return "exit"
  state.scope = scope
  state.configFile = scope === "project" ? projectFile : globalFile
  state.snapshot = await readConfigSnapshot(state.configFile)
  return "next"
}

async function runHubStep(api: TuiPluginApi, state: WizardState): Promise<StepOutcome> {
  while (true) {
    const pending = state.decisions?.size ?? 0
    const options: TuiDialogSelectOption<string>[] = []
    if (pending > 0) {
      options.push({
        title: `Review ${pending} pending change${pending === 1 ? "" : "s"}`,
        value: REVIEW_CHANGES,
        description: "Continue to the apply confirmation",
      })
    }
    const sections = hubSections(state)
    for (const section of sections) {
      options.push({
        title: section.title,
        value: GROUP_PREFIX + section.key,
        description: section.description,
        category: "Agents",
      })
    }
    const hiddenCount = state.agents.filter((agent) => agent.hidden).length
    if (hiddenCount > 0) {
      options.push({
        title: state.showHidden ? "Hide internal agents" : "Show internal agents",
        value: TOGGLE_HIDDEN,
        description: `${hiddenCount} agent${hiddenCount === 1 ? "" : "s"} OpenCode marks as internal`,
        category: "Agents",
      })
    }
    for (const file of state.profiles) {
      options.push({
        title: file.profile.name,
        value: file.profile.name,
        description: file.profile.description,
        category: "Profiles",
      })
    }
    for (const preset of state.presets) {
      const count = Object.keys(preset.assignments).length
      const saved = preset.savedAt ? ` — saved ${preset.savedAt.slice(0, 10)}` : ""
      options.push({
        title: preset.name,
        value: PRESET_PREFIX + preset.name,
        description: `${count} agent${count === 1 ? "" : "s"}${saved}`,
        category: "Saved presets",
      })
    }

    const selected = await select(api, "Agents", options, BACK_HINT)
    if (!selected) return "back"

    if (selected === TOGGLE_HIDDEN) {
      state.showHidden = !state.showHidden
      continue
    }

    if (selected === REVIEW_CHANGES) {
      state.source = { kind: "agents" }
      return "next"
    }

    if (selected.startsWith(GROUP_PREFIX)) {
      const key = selected.slice(GROUP_PREFIX.length)
      const section = sections.find((entry) => entry.key === key)
      if (section) await runGroupAgentsLoop(api, state, section)
      continue
    }

    if (selected.startsWith(PRESET_PREFIX)) {
      const name = selected.slice(PRESET_PREFIX.length)
      const preset = state.presets.find((entry) => entry.name === name)
      if (!preset) continue
      const outcome = await handlePresetChoice(api, state, preset)
      if (outcome === "reshow") continue
      return outcome
    }

    const profileFile = state.profiles.find((file) => file.profile.name === selected)
    if (!profileFile) continue
    for (const warning of profileFile.warnings) api.ui.toast({ variant: "warning", message: warning })
    state.source = { kind: "profile" }
    state.selectedProfile = profileFile
    return "next"
  }
}

function hubSections(state: WizardState): AgentSection[] {
  const hierarchy = buildAgentHierarchy(visibleAgents(state.agents, state.showHidden))
  const sections: AgentSection[] = hierarchy.groups.map((group) => ({
    key: group.parent.name,
    title: group.parent.name,
    description: sectionDescription(group.children.length, group.openDelegation),
    agents: [group.parent, ...group.children],
  }))
  const others = hierarchy.otherSubagents
  if (others.length > 0) {
    sections.push({
      key: OTHER_GROUP,
      title: OTHER_GROUP_TITLE,
      description: `${others.length} subagent${others.length === 1 ? "" : "s"} no primary delegates to explicitly`,
      agents: others,
    })
  }
  return sections
}

function sectionDescription(children: number, openDelegation: boolean): string {
  if (children === 0) return openDelegation ? "Delegates to any subagent" : "No delegates"
  const base = `${children} subagent${children === 1 ? "" : "s"}`
  return openDelegation ? `${base} + any other subagent` : base
}

async function runGroupAgentsLoop(api: TuiPluginApi, state: WizardState, section: AgentSection): Promise<void> {
  const agents = section.agents
  const decisions = (state.decisions ??= new Map())
  const current = state.snapshot!.mappings

  while (true) {
    const selected = await select(
      api,
      section.title,
      [
        { title: "Done", value: DONE },
        { title: "All agents", value: ALL_AGENTS, description: "Set model/variant for every agent in this group" },
        ...agents.map((agent) => ({
          title: decisions.has(agent.name) ? `● ${agent.name}` : agent.name,
          value: agent.name,
          description: `${modeLetter(agent.mode)} ${decisionDisplay(decisions.get(agent.name), current[agent.name])}`,
        })),
      ],
      AGENTS_HINT,
    )
    if (!selected || selected === DONE) return

    if (selected === ALL_AGENTS) {
      const summary = agents.map((agent) => `${agent.name}: ${formatMapping(current[agent.name] ?? {})}`).join("; ")
      const decision = await selectDecision(api, `Configure every agent in ${section.title}`, state.models, undefined, summary)
      if (decision === undefined) continue
      if (decision.action === "keep") for (const agent of agents) decisions.delete(agent.name)
      else for (const agent of agents) decisions.set(agent.name, decision)
      continue
    }

    const decision = await selectDecision(
      api,
      `Configure: ${selected}`,
      state.models,
      undefined,
      formatMapping(current[selected] ?? {}),
    )
    if (decision === undefined) continue
    if (decision.action === "keep") decisions.delete(selected)
    else decisions.set(selected, decision)
  }
}

async function handlePresetChoice(api: TuiPluginApi, state: WizardState, preset: StoredPreset): Promise<StepOutcome | "reshow"> {
  const count = Object.keys(preset.assignments).length
  const action = await select(
    api,
    `Preset: ${preset.name}`,
    [
      { title: "Apply", value: APPLY_PRESET, description: `${count} agent${count === 1 ? "" : "s"}` },
      { title: "Delete", value: DELETE_PRESET, description: "Remove this saved preset" },
    ],
    BACK_HINT,
  )
  if (!action) return "reshow"

  if (action === DELETE_PRESET) {
    try {
      await deletePreset(state.presetsPath, preset.name)
    } catch (error) {
      state.presets = []
      state.presetStorageAvailable = false
      api.ui.toast({ variant: "error", title: "Preset not deleted", message: errorMessage(error), duration: 8000 })
      return "reshow"
    }
    state.presets = state.presets.filter((entry) => entry.name !== preset.name)
    api.ui.toast({ variant: "success", message: `Deleted preset "${preset.name}".` })
    return "reshow"
  }

  const { valid, stale } = partitionPresetAssignments(preset.assignments, state.agents.map((agent) => agent.name), state.models)
  if (Object.keys(valid).length === 0) {
    api.ui.toast({ variant: "warning", message: `Preset "${preset.name}" has no entries that match the live catalog.` })
    return "reshow"
  }
  if (stale.length > 0) {
    const proceed = await confirmStep(
      api,
      "Preset has stale entries",
      `These no longer match the live catalog and will be skipped: ${stale.join(", ")}. Apply the rest?`,
    )
    if (!proceed) return "reshow"
  }

  const decisions = new Map<string, AgentDecision>()
  for (const [agent, assignment] of Object.entries(valid)) {
    decisions.set(agent, { action: "set", model: assignment.model, variant: assignment.variant })
  }
  state.decisions = decisions
  state.tierDecisions = new Map()
  state.source = { kind: "preset" }
  return "next"
}

async function runTiersStep(api: TuiPluginApi, state: WizardState): Promise<StepOutcome> {
  const profile = state.selectedProfile!.profile
  const current = state.snapshot!.mappings
  const tiers = Object.entries(profile.tiers).filter(([, tier]) => tier.agents.length > 0)
  const tierDecisions = new Map<string, AgentDecision>()

  let i = 0
  while (i < tiers.length) {
    const [tierName, tier] = tiers[i]
    const currentSummary = tier.agents.map((agent) => `${agent}: ${formatMapping(current[agent] ?? {})}`).join("; ")
    const decision = await selectDecision(api, `Tier: ${tierName}`, state.models, tier.variant, currentSummary)
    if (decision === undefined) {
      if (i === 0) return "back"
      i -= 1
      for (const agent of tiers[i][1].agents) tierDecisions.delete(agent)
      continue
    }
    if (decision.action !== "keep") for (const agent of tier.agents) tierDecisions.set(agent, decision)
    else for (const agent of tier.agents) tierDecisions.delete(agent)
    i += 1
  }

  state.tierDecisions = tierDecisions
  state.decisions = new Map(tierDecisions)
  return "next"
}

async function runOverridesStep(api: TuiPluginApi, state: WizardState): Promise<StepOutcome> {
  // A Yes/No select (not a confirm) so esc is unambiguously "back one step" via the dialog stack's onClose.
  while (true) {
    const wants = await select(
      api,
      "Individual overrides",
      [
        { title: "Yes, override individual agents", value: OVERRIDE_YES },
        { title: "No, apply tier decisions as-is", value: OVERRIDE_NO },
      ],
      BACK_HINT,
    )
    if (wants === undefined) return "back"
    if (wants === OVERRIDE_NO) return "next"
    if (await runAgentOverrideLoop(api, state)) return "next"
    // esc at the agent chooser lands here → re-show the Yes/No prompt, keeping overrides made so far.
  }
}

async function runAgentOverrideLoop(api: TuiPluginApi, state: WizardState): Promise<boolean> {
  const agents = visibleAgents(state.agents, state.showHidden).map((agent) => agent.name)
  const decisions = state.decisions!
  const tierDecisions = state.tierDecisions!
  const current = state.snapshot!.mappings

  let focus: string | undefined
  while (true) {
    let selected: string | undefined
    if (focus) {
      selected = focus
      focus = undefined
    } else {
      selected = await select(
        api,
        "Choose agent to override",
        [
          { title: "Done", value: DONE },
          ...agents.map((agent) => ({ title: agent, value: agent, description: decisionDisplay(decisions.get(agent), current[agent]) })),
        ],
        BACK_HINT,
      )
      if (!selected) return false
      if (selected === DONE) return true
    }

    const agentIndex = agents.indexOf(selected)
    const action = await select(
      api,
      `Override: ${selected}`,
      [
        { title: "→ Next agent", value: NEXT_AGENT },
        { title: "← Prev agent", value: PREV_AGENT },
        { title: "Use tier decision", value: USE_TIER, description: decisionDisplay(tierDecisions.get(selected), current[selected]) },
        { title: "Keep current", value: KEEP_CURRENT, description: formatMapping(current[selected] ?? {}) },
        { title: "Inherit", value: INHERIT, description: "Remove model and variant at this scope" },
        ...state.models.map((model) => ({ title: model.id, value: model.id, description: variantDescription(model) })),
      ],
      BACK_HINT,
    )
    if (!action) continue
    if (action === NEXT_AGENT) {
      focus = agents[(agentIndex + 1) % agents.length]
      continue
    }
    if (action === PREV_AGENT) {
      focus = agents[(agentIndex - 1 + agents.length) % agents.length]
      continue
    }
    if (action === USE_TIER) {
      const tier = tierDecisions.get(selected)
      if (tier) decisions.set(selected, tier)
      else decisions.delete(selected)
    } else if (action === KEEP_CURRENT) {
      decisions.delete(selected)
    } else if (action === INHERIT) {
      decisions.set(selected, { action: "inherit" })
    } else {
      const model = state.models.find((candidate) => candidate.id === action)
      if (!model) continue
      const variant = await selectVariant(api, model)
      if (variant === undefined) {
        focus = selected
        continue
      }
      decisions.set(selected, { action: "set", model: model.id, variant: variant || undefined })
    }
  }
}

async function runReviewStep(api: TuiPluginApi, state: WizardState): Promise<StepOutcome> {
  const snapshot = state.snapshot!
  const decisions = state.decisions!
  const changes = calculateChanges(snapshot.mappings, decisions)
  if (changes.length === 0) {
    api.ui.toast({ variant: "info", message: "No model assignment changes selected." })
    return "back"
  }

  const refreshedModels = flattenModels(await loadCatalog(api))
  const stale = findStaleSelections(decisions, refreshedModels)
  if (stale.length > 0) {
    api.ui.toast({ variant: "warning", message: `Selections changed in the live catalog: ${stale.join(", ")}. Reopen and select again.` })
    return "exit"
  }

  const warning = higherPrecedenceWarning()
  const categoryOf = reviewCategories(state.agents)
  const rows = [...changes].sort(
    (left, right) =>
      (categoryOf.get(left.agent) ?? "other").localeCompare(categoryOf.get(right.agent) ?? "other") ||
      left.agent.localeCompare(right.agent),
  )
  const title = `Apply ${changes.length} model change${changes.length === 1 ? "" : "s"}?`
  const choice = await select(
    api,
    title,
    [
      { title: "Apply", value: APPLY, description: warning || undefined },
      {
        title: "Apply and save as preset",
        value: APPLY_SAVE,
        description: state.presetStorageAvailable ? undefined : "Repair preset storage and reopen the configurator to enable saving.",
        disabled: !state.presetStorageAvailable,
      },
      { title: "Cancel", value: CANCEL },
      ...rows.map((change) => ({
        title: change.agent,
        value: `__change__:${change.agent}`,
        description: `${formatMapping(change.before)} -> ${formatMapping(change.after)}`,
        category: categoryOf.get(change.agent) ?? "other",
        disabled: true,
      })),
    ],
    BACK_HINT,
  )
  if (!choice) return "back"
  if (choice === CANCEL) return "done"
  if (choice !== APPLY && choice !== APPLY_SAVE) return "back"
  if (choice === APPLY_SAVE && !state.presetStorageAvailable) return "back"

  let presetName: string | undefined
  if (choice === APPLY_SAVE) {
    presetName = await promptPresetName(api, state)
    if (presetName === undefined) return "back"
  }

  const result = await applyConfigChanges(api.client, state.scope!, api.state.path, snapshot, changes)
  api.ui.toast({
    variant: "success",
    title: "Agent models updated",
    message: result.hotApplied
      ? `Wrote ${result.file}. Applied live to this OpenCode server; other running OpenCode processes still need a restart.`
      : `Wrote ${result.file}. Restart OpenCode sessions to apply the assignments (${result.detail}).`,
    duration: 8000,
  })

  if (presetName !== undefined) {
    try {
      const assignments = resolvePresetAssignments(snapshot.mappings, changes, state.agents.map((agent) => agent.name))
      await savePreset(state.presetsPath, { name: presetName, savedAt: new Date().toISOString(), assignments })
      api.ui.toast({ variant: "success", message: `Saved preset "${presetName}".` })
    } catch (error) {
      state.presetStorageAvailable = false
      api.ui.toast({ variant: "error", title: "Preset not saved", message: errorMessage(error), duration: 8000 })
    }
  }
  return "done"
}

async function promptPresetName(api: TuiPluginApi, state: WizardState): Promise<string | undefined> {
  while (true) {
    const name = await prompt(api, "Preset name", "Name this preset")
    if (name === undefined) return undefined
    const trimmed = name.trim()
    if (!trimmed) {
      api.ui.toast({ variant: "warning", message: "Preset name cannot be empty." })
      continue
    }
    if (state.presets.some((entry) => entry.name === trimmed)) {
      const choice = await select(
        api,
        `Overwrite preset "${trimmed}"?`,
        [
          { title: "Overwrite", value: OVERWRITE_PRESET, description: "Replace the saved preset" },
          { title: "Choose another name", value: RENAME_PRESET },
        ],
        BACK_HINT,
      )
      if (choice !== OVERWRITE_PRESET) continue
    }
    return trimmed
  }
}

function resolvePresetAssignments(
  current: Readonly<Record<string, AgentMapping>>,
  changes: readonly { agent: string; after: AgentMapping }[],
  knownAgents: readonly string[],
): Record<string, PresetAssignment> {
  const known = new Set(knownAgents)
  const resolved = Object.assign(Object.create(null) as Record<string, AgentMapping>, current)
  for (const change of changes) resolved[change.agent] = change.after
  const assignments = Object.create(null) as Record<string, PresetAssignment>
  for (const [agent, mapping] of Object.entries(resolved)) {
    if (!known.has(agent) || !mapping.model) continue
    assignments[agent] = mapping.variant ? { model: mapping.model, variant: mapping.variant } : { model: mapping.model }
  }
  return assignments
}

async function selectDecision(
  api: TuiPluginApi,
  title: string,
  models: readonly ModelOption[],
  suggestedVariant: string | undefined,
  currentSummary: string,
): Promise<AgentDecision | undefined> {
  while (true) {
    const action = await select(
      api,
      title,
      [
        { title: "Keep current", value: KEEP_CURRENT, description: currentSummary },
        { title: "Inherit", value: INHERIT, description: "Remove model and variant at this scope" },
        ...models.map((model) => ({ title: model.id, value: model.id, description: variantDescription(model) })),
      ],
      BACK_HINT,
    )
    if (!action) return undefined
    if (action === KEEP_CURRENT) return { action: "keep" }
    if (action === INHERIT) return { action: "inherit" }
    const model = models.find((candidate) => candidate.id === action)
    if (!model) return undefined
    const variant = await selectVariant(api, model, suggestedVariant)
    if (variant === undefined) continue
    return { action: "set", model: model.id, variant: variant || undefined }
  }
}

async function selectVariant(api: TuiPluginApi, model: ModelOption, suggested?: string): Promise<string | undefined> {
  if (model.variants.length === 0) return ""
  const selected = await select(
    api,
    `Variant for ${model.id}`,
    [
      // Distinct from a provider-supplied "none" variant, which is a real value (e.g. OpenAI's reasoning-off tier).
      { title: "Default (no variant)", value: NO_VARIANT, description: "Do not write a variant key — inherit the provider default" },
      ...model.variants.map((variant) => ({ title: variant, value: variant })),
    ],
    BACK_HINT,
    suggested && model.variants.includes(suggested) ? suggested : NO_VARIANT,
  )
  if (selected === undefined) return undefined
  return selected === NO_VARIANT ? "" : selected
}

async function loadCatalog(api: TuiPluginApi) {
  const result = await api.client.provider.list()
  return normalizeProviderCatalog(result)
}

/**
 * The agent list comes live from the server, so built-in, repo and user agents are all configurable.
 * The v2 SDK groups are class instances reading `this.client`: call `agents` on its own receiver.
 */
async function loadAgents(api: TuiPluginApi): Promise<LiveAgent[]> {
  const app = (api.client as { app?: { agents?: (input: { directory?: string }) => Promise<unknown> } }).app
  if (typeof app?.agents !== "function") {
    throw new Error("This OpenCode server does not expose the agent list (GET /agent). Update OpenCode and retry.")
  }
  return normalizeLiveAgents(await app.agents({ directory: api.state.path.directory }))
}

/** Review rows are grouped under the first primary in hub order that delegates to them explicitly. */
function reviewCategories(agents: readonly LiveAgent[]): Map<string, string> {
  const hierarchy = buildAgentHierarchy(agents)
  const category = new Map<string, string>()
  for (const group of hierarchy.groups) category.set(group.parent.name, group.parent.name)
  for (const group of hierarchy.groups) {
    for (const child of group.children) {
      if (!category.has(child.name)) category.set(child.name, group.parent.name)
    }
  }
  for (const agent of hierarchy.otherSubagents) {
    if (!category.has(agent.name)) category.set(agent.name, OTHER_GROUP_TITLE)
  }
  return category
}

function findStaleSelections(decisions: ReadonlyMap<string, AgentDecision>, models: readonly ModelOption[]): string[] {
  const live = new Map(models.map((model) => [model.id, new Set(model.variants)]))
  const stale = new Set<string>()
  for (const decision of decisions.values()) {
    if (decision.action !== "set") continue
    const variants = live.get(decision.model)
    if (!variants || (decision.variant && !variants.has(decision.variant))) stale.add(decision.model)
  }
  return [...stale].sort()
}

function modeLetter(mode: AgentMode): string {
  if (mode === "primary") return "M"
  return mode === "all" ? "A" : "S"
}

function decisionDisplay(decision: AgentDecision | undefined, current: AgentMapping | undefined): string {
  if (!decision || decision.action === "keep") return `= ${formatMapping(current ?? {})}`
  if (decision.action === "inherit") return "→ inherit"
  return `→ ${formatMapping({ model: decision.model, variant: decision.variant })}`
}

function variantDescription(model: ModelOption): string {
  return model.variants.length === 0 ? "No variants" : `${model.variants.length} variant${model.variants.length === 1 ? "" : "s"}`
}

function select<Value extends string>(
  api: TuiPluginApi,
  title: string,
  options: TuiDialogSelectOption<Value>[],
  placeholder: string = BACK_HINT,
  current?: Value,
): Promise<Value | undefined> {
  return new Promise((resolve) => {
    const DialogSelect = api.ui.DialogSelect<Value>
    let settled = false
    const finish = (value?: Value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    api.ui.dialog.replace(
      () =>
        DialogSelect({
          title,
          options,
          current,
          placeholder,
          onSelect: (option) => {
            finish(option.value)
            api.ui.dialog.clear()
          },
        }),
      () => finish(undefined),
    )
  })
}

function confirmStep(api: TuiPluginApi, title: string, message: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const DialogConfirm = api.ui.DialogConfirm
    let settled = false
    const finish = (value?: boolean) => {
      if (settled) return
      settled = true
      api.ui.dialog.clear()
      resolve(value)
    }
    api.ui.dialog.replace(
      () => DialogConfirm({ title, message: `${message}\n\n${BACK_HINT}`, onConfirm: () => finish(true), onCancel: () => finish(false) }),
      () => finish(undefined),
    )
  })
}

function prompt(api: TuiPluginApi, title: string, placeholder: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const DialogPrompt = api.ui.DialogPrompt
    let settled = false
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      api.ui.dialog.clear()
      resolve(value)
    }
    api.ui.dialog.replace(
      () => DialogPrompt({ title, placeholder, onConfirm: (value) => finish(value), onCancel: () => finish(undefined) }),
      () => finish(undefined),
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown model configurator error"
}
