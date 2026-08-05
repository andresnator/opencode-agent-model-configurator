import assert from "node:assert/strict"
import crypto from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import {
  buildAgentHierarchy,
  calculateChanges,
  formatMapping,
  normalizeLiveAgents,
  normalizeProviderCatalog,
  resolveProfilesRoot,
  validateProfile,
  visibleAgents,
  wildcardMatch,
  type AgentChange,
  type LiveAgent,
} from "../src/domain"
import {
  applyConfigChanges,
  planGlobalHotApply,
} from "../src/hot-apply"
import {
  displayConfigFile,
  readConfigSnapshot,
  renderConfigChanges,
  writeConfigChanges,
  type ConfigSnapshot,
  type PersistenceStep,
} from "../src/persistence"
import {
  deletePreset,
  loadPresets,
  partitionPresetAssignments,
  savePreset,
} from "../src/presets"
import { normalizePluginOptions } from "../src/options"
import { runModelConfigurator } from "../src/wizard"
import type {
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
  TuiPluginApi,
  TuiToast,
} from "@opencode-ai/plugin/tui"

const ROOT = path.resolve(import.meta.dirname, "..")
const FIXTURES = path.join(ROOT, "tests", "fixtures")
const PROFILE_EXAMPLE_FILE = path.join(ROOT, "examples", "profiles", "team.example.json")
const PROFILE_SCHEMA_FILE = path.join(ROOT, "schemas", "profile.schema.json")
const PROFILE_SCHEMA_REFERENCE_KEY = "$schema"
const EXPECTED_FAILURE_STEPS: PersistenceStep[] = [
  "temporary-open",
  "temporary-write",
  "temporary-flush",
  "rename",
  "destination-flush",
  "post-validate",
]
const CORRUPTED_PRESET_BYTES = "not valid preset storage after startup\n"

let passes = 0

async function shouldNormalizeProfilesDirectoryWhenPluginOptionsAreProvided(): Promise<void> {
  // Given
  const raw = { profilesDir: "  .opencode/model-profiles  ", foreign: true }

  // When
  const actual = normalizePluginOptions(raw)

  // Then
  assert.deepEqual(actual, { profilesDir: ".opencode/model-profiles" })
  assert.deepEqual(normalizePluginOptions({ profilesDir: "   " }), {})
  assert.deepEqual(normalizePluginOptions(undefined), {})
  pass("shouldNormalizeProfilesDirectoryWhenPluginOptionsAreProvided")
}

async function shouldResolveConfiguredProfilesDirectoryRelativeToActiveProject(): Promise<void> {
  // Given
  const project = path.join(tmpdir(), "model-configurator-project")

  // When
  const actual = await resolveProfilesRoot(import.meta.url, ".opencode/model-profiles", project)

  // Then
  assert.equal(actual, path.join(project, ".opencode", "model-profiles"))
  pass("shouldResolveConfiguredProfilesDirectoryRelativeToActiveProject")
}

async function shouldDeclareEveryExampleRootKeyWhenProfileSchemaIsStrict(): Promise<void> {
  // Given
  const profileExample = JSON.parse(await readFile(PROFILE_EXAMPLE_FILE, "utf8")) as Record<string, unknown>
  const profileSchema = JSON.parse(await readFile(PROFILE_SCHEMA_FILE, "utf8")) as {
    properties: Record<string, unknown>
    additionalProperties: unknown
  }

  // When
  const undeclaredRootKeys = Object.keys(profileExample)
    .filter((rootKey) => !Object.hasOwn(profileSchema.properties, rootKey))
    .sort()
  const actual = {
    undeclaredRootKeys,
    schemaDeclaration: profileSchema.properties[PROFILE_SCHEMA_REFERENCE_KEY],
    additionalProperties: profileSchema.additionalProperties,
  }

  // Then
  assert.deepEqual(actual, {
    undeclaredRootKeys: [],
    schemaDeclaration: { type: "string" },
    additionalProperties: false,
  })
  pass("shouldDeclareEveryExampleRootKeyWhenProfileSchemaIsStrict")
}

async function shouldValidateProfileAsWholeContractWhenProfileIsComplete(): Promise<void> {
  // Given
  const agents = ["alpha", "beta", "gamma"]
  const profile = {
    name: "default",
    description: "Three tiers",
    tiers: {
      high: { description: "High", variant: "high", agents: ["alpha", "beta"] },
      low: { description: "Low", agents: [] },
    },
  }

  // When
  const actual = validateProfile(profile, agents)

  // Then
  assert.deepEqual(actual, {
    profile,
    errors: [],
    warnings: [],
  })
  pass("shouldValidateProfileAsWholeContractWhenProfileIsComplete")
}

async function shouldRejectDuplicateAndMalformedAgentsWhenProfileIsInvalid(): Promise<void> {
  // Given
  const profile = {
    tiers: {
      first: { agents: ["alpha", "missing", 42] },
      second: { agents: ["alpha"] },
    },
  }

  // When
  const actual = validateProfile(profile, ["alpha", "beta"])

  // Then
  assert.deepEqual(actual, {
    errors: ["tier 'first' contains a non-string agent", "agent 'alpha' appears in more than one tier"],
    warnings: ["tier 'first' skips agents missing on this server: missing"],
  })
  pass("shouldRejectDuplicateAndMalformedAgentsWhenProfileIsInvalid")
}

async function shouldKeepKnownAgentsAndWarnWhenTierReferencesAgentsMissingOnThisServer(): Promise<void> {
  // Given a profile authored for the full harness loaded on a partial install
  const profile = {
    name: "default",
    tiers: { high: { description: "High", agents: ["alpha", "missing"] } },
  }

  // When
  const actual = validateProfile(profile, ["alpha"])

  // Then
  assert.deepEqual(actual.errors, [])
  assert.deepEqual(actual.warnings, ["tier 'high' skips agents missing on this server: missing"])
  assert.deepEqual(actual.profile?.tiers.high.agents, ["alpha"])
  pass("shouldKeepKnownAgentsAndWarnWhenTierReferencesAgentsMissingOnThisServer")
}

async function shouldExposeOnlyConnectedProvidersWhenCatalogContainsDisconnectedEntries(): Promise<void> {
  // Given
  const response = {
    data: {
      connected: ["openai", "missing"],
      all: [
        { id: "anthropic", models: { opus: { variants: { high: {} } } } },
        { id: "openai", models: { gpt: { variants: ["medium", "high"] } } },
      ],
    },
  }

  // When
  const actual = normalizeProviderCatalog(response)

  // Then
  assert.deepEqual(actual, [{ id: "openai", models: [{ id: "gpt", variants: ["high", "medium"] }] }])
  pass("shouldExposeOnlyConnectedProvidersWhenCatalogContainsDisconnectedEntries")
}

async function shouldCalculateOnlyChangedAssignmentsWhenDecisionsMixActions(): Promise<void> {
  // Given
  const current = {
    alpha: { model: "openai/gpt", variant: "high" },
    beta: { model: "anthropic/opus" },
  }
  const decisions = new Map([
    ["alpha", { action: "set", model: "openai/gpt", variant: "high" } as const],
    ["beta", { action: "inherit" } as const],
    ["gamma", { action: "set", model: "google/gemini" } as const],
  ])

  // When
  const actual = calculateChanges(current, decisions)

  // Then
  assert.deepEqual(actual, [
    { agent: "beta", before: { model: "anthropic/opus" }, after: {}, action: "inherit" },
    { agent: "gamma", before: {}, after: { model: "google/gemini" }, action: "set" },
  ])
  pass("shouldCalculateOnlyChangedAssignmentsWhenDecisionsMixActions")
}

async function shouldFormatMappingCompactlyWithAtVariant(): Promise<void> {
  // Then
  assert.equal(formatMapping({}), "inherits")
  assert.equal(formatMapping({ model: "openai/gpt" }), "openai/gpt")
  assert.equal(formatMapping({ model: "openai/gpt", variant: "medium" }), "openai/gpt @medium")
  pass("shouldFormatMappingCompactlyWithAtVariant")
}

async function shouldPreserveForeignJsoncWhenRenderingAssignmentChanges(): Promise<void> {
  // Given
  const content = await readFile(path.join(FIXTURES, "config-before.jsonc"), "utf8")
  const snapshot: ConfigSnapshot = {
    file: "fixture.jsonc",
    exists: true,
    content,
    mode: 0o640,
    mappings: {},
  }
  const changes = fixtureChanges()

  // When
  const actual = renderConfigChanges(snapshot, changes)

  // Then
  const expected = await readFile(path.join(FIXTURES, "config-after.jsonc"), "utf8")
  assert.equal(actual, expected)
  pass("shouldPreserveForeignJsoncWhenRenderingAssignmentChanges")
}

async function shouldWriteWithoutBackupAndPreserveModeWhenWriteSucceeds(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-persistence."))
  try {
    // Given
    const file = path.join(scratch, "opencode.jsonc")
    const original = await readFile(path.join(FIXTURES, "config-before.jsonc"), "utf8")
    await writeFile(file, original, { mode: 0o640 })
    const snapshot = await readConfigSnapshot(file)

    // When
    const result = await writeConfigChanges(snapshot, fixtureChanges())

    // Then
    assert.equal(result.file, file)
    assert.equal(await readFile(file, "utf8"), await readFile(path.join(FIXTURES, "config-after.jsonc"), "utf8"))
    assert.equal((await stat(file)).mode & 0o777, 0o640)
    assert.deepEqual((await readdir(scratch)).sort(), ["opencode.jsonc"])
    pass("shouldWriteWithoutBackupAndPreserveModeWhenWriteSucceeds")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldRejectConcurrentEditBeforeWriting(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-persistence."))
  try {
    // Given
    const file = path.join(scratch, "opencode.jsonc")
    await writeFile(file, await readFile(path.join(FIXTURES, "config-before.jsonc"), "utf8"))
    const snapshot = await readConfigSnapshot(file)
    const external = '{"external":true}\n'
    await writeFile(file, external)

    // When
    await assert.rejects(() => writeConfigChanges(snapshot, fixtureChanges()), /changed while the configurator was open/)

    // Then
    assert.equal(await readFile(file, "utf8"), external)
    assert.deepEqual((await readdir(scratch)).sort(), ["opencode.jsonc"])
    pass("shouldRejectConcurrentEditBeforeWriting")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldRestoreOriginalWhenInjectedPersistenceStepFails(): Promise<void> {
  for (const failureStep of EXPECTED_FAILURE_STEPS) {
    const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-persistence."))
    try {
      // Given
      const file = path.join(scratch, "opencode.jsonc")
      const original = await readFile(path.join(FIXTURES, "config-before.jsonc"), "utf8")
      await writeFile(file, original, { mode: 0o600 })
      const snapshot = await readConfigSnapshot(file)

      // When
      await assert.rejects(
        () =>
          writeConfigChanges(snapshot, fixtureChanges(), {
            before(step) {
              if (step === failureStep) throw new Error(`injected ${step}`)
            },
          }),
        new RegExp(`injected ${failureStep}`),
      )

      // Then
      assert.equal(await readFile(file, "utf8"), original, `destination changed after ${failureStep}`)
      assert.equal((await readdir(scratch)).some((entry) => entry.endsWith(".tmp")), false, `temp remains after ${failureStep}`)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  pass("shouldRestoreOriginalWhenInjectedPersistenceStepFails")
}

async function shouldCompleteStagedWizardAndPersistSelectedChanges(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let overrideAgentSelection = 0
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "default")
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_yes__")
        if (title === "Choose agent to override") {
          overrideAgentSelection += 1
          return option(options, overrideAgentSelection === 1 ? "beta" : "__done__")
        }
        if (title === "Override: beta") return option(options, "__inherit__")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "high" },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    assert.equal((await readdir(path.dirname(configFile))).some((entry) => entry.includes(".bak")), false)
    pass("shouldCompleteStagedWizardAndPersistSelectedChanges")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldKeepCoreConfigurationUsableWhenPresetStorageIsUnavailable(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given invalid preset storage and a normal configuration flow
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await mkdir(scratch.global, { recursive: true })
    await writeFile(presetsPath, "not json\n")
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let hubOptions: PolicyOption[] = []
    let reviewOptions: PolicyOption[] = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          hubOptions = options
          return option(options, "default")
        }
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) {
          reviewOptions = options
          return option(options, "__apply__")
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When the wizard opens and the ordinary apply flow completes
    await runModelConfigurator(api, scratch.profiles)

    // Then preset storage is hidden and saving is disabled without blocking core configuration
    assert.equal(hubOptions.some((candidate) => candidate.category === "Saved presets"), false)
    const saveOption = reviewOptions.find((candidate) => candidate.value === "__apply_save__")
    assert.ok(saveOption)
    assert.equal(saveOption.disabled, true)
    assert.match(saveOption.description ?? "", /repair.*reopen|reopen.*repair/i)
    const warnings = toasts.filter((toast) => toast.variant === "warning")
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.message), new RegExp(`${escapeRegExp(presetsPath)}.*malformed JSON`))
    assert.deepEqual((await readConfigSnapshot(configFile)).mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    pass("shouldKeepCoreConfigurationUsableWhenPresetStorageIsUnavailable")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldKeepCoreConfigurationUsableWhenPresetStorageIsUnreadable(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given unreadable preset storage and a normal configuration flow
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await mkdir(scratch.global, { recursive: true })
    await mkdir(presetsPath)
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let hubOptions: PolicyOption[] = []
    let reviewOptions: PolicyOption[] = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          hubOptions = options
          return option(options, "default")
        }
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) {
          reviewOptions = options
          return option(options, "__apply__")
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When the wizard opens and the ordinary apply flow completes
    await runModelConfigurator(api, scratch.profiles)

    // Then unreadable preset storage is contained without blocking core configuration
    assert.equal(hubOptions.some((candidate) => candidate.category === "Saved presets"), false)
    const saveOption = reviewOptions.find((candidate) => candidate.value === "__apply_save__")
    assert.ok(saveOption)
    assert.equal(saveOption.disabled, true)
    assert.match(saveOption.description ?? "", /repair.*reopen|reopen.*repair/i)
    const warnings = toasts.filter((toast) => toast.variant === "warning")
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.message), new RegExp(escapeRegExp(presetsPath)))
    assert.match(String(warnings[0]?.message), /Unable to read preset storage/)
    assert.match(String(warnings[0]?.message), /EISDIR|directory/i)
    assert.deepEqual((await readConfigSnapshot(configFile)).mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    pass("shouldKeepCoreConfigurationUsableWhenPresetStorageIsUnreadable")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldRestorePresetStorageWhenWizardReopensAfterRepair(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given invalid storage repaired after startup, while the first wizard session remains open
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await mkdir(scratch.global, { recursive: true })
    await writeFile(presetsPath, "not json\n")
    const repaired = { name: "repaired", savedAt: "2026-01-01T00:00:00.000Z", assignments: { alpha: { model: "anthropic/old" } } }
    const firstSession: { hubOptions: PolicyOption[]; reviewOptions: PolicyOption[] } = { hubOptions: [], reviewOptions: [] }
    let repairOnScope = true
    const firstApi = createFakeApi(scratch, [], {
      select(title, options) {
        if (title === "Configuration scope") {
          if (repairOnScope) {
            writeFileSync(presetsPath, `${JSON.stringify({ version: 1, presets: [repaired] })}\n`)
            repairOnScope = false
          }
          return option(options, "project")
        }
        if (title === "Agents") {
          firstSession.hubOptions = options
          return option(options, "default")
        }
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) {
          firstSession.reviewOptions = options
          return option(options, "__apply__")
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When the first session completes after the file is repaired
    await runModelConfigurator(firstApi, scratch.profiles)

    // Then the session-sticky gate keeps entries and mutation UI unavailable
    assert.equal(firstSession.hubOptions.some((candidate) => candidate.category === "Saved presets"), false)
    assert.equal(firstSession.reviewOptions.find((candidate) => candidate.value === "__apply_save__")?.disabled, true)

    // When the configurator is reopened against the repaired v1 file
    const secondSession: { sawPreset: boolean; sawEnabledSave: boolean } = { sawPreset: false, sawEnabledSave: false }
    const secondApi = createFakeApi(scratch, [], {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          secondSession.sawPreset = options.some((candidate) => candidate.value === "__preset__:repaired")
          return option(options, "__preset__:repaired")
        }
        if (title === "Preset: repaired") return option(options, "__apply_preset__")
        if (title.startsWith("Apply ")) {
          secondSession.sawEnabledSave = options.some((candidate) => candidate.value === "__apply_save__" && !candidate.disabled)
          return option(options, "__apply_save__")
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
      prompt(title) {
        if (title === "Preset name") return "reopened"
        throw new Error(`unexpected prompt dialog: ${title}`)
      },
    })
    await runModelConfigurator(secondApi, scratch.profiles)

    // Then reopening restores preset entries and mutation behavior
    assert.equal(secondSession.sawPreset, true)
    assert.equal(secondSession.sawEnabledSave, true)
    const persistedPresets = await loadPresets(presetsPath)
    assert.deepEqual(persistedPresets[0]?.assignments, { alpha: { model: "anthropic/old" }, beta: { model: "anthropic/old" } })
    assert.equal(persistedPresets[0]?.name, "reopened")
    assert.deepEqual(persistedPresets[1], repaired)
    assert.deepEqual((await readConfigSnapshot(path.join(scratch.project, ".opencode", "opencode.jsonc"))).mappings, {
      alpha: { model: "anthropic/old", variant: undefined },
      beta: { model: "anthropic/old", variant: undefined },
    })
    pass("shouldRestorePresetStorageWhenWizardReopensAfterRepair")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldLeaveConfigUntouchedWhenFinalReviewIsCancelled(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const original = await readFile(configFile, "utf8")
    const api = createFakeApi(scratch, [], {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "default")
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) return option(options, "__cancel__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then
    assert.equal(await readFile(configFile, "utf8"), original)
    assert.deepEqual((await readdir(path.dirname(configFile))).sort(), ["opencode.jsonc"])
    pass("shouldLeaveConfigUntouchedWhenFinalReviewIsCancelled")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldReshowPreviousDialogWhenEscapingBack(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a wizard that escapes the first tier dialog once, then completes
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let hubVisits = 0
    let highTierVisits = 0
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          hubVisits += 1
          return option(options, "default")
        }
        if (title === "Tier: high") {
          highTierVisits += 1
          return highTierVisits === 1 ? "escape" : option(options, "openai/new")
        }
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then esc on the first tier returned to the agent hub, which re-showed both dialogs
    assert.equal(hubVisits, 2)
    assert.equal(highTierVisits, 2)
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldReshowPreviousDialogWhenEscapingBack")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldExitWithoutWritingWhenScopeIsEscaped(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const original = await readFile(configFile, "utf8")
    const api = createFakeApi(scratch, [], {
      select(title) {
        if (title === "Configuration scope") return "escape"
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then esc on the first dialog exits silently, touching nothing
    assert.equal(await readFile(configFile, "utf8"), original)
    assert.deepEqual((await readdir(path.dirname(configFile))).sort(), ["opencode.jsonc"])
    pass("shouldExitWithoutWritingWhenScopeIsEscaped")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldSavePresetWhenApplyingAndSaving(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a run that inherits beta then applies-and-saves under a name
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let overrideAgentSelection = 0
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "default")
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_yes__")
        if (title === "Choose agent to override") {
          overrideAgentSelection += 1
          return option(options, overrideAgentSelection === 1 ? "beta" : "__done__")
        }
        if (title === "Override: beta") return option(options, "__inherit__")
        if (title.startsWith("Apply ")) return option(options, "__apply_save__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
      prompt(title) {
        if (title === "Preset name") return "prod"
        throw new Error(`unexpected prompt dialog: ${title}`)
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the config is written and a preset with only concrete (non-inherited) assignments is saved
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, { alpha: { model: "openai/new", variant: "high" } })
    const presets = await loadPresets(path.join(scratch.global, "model-configurator-presets.json"))
    assert.equal(presets.length, 1)
    assert.equal(presets[0].name, "prod")
    assert.deepEqual(presets[0].assignments, { alpha: { model: "openai/new", variant: "high" } })
    pass("shouldSavePresetWhenApplyingAndSaving")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldRejectForbiddenLiveAgentAssignmentsBeforeReplacingPresetStorage(): Promise<void> {
  for (const agent of ["constructor", "__proto__"]) {
    const scratch = await createWizardFixture()
    try {
      // Given a live agent whose name is forbidden in preset assignment records
      scratch.agents = [{ name: agent, mode: "primary" }]
      await writeJson(path.join(scratch.profiles, "default.json"), {
        name: "default",
        tiers: { high: { description: "High", variant: "high", agents: [agent] } },
      })
      await writeJsonc(path.join(scratch.project, ".opencode", "opencode.jsonc"), '{\n  "agent": {}\n}\n')
      const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
      const originalBytes = Buffer.from(
        '{"version":1,"presets":[{"name":"existing","savedAt":"2026-01-01T00:00:00.000Z","assignments":{}}]}\n',
      )
      await mkdir(scratch.global, { recursive: true })
      await writeFile(presetsPath, originalBytes)
      const toasts: TuiToast[] = []
      const api = createFakeApi(scratch, toasts, {
        select(title, options) {
          if (title === "Configuration scope") return option(options, "project")
          if (title === "Agents") return option(options, "default")
          if (title === "Tier: high") return option(options, "openai/new")
          if (title === "Variant for openai/new") return option(options, "high")
          if (title === "Individual overrides") return option(options, "__override_no__")
          if (title.startsWith("Apply ")) return option(options, "__apply_save__")
          throw new Error(`unexpected select dialog: ${title}`)
        },
        confirm() {
          return true
        },
        prompt(title) {
          if (title === "Preset name") return "rejected"
          throw new Error(`unexpected prompt dialog: ${title}`)
        },
      })

      // When the configuration is applied and the wizard tries to save the preset
      await runModelConfigurator(api, scratch.profiles)

      // Then preset validation rejects before replacement and no save success is reported
      assert.deepEqual(await readFile(presetsPath), originalBytes, `${agent} replaced preset storage`)
      assert.deepEqual((await readdir(scratch.global)).sort(), ["model-configurator-presets.json"])
      assert.equal(toasts.some((toast) => toast.message?.includes('Saved preset "rejected".')), false)
      const errors = toasts.filter((toast) => toast.title === "Preset not saved")
      assert.equal(errors.length, 1)
      assert.match(errors[0]?.message ?? "", new RegExp(`forbidden key '${agent}'`))
    } finally {
      await rm(scratch.root, { recursive: true, force: true })
    }
  }
  pass("shouldRejectForbiddenLiveAgentAssignmentsBeforeReplacingPresetStorage")
}

async function shouldApplyPresetSkippingTiersAndOverrides(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a seeded preset in the global config root
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await savePreset(presetsPath, {
      name: "saved",
      savedAt: "2026-01-01T00:00:00.000Z",
      assignments: { alpha: { model: "openai/new", variant: "high" } },
    })
    const toasts: TuiToast[] = []
    const api = createFakeApi(scratch, toasts, {
      // No tier/override handlers: reaching one throws and fails the test
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "__preset__:saved")
        if (title === "Preset: saved") return option(options, "__apply_preset__")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the preset assignments are applied without visiting tiers or overrides
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldApplyPresetSkippingTiersAndOverrides")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldDeletePresetWithoutTouchingConfig(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a seeded preset and an untouched config
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const original = await readFile(configFile, "utf8")
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await savePreset(presetsPath, {
      name: "saved",
      savedAt: "2026-01-01T00:00:00.000Z",
      assignments: { alpha: { model: "openai/new", variant: "high" } },
    })
    const toasts: TuiToast[] = []
    let scopeVisits = 0
    let hubVisits = 0
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") {
          scopeVisits += 1
          return scopeVisits === 1 ? option(options, "project") : "escape"
        }
        if (title === "Agents") {
          hubVisits += 1
          return hubVisits === 1 ? option(options, "__preset__:saved") : "escape"
        }
        if (title === "Preset: saved") return option(options, "__delete_preset__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When: apply project, delete the preset, esc back through the hub and scope dialogs to exit
    await runModelConfigurator(api, scratch.profiles)

    // Then the preset is gone and the config is untouched
    assert.deepEqual(await loadPresets(presetsPath), [])
    assert.equal(await readFile(configFile, "utf8"), original)
    assert.ok(toasts.some((toast) => toast.message?.includes('Deleted preset "saved"')))
    pass("shouldDeletePresetWithoutTouchingConfig")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldKeepCoreApplyAndReportPresetSaveFailureWhenStorageBecomesInvalid(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given valid preset storage loaded at startup
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await savePreset(presetsPath, {
      name: "existing",
      savedAt: "2026-01-01T00:00:00.000Z",
      assignments: { alpha: { model: "anthropic/old" } },
    })
    const toasts: TuiToast[] = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "default")
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) {
          writeFileSync(presetsPath, CORRUPTED_PRESET_BYTES)
          return option(options, "__apply_save__")
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
      prompt(title) {
        if (title === "Preset name") return "after-corruption"
        throw new Error(`unexpected prompt dialog: ${title}`)
      },
    })

    // When Apply-and-save runs after storage is corrupted
    await runModelConfigurator(api, scratch.profiles)

    // Then core Apply succeeds, while the local preset mutation reports only its failure
    const errors = toasts.filter((toast) => toast.variant === "error")
    assert.equal(errors.length, 1)
    assert.equal(errors[0]?.title, "Preset not saved")
    assert.match(errors[0]?.message ?? "", /Invalid preset storage/)
    assert.equal(toasts.some((toast) => toast.message?.includes('Saved preset "')), false)
    assert.equal(toasts.some((toast) => toast.title === "Model configurator failed"), false)
    assert.deepEqual((await readConfigSnapshot(configFile)).mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.deepEqual(await readFile(presetsPath), Buffer.from(CORRUPTED_PRESET_BYTES))
    pass("shouldKeepCoreApplyAndReportPresetSaveFailureWhenStorageBecomesInvalid")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldClearPresetUiAndReportDeleteFailureWhenStorageBecomesInvalid(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given valid preset storage loaded at startup
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await savePreset(presetsPath, {
      name: "saved",
      savedAt: "2026-01-01T00:00:00.000Z",
      assignments: { alpha: { model: "openai/new", variant: "high" } },
    })
    const toasts: TuiToast[] = []
    let hubVisits = 0
    let postDeleteHubOptions: PolicyOption[] = []
    let reviewOptions: PolicyOption[] = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          hubVisits += 1
          if (hubVisits === 1) return option(options, "__preset__:saved")
          postDeleteHubOptions = options
          return option(options, "default")
        }
        if (title === "Preset: saved") {
          writeFileSync(presetsPath, CORRUPTED_PRESET_BYTES)
          return option(options, "__delete_preset__")
        }
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) {
          reviewOptions = options
          return option(options, "__apply__")
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When delete runs after storage is corrupted, then the user returns to the hub
    await runModelConfigurator(api, scratch.profiles)

    // Then the local error clears entries, preserves bytes, and gates later mutations
    const errors = toasts.filter((toast) => toast.variant === "error")
    assert.equal(errors.length, 1)
    assert.equal(errors[0]?.title, "Preset not deleted")
    assert.match(errors[0]?.message ?? "", /Invalid preset storage/)
    assert.equal(toasts.some((toast) => toast.message?.includes('Deleted preset "')), false)
    assert.equal(postDeleteHubOptions.some((candidate) => candidate.category === "Saved presets"), false)
    const saveOption = reviewOptions.find((candidate) => candidate.value === "__apply_save__")
    assert.ok(saveOption)
    assert.equal(saveOption.disabled, true)
    assert.deepEqual(await readFile(presetsPath), Buffer.from(CORRUPTED_PRESET_BYTES))
    assert.deepEqual((await readConfigSnapshot(configFile)).mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    pass("shouldClearPresetUiAndReportDeleteFailureWhenStorageBecomesInvalid")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldOpenAdjacentAgentViaNextAgent(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a run that only ever picks "alpha" from the chooser
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let chooserVisits = 0
    let sawOverrideBeta = false
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "default")
        if (title === "Tier: high") return option(options, "__keep_current__")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_yes__")
        if (title === "Choose agent to override") {
          chooserVisits += 1
          return option(options, chooserVisits === 1 ? "alpha" : "__done__")
        }
        if (title === "Override: alpha") return option(options, "__next_agent__")
        if (title === "Override: beta") {
          sawOverrideBeta = true
          return option(options, "openai/new")
        }
        if (title === "Variant for openai/new") return option(options, "high")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then "→ Next agent" opened beta's override dialog without selecting it in the chooser
    assert.equal(sawOverrideBeta, true)
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/old", variant: undefined },
      beta: { model: "openai/new", variant: "high" },
    })
    pass("shouldOpenAdjacentAgentViaNextAgent")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldPreserveOverridesWhenEscapingAgentChooser(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given an override for alpha, then esc at the chooser (which must NOT discard it)
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let individualOverridesVisits = 0
    let chooserVisits = 0
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "default")
        if (title === "Tier: high") return option(options, "__keep_current__")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") {
          individualOverridesVisits += 1
          return option(options, "__override_yes__")
        }
        if (title === "Choose agent to override") {
          chooserVisits += 1
          if (chooserVisits === 1) return option(options, "alpha")
          if (chooserVisits === 2) return "escape"
          return option(options, "__done__")
        }
        if (title === "Override: alpha") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then esc re-showed the Yes/No prompt (not tiers) and the alpha override survived
    assert.equal(individualOverridesVisits, 2)
    assert.equal(chooserVisits, 3)
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldPreserveOverridesWhenEscapingAgentChooser")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldConfigureAgentThroughGroupBrowseAndApply(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a run that browses the alpha group, configures alpha, and applies from the hub
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let groupAgentsVisits = 0
    let sawPendingMarker = false
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          const review = options.find((candidate) => candidate.value === "__review_changes__")
          return review ?? option(options, "__group__:alpha")
        }
        if (title === "alpha") {
          groupAgentsVisits += 1
          if (groupAgentsVisits === 1) return option(options, "alpha")
          sawPendingMarker = options.some((candidate) => candidate.title === "● alpha")
          return option(options, "__done__")
        }
        if (title === "Configure: alpha") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the group-browsed decision is applied and the pending marker was visible
    assert.equal(sawPendingMarker, true)
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldConfigureAgentThroughGroupBrowseAndApply")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldApplyDecisionToEveryAgentInGroupThroughAllOption(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given alpha claims gamma and the run configures both through "All agents"
    scratch.agents = [
      { name: "alpha", mode: "primary", task: [{ pattern: "*", action: "deny" }, { pattern: "gamma", action: "allow" }] },
      { name: "gamma", mode: "subagent" },
      { name: "beta", mode: "subagent" },
    ]
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let groupAgentsVisits = 0
    let sawAllPendingMarkers = false
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          const review = options.find((candidate) => candidate.value === "__review_changes__")
          return review ?? option(options, "__group__:alpha")
        }
        if (title === "alpha") {
          groupAgentsVisits += 1
          if (groupAgentsVisits === 1) return option(options, "__all_agents__")
          sawAllPendingMarkers =
            options.some((candidate) => candidate.title === "● alpha") &&
            options.some((candidate) => candidate.title === "● gamma")
          return option(options, "__done__")
        }
        if (title === "Configure every agent in alpha") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then one decision fanned out to every agent in the group and beta stayed untouched
    assert.equal(sawAllPendingMarkers, true)
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "high" },
      gamma: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldApplyDecisionToEveryAgentInGroupThroughAllOption")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldClearGroupDecisionsWhenAllAgentsKeepsCurrent(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given "All agents" sets a decision for the whole group and then keeps current
    scratch.agents = [
      { name: "alpha", mode: "primary", task: [{ pattern: "*", action: "deny" }, { pattern: "gamma", action: "allow" }] },
      { name: "gamma", mode: "subagent" },
      { name: "beta", mode: "subagent" },
    ]
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const original = await readFile(configFile, "utf8")
    let groupAgentsVisits = 0
    let configureAllVisits = 0
    let hubVisits = 0
    let scopeVisits = 0
    let sawMarkersAfterSet = false
    let sawMarkersAfterKeep = true
    let sawReviewAfterKeep = true
    const api = createFakeApi(scratch, [], {
      select(title, options) {
        if (title === "Configuration scope") {
          scopeVisits += 1
          return scopeVisits === 1 ? option(options, "project") : "escape"
        }
        if (title === "Agents") {
          hubVisits += 1
          if (hubVisits === 1) return option(options, "__group__:alpha")
          sawReviewAfterKeep = options.some((candidate) => candidate.value === "__review_changes__")
          return "escape"
        }
        if (title === "alpha") {
          groupAgentsVisits += 1
          if (groupAgentsVisits === 1) return option(options, "__all_agents__")
          if (groupAgentsVisits === 2) {
            sawMarkersAfterSet = options.some((candidate) => candidate.title === "● alpha")
            return option(options, "__all_agents__")
          }
          sawMarkersAfterKeep = options.some((candidate) => candidate.title.startsWith("● "))
          return option(options, "__done__")
        }
        if (title === "Configure every agent in alpha") {
          configureAllVisits += 1
          return configureAllVisits === 1 ? option(options, "openai/new") : option(options, "__keep_current__")
        }
        if (title === "Variant for openai/new") return option(options, "high")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then keep-current cleared every pending group decision and nothing was written
    assert.equal(sawMarkersAfterSet, true)
    assert.equal(sawMarkersAfterKeep, false)
    assert.equal(sawReviewAfterKeep, false)
    assert.equal(await readFile(configFile, "utf8"), original)
    pass("shouldClearGroupDecisionsWhenAllAgentsKeepsCurrent")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldOfferSingleDefaultOptionWhenCatalogIncludesNoneVariant(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a model whose provider catalog itself ships a real "none" variant
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let groupAgentsVisits = 0
    let variantOptions: PolicyOption[] = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          const review = options.find((candidate) => candidate.value === "__review_changes__")
          return review ?? option(options, "__group__:alpha")
        }
        if (title === "alpha") {
          groupAgentsVisits += 1
          return groupAgentsVisits === 1 ? option(options, "alpha") : option(options, "__done__")
        }
        if (title === "Configure: alpha") return option(options, "openai/new")
        if (title === "Variant for openai/new") {
          variantOptions = options
          return option(options, "none")
        }
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the synthetic no-variant entry is labelled distinctly from the catalog "none"
    const syntheticEntries = variantOptions.filter((candidate) => candidate.value === "__no_variant__")
    assert.equal(syntheticEntries.length, 1)
    assert.equal(syntheticEntries[0]?.title, "Default (no variant)")
    assert.equal(variantOptions.filter((candidate) => candidate.title === "none").length, 1)
    assert.equal(variantOptions.filter((candidate) => candidate.title.toLowerCase().startsWith("none")).length, 1)

    // And picking the catalog "none" persists it as a real variant value
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "none" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldOfferSingleDefaultOptionWhenCatalogIncludesNoneVariant")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldSkipVariantDialogWhenModelHasNoVariants(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given anthropic/old exposes no variants; any variant dialog would fail the policy
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let groupAgentsVisits = 0
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          const review = options.find((candidate) => candidate.value === "__review_changes__")
          return review ?? option(options, "__group__:alpha")
        }
        if (title === "alpha") {
          groupAgentsVisits += 1
          return groupAgentsVisits === 1 ? option(options, "alpha") : option(options, "__done__")
        }
        if (title === "Configure: alpha") return option(options, "anthropic/old")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the model applied without a variant dialog and without a variant key
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "anthropic/old", variant: undefined },
      beta: { model: "anthropic/old", variant: undefined },
    })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldSkipVariantDialogWhenModelHasNoVariants")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldWalkBackFromGroupAgentsToScopeWithoutWriting(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given esc pressed at each level: group agents → hub → scope
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const original = await readFile(configFile, "utf8")
    let scopeVisits = 0
    let hubVisits = 0
    let groupAgentsVisits = 0
    const api = createFakeApi(scratch, [], {
      select(title, options) {
        if (title === "Configuration scope") {
          scopeVisits += 1
          return scopeVisits === 1 ? option(options, "project") : "escape"
        }
        if (title === "Agents") {
          hubVisits += 1
          return hubVisits === 1 ? option(options, "__group__:alpha") : "escape"
        }
        if (title === "alpha") {
          groupAgentsVisits += 1
          return "escape"
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then each esc stepped back exactly one level and nothing was written
    assert.equal(groupAgentsVisits, 1)
    assert.equal(hubVisits, 2)
    assert.equal(scopeVisits, 2)
    assert.equal(await readFile(configFile, "utf8"), original)
    assert.deepEqual((await readdir(path.dirname(configFile))).sort(), ["opencode.jsonc"])
    pass("shouldWalkBackFromGroupAgentsToScopeWithoutWriting")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldNormalizeLiveAgentsWhenServerAnswersAgentList(): Promise<void> {
  // Given duplicate names, a nameless entry, junk, and permission rules of every shape
  const response = {
    data: [
      { name: "beta" },
      {
        name: "alpha",
        description: "First",
        mode: "primary",
        native: true,
        hidden: true,
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "task", pattern: "beta", action: "ask" },
          { permission: "task", pattern: "gamma", action: "sometimes" },
          { permission: "task" },
        ],
      },
      { name: "beta", mode: "all", permission: [] },
      { name: "", mode: "primary" },
      "not an agent",
    ],
  }

  // When
  const actual = normalizeLiveAgents(response)

  // Then unusable entries are skipped, names deduplicate with the last entry winning, and the list sorts
  assert.deepEqual(actual, [
    {
      name: "alpha",
      description: "First",
      mode: "primary",
      native: true,
      hidden: true,
      // Only task-scoped rules with a valid action survive; the catch-all default matches `task` too.
      taskRules: [
        { pattern: "*", action: "allow" },
        { pattern: "beta", action: "ask" },
      ],
    },
    { name: "beta", mode: "all", native: false, hidden: false, taskRules: [] },
  ])

  // And a bare array is accepted while an unusable envelope fails loudly
  assert.deepEqual(normalizeLiveAgents([{ name: "solo" }]), [
    { name: "solo", mode: "subagent", native: false, hidden: false, taskRules: [] },
  ])
  assert.throws(() => normalizeLiveAgents({ data: "nope" }), /did not return an agent list/)
  assert.throws(() => normalizeLiveAgents(undefined), /did not return an agent list/)
  pass("shouldNormalizeLiveAgentsWhenServerAnswersAgentList")
}

async function shouldDeriveParentChildGroupsFromTaskPermissions(): Promise<void> {
  // Given a native catch-all primary, a primary with an allowlist, and a dual-mode agent
  const agents = liveAgents(
    { name: "builder", mode: "primary", native: true },
    {
      name: "orchestrator",
      mode: "primary",
      task: [
        { pattern: "*", action: "deny" },
        { pattern: "sdd-*", action: "allow" },
        { pattern: "flip", action: "allow" },
        { pattern: "flip", action: "deny" },
        { pattern: "hybrid", action: "ask" },
      ],
    },
    {
      name: "hybrid",
      mode: "all",
      task: [
        { pattern: "*", action: "deny" },
        { pattern: "sdd-one", action: "allow" },
      ],
    },
    { name: "sdd-one" },
    { name: "sdd-two" },
    { name: "flip" },
    { name: "orphan" },
  )

  // When
  const hierarchy = buildAgentHierarchy(agents)

  // Then custom parents come before native ones, each alphabetically
  assert.deepEqual(
    hierarchy.groups.map((group) => group.parent.name),
    ["hybrid", "orchestrator", "builder"],
  )
  // And a glob claims every match, `ask` still claims, and the last matching rule wins
  assert.deepEqual(
    hierarchy.groups[1].children.map((agent) => agent.name),
    ["hybrid", "sdd-one", "sdd-two"],
  )
  assert.equal(hierarchy.groups[1].openDelegation, false)
  // And a dual-mode agent is both a parent and a claimable child
  assert.deepEqual(
    hierarchy.groups[0].children.map((agent) => agent.name),
    ["sdd-one"],
  )
  // And a catch-all primary delegates openly instead of adopting every subagent on the server
  assert.deepEqual(hierarchy.groups[2].children, [])
  assert.equal(hierarchy.groups[2].openDelegation, true)
  // And subagents nobody claims explicitly stay reachable through the leftover bucket
  assert.deepEqual(
    hierarchy.otherSubagents.map((agent) => agent.name),
    ["flip", "orphan"],
  )
  pass("shouldDeriveParentChildGroupsFromTaskPermissions")
}

async function shouldRepeatSubagentUnderEveryParentThatClaimsIt(): Promise<void> {
  // Given two primaries claiming the same subagent
  const agents = liveAgents(
    { name: "one", mode: "primary", task: [{ pattern: "*", action: "deny" }, { pattern: "shared", action: "allow" }] },
    { name: "two", mode: "primary", task: [{ pattern: "*", action: "deny" }, { pattern: "shared", action: "allow" }] },
    { name: "shared" },
  )

  // When
  const hierarchy = buildAgentHierarchy(agents)

  // Then it appears under both and never lands in the leftover bucket
  assert.deepEqual(
    hierarchy.groups.map((group) => group.children.map((agent) => agent.name)),
    [["shared"], ["shared"]],
  )
  assert.deepEqual(hierarchy.otherSubagents, [])
  pass("shouldRepeatSubagentUnderEveryParentThatClaimsIt")
}

async function shouldExcludeInternalAgentsUntilTheyAreRevealed(): Promise<void> {
  // Given an internal agent claimed by a visible primary
  const agents = liveAgents(
    { name: "visible", mode: "primary", task: [{ pattern: "*", action: "deny" }, { pattern: "secret", action: "allow" }] },
    { name: "secret", hidden: true },
  )

  // When / Then the default view hides it, both in the list and in the group it belongs to
  assert.deepEqual(
    visibleAgents(agents, false).map((agent) => agent.name),
    ["visible"],
  )
  assert.deepEqual(buildAgentHierarchy(visibleAgents(agents, false)).groups[0].children, [])

  // And revealing internals restores it
  assert.deepEqual(
    visibleAgents(agents, true).map((agent) => agent.name),
    ["secret", "visible"],
  )
  assert.deepEqual(
    buildAgentHierarchy(visibleAgents(agents, true)).groups[0].children.map((agent) => agent.name),
    ["secret"],
  )
  pass("shouldExcludeInternalAgentsUntilTheyAreRevealed")
}

async function shouldMatchAnchoredGlobsWhenEvaluatingPermissionPatterns(): Promise<void> {
  // Given OpenCode's wildcard semantics
  assert.equal(wildcardMatch("sdd-plan", "*"), true)
  assert.equal(wildcardMatch("sdd-plan", "sdd-*"), true)
  assert.equal(wildcardMatch("sdd-p", "sdd-?"), true)
  assert.equal(wildcardMatch("sdd-plan", "sdd-?"), false)
  // And matching is anchored and treats regex metacharacters literally
  assert.equal(wildcardMatch("plan-b", "plan"), false)
  assert.equal(wildcardMatch("a.b", "a.b"), true)
  assert.equal(wildcardMatch("axb", "a.b"), false)
  pass("shouldMatchAnchoredGlobsWhenEvaluatingPermissionPatterns")
}

async function shouldRoundTripAndOverwritePresetsWhenSaved(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets."))
  try {
    // Given
    const file = path.join(scratch, "model-configurator-presets.json")

    // When two presets are saved out of order
    await savePreset(file, { name: "b", savedAt: "2026-01-02T00:00:00.000Z", assignments: { alpha: { model: "openai/new" } } })
    await savePreset(file, {
      name: "a",
      savedAt: "2026-01-01T00:00:00.000Z",
      assignments: { beta: { model: "anthropic/old", variant: "high" } },
    })

    // Then they round-trip sorted by name
    let presets = await loadPresets(file)
    assert.deepEqual(
      presets.map((preset) => preset.name),
      ["a", "b"],
    )

    // When a same-named preset is saved, it overwrites in place
    await savePreset(file, { name: "b", savedAt: "2026-01-03T00:00:00.000Z", assignments: { gamma: { model: "google/x" } } })
    presets = await loadPresets(file)
    assert.equal(presets.length, 2)
    assert.deepEqual(presets.find((preset) => preset.name === "b")?.assignments, { gamma: { model: "google/x" } })

    // When one is deleted, only the other remains
    await deletePreset(file, "a")
    presets = await loadPresets(file)
    assert.deepEqual(
      presets.map((preset) => preset.name),
      ["b"],
    )
    pass("shouldRoundTripAndOverwritePresetsWhenSaved")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldRejectEveryInvalidPresetStorageShapeWhenLoaded(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-invalid."))
  try {
    // Given
    const file = path.join(scratch, "model-configurator-presets.json")
    const invalidCases: Array<{ name: string; content: string; reason: RegExp }> = [
      { name: "malformed JSON", content: "{", reason: /malformed JSON/ },
      { name: "non-object root", content: "[]", reason: /root must be an object/ },
      { name: "unknown root field", content: '{"version":1,"presets":[],"extra":true}', reason: /unknown field 'extra'/ },
      { name: "forbidden root key", content: '{"version":1,"presets":[],"__proto__":true}', reason: /forbidden key '__proto__'/ },
      { name: "forbidden root prototype key", content: '{"version":1,"presets":[],"prototype":true}', reason: /forbidden key 'prototype'/ },
      { name: "missing version", content: '{"presets":[]}', reason: /version is missing/ },
      { name: "non-numeric version", content: '{"version":"1","presets":[]}', reason: /version must be numeric/ },
      { name: "unsupported version", content: '{"version":2,"presets":[]}', reason: /unsupported version/ },
      { name: "missing presets", content: '{"version":1}', reason: /presets is missing/ },
      { name: "non-array presets", content: '{"version":1,"presets":{}}', reason: /presets must be an array/ },
      {
        name: "unknown preset field",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{},"extra":true}]}',
        reason: /presets\[0\].*unknown field 'extra'/,
      },
      {
        name: "forbidden preset key",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{},"constructor":true}]}',
        reason: /forbidden key 'constructor'/,
      },
      { name: "non-object preset", content: '{"version":1,"presets":[null]}', reason: /presets\[0\] must be an object/ },
      {
        name: "empty preset name",
        content: '{"version":1,"presets":[{"name":"","savedAt":"now","assignments":{}}]}',
        reason: /presets\[0\]\.name must be a non-empty string/,
      },
      {
        name: "non-string preset name",
        content: '{"version":1,"presets":[{"name":7,"savedAt":"now","assignments":{}}]}',
        reason: /presets\[0\]\.name must be a non-empty string/,
      },
      {
        name: "missing preset name",
        content: '{"version":1,"presets":[{"savedAt":"now","assignments":{}}]}',
        reason: /presets\[0\]\.name must be a non-empty string/,
      },
      {
        name: "non-string savedAt",
        content: '{"version":1,"presets":[{"name":"a","savedAt":7,"assignments":{}}]}',
        reason: /presets\[0\]\.savedAt must be a string/,
      },
      {
        name: "missing savedAt",
        content: '{"version":1,"presets":[{"name":"a","assignments":{}}]}',
        reason: /presets\[0\]\.savedAt must be a string/,
      },
      {
        name: "missing assignments",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now"}]}',
        reason: /presets\[0\]\.assignments is missing/,
      },
      {
        name: "non-object assignments",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":[]}]}',
        reason: /presets\[0\]\.assignments must be an object/,
      },
      {
        name: "duplicate preset names",
        content:
          '{"version":1,"presets":[{"name":"a","savedAt":"one","assignments":{}},{"name":"a","savedAt":"two","assignments":{}}]}',
        reason: /duplicate preset name 'a'/,
      },
      {
        name: "non-object assignment",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"alpha":null}}]}',
        reason: /presets\[0\]\.assignments\.alpha must be an object/,
      },
      {
        name: "missing assignment model",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"alpha":{}}}]}',
        reason: /presets\[0\]\.assignments\.alpha\.model must be a non-empty string/,
      },
      {
        name: "empty assignment model",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"alpha":{"model":""}}}]}',
        reason: /presets\[0\]\.assignments\.alpha\.model must be a non-empty string/,
      },
      {
        name: "non-string assignment model",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"alpha":{"model":7}}}]}',
        reason: /presets\[0\]\.assignments\.alpha\.model must be a non-empty string/,
      },
      {
        name: "non-string assignment variant",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"alpha":{"model":"m","variant":7}}}]}',
        reason: /presets\[0\].*variant must be a string/,
      },
      {
        name: "unknown assignment field",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"alpha":{"model":"m","extra":true}}}]}',
        reason: /unknown field 'extra'/,
      },
      {
        name: "forbidden assignment key",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"__proto__":{"model":"m"}}}]}',
        reason: /forbidden key '__proto__'/,
      },
      {
        name: "forbidden assignment prototype key",
        content: '{"version":1,"presets":[{"name":"a","savedAt":"now","assignments":{"prototype":{"model":"m"}}}]}',
        reason: /forbidden key 'prototype'/,
      },
      {
        name: "mixed valid and invalid presets",
        content:
          '{"version":1,"presets":[{"name":"valid","savedAt":"now","assignments":{}},{"name":"","savedAt":"now","assignments":{}}]}',
        reason: /presets\[1\]\.name must be a non-empty string/,
      },
    ]

    for (const invalidCase of invalidCases) {
      // When
      await writeFile(file, invalidCase.content)

      // Then
      await assert.rejects(
        () => loadPresets(file),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${invalidCase.name} did not reject with an Error`)
          assert.ok(error.message.includes(file), `${invalidCase.name} omitted the preset file path`)
          assert.match(error.message, invalidCase.reason, invalidCase.name)
          return true
        },
      )
    }
    pass("shouldRejectEveryInvalidPresetStorageShapeWhenLoaded")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldRejectInheritedPresetFieldsAndIgnoreInheritedOptionalValues(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-prototype."))
  try {
    // Given preset documents missing required own fields and ambient prototype pollution
    const missingName = path.join(scratch, "missing-name.json")
    const missingSavedAt = path.join(scratch, "missing-saved-at.json")
    const missingModel = path.join(scratch, "missing-model.json")
    const inheritedVariant = path.join(scratch, "inherited-variant.json")
    await Promise.all([
      writeJson(missingName, { version: 1, presets: [{ savedAt: "own", assignments: {} }] }),
      writeJson(missingSavedAt, { version: 1, presets: [{ name: "own", assignments: {} }] }),
      writeJson(missingModel, {
        version: 1,
        presets: [{ name: "own", savedAt: "own", assignments: { alpha: {} } }],
      }),
      writeJson(inheritedVariant, {
        version: 1,
        presets: [{ name: "own", savedAt: "own", assignments: { alpha: { model: "own-model" } } }],
      }),
    ])
    const pollutedFields = [
      ["name", "inherited-name"],
      ["savedAt", "inherited-saved-at"],
      ["model", "inherited-model"],
      ["variant", "inherited-variant"],
    ] as const
    const previousDescriptors = pollutedFields.map(([key]) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const)
    for (const [key, value] of pollutedFields) {
      Object.defineProperty(Object.prototype, key, { configurable: true, value, writable: true })
    }
    try {
      // When each required field is available only through the prototype
      const invalidCases = [
        [missingName, /name must be a non-empty string/],
        [missingSavedAt, /savedAt must be a string/],
        [missingModel, /model must be a non-empty string/],
      ] as const

      // Then inherited required values are rejected
      for (const [file, reason] of invalidCases) {
        await assert.rejects(() => loadPresets(file), reason)
      }

      // And an inherited optional variant never affects a materialized assignment
      const [preset] = await loadPresets(inheritedVariant)
      assert.equal(preset.assignments.alpha.variant, undefined)
      assert.deepEqual(Object.keys(preset.assignments.alpha), ["model"])
      assert.deepEqual(
        partitionPresetAssignments(preset.assignments, ["alpha"], [{ id: "own-model", variants: [] }]),
        { valid: { alpha: { model: "own-model" } }, stale: [] },
      )
    } finally {
      for (const [key, descriptor] of previousDescriptors) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor)
        else Reflect.deleteProperty(Object.prototype, key)
      }
    }
    pass("shouldRejectInheritedPresetFieldsAndIgnoreInheritedOptionalValues")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldLoadOnlyMissingPresetStorageAsEmptyWhenReadFailsOtherwise(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-read."))
  try {
    // Given
    const missingFile = path.join(scratch, "missing.json")
    const directory = path.join(scratch, "directory")
    await mkdir(directory)

    // When
    const missing = await loadPresets(missingFile)

    // Then
    assert.deepEqual(missing, [])
    await assert.rejects(
      () => loadPresets(directory),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(directory))
        assert.match(error.message, /unable to read|read failed/i)
        return true
      },
    )
    pass("shouldLoadOnlyMissingPresetStorageAsEmptyWhenReadFailsOtherwise")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldRejectInvalidUtf8BeforeLoadingOrMutatingPresetStorage(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-utf8."))
  try {
    // Given invalid UTF-8 bytes inside an otherwise valid preset document
    const file = path.join(scratch, "model-configurator-presets.json")
    const invalidBytes = Buffer.concat([
      Buffer.from('{"version":1,"presets":[{"name":"'),
      Buffer.from([0x80]),
      Buffer.from('","savedAt":"now","assignments":{}}]}\n'),
    ])
    await writeFile(file, invalidBytes)
    const entriesBeforeMutation = (await readdir(scratch)).sort()

    // When storage is loaded directly or as the source of a save
    const operations = [
      () => loadPresets(file),
      () => savePreset(file, { name: "new", savedAt: "now", assignments: {} }),
    ]

    // Then both reject with a file-qualified UTF-8 reason and preserve every byte
    for (const operation of operations) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(file))
        assert.match(error.message, /UTF-8/i)
        return true
      })
      assert.deepEqual(await readFile(file), invalidBytes)
      assert.deepEqual((await readdir(scratch)).sort(), entriesBeforeMutation)
    }
    pass("shouldRejectInvalidUtf8BeforeLoadingOrMutatingPresetStorage")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldReturnEveryValidPresetSortedWithoutNormalization(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-valid."))
  try {
    // Given
    const file = path.join(scratch, "model-configurator-presets.json")
    const expected = [
      { name: "a", savedAt: "", assignments: { beta: { model: "m", variant: "" } } },
      { name: "z", savedAt: "  saved exactly  ", assignments: { alpha: { model: " model exactly " } } },
    ]
    await writeJson(file, { version: 1, presets: [expected[1], expected[0]] })

    // When
    const actual = await loadPresets(file)

    // Then
    assert.deepEqual(actual, expected)
    pass("shouldReturnEveryValidPresetSortedWithoutNormalization")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldRejectSaveAndDeleteBeforeWritingWhenStorageBecomesInvalid(): Promise<void> {
  const operations = [
    {
      name: "save",
      run: (file: string) =>
        savePreset(file, { name: "new", savedAt: "2026-01-03T00:00:00.000Z", assignments: { gamma: { model: "google/new" } } }),
    },
    {
      name: "delete",
      run: (file: string) => deletePreset(file, "existing"),
    },
  ]

  for (const operation of operations) {
    const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-reject."))
    try {
      // Given valid storage that becomes invalid immediately before the mutation
      const file = path.join(scratch, "model-configurator-presets.json")
      await writeJson(file, {
        version: 1,
        presets: [{ name: "existing", savedAt: "2026-01-01T00:00:00.000Z", assignments: { alpha: { model: "openai/old" } } }],
      })
      const invalidBytes = Buffer.from('{"version":1,"presets":[{"name":"","savedAt":"now","assignments":{}}]}\n')
      await writeFile(file, invalidBytes)
      const bytesBeforeMutation = await readFile(file)
      const entriesBeforeMutation = (await readdir(scratch)).sort()

      // When
      await assert.rejects(() => operation.run(file), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(file))
        assert.match(error.message, /Invalid preset storage/)
        return true
      })

      // Then the invalid bytes and directory contents remain byte-for-byte unchanged
      assert.deepEqual(await readFile(file), bytesBeforeMutation, `${operation.name} changed rejected storage`)
      assert.deepEqual((await readdir(scratch)).sort(), entriesBeforeMutation, `${operation.name} left a temporary artifact`)
      assert.deepEqual(await readFile(file), invalidBytes, `${operation.name} did not preserve the original byte buffer`)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  pass("shouldRejectSaveAndDeleteBeforeWritingWhenStorageBecomesInvalid")
}

async function shouldUseLatestValidStorageForMutationsAndSupportFirstSave(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-latest."))
  try {
    // Given a missing storage file
    const firstSaveFile = path.join(scratch, "first-save.json")
    const first = { name: "first", savedAt: "2026-01-01T00:00:00.000Z", assignments: { alpha: { model: "openai/first" } } }

    // When the first preset is saved
    await savePreset(firstSaveFile, first)

    // Then missing storage supports the first save
    assert.deepEqual(await loadPresets(firstSaveFile), [first])

    // Given a valid file loaded before an external save changes it
    const saveFile = path.join(scratch, "external-save.json")
    await writeJson(saveFile, {
      version: 1,
      presets: [{ name: "old", savedAt: "2026-01-01T00:00:00.000Z", assignments: { alpha: { model: "openai/old" } } }],
    })
    await loadPresets(saveFile)
    const externalSave = { name: "external", savedAt: "2026-01-02T00:00:00.000Z", assignments: { beta: { model: "anthropic/external" } } }
    await writeJson(saveFile, { version: 1, presets: [externalSave] })

    // When a new preset is saved after that external change
    await savePreset(saveFile, first)

    // Then the new preset is merged with the latest external content
    assert.deepEqual(await loadPresets(saveFile), [externalSave, first])

    // Given an externally changed file containing the name being overwritten and an unrelated latest entry
    const overwriteFile = path.join(scratch, "external-overwrite.json")
    const overwritten = { name: "saved", savedAt: "2026-01-03T00:00:00.000Z", assignments: { gamma: { model: "google/old" } } }
    const unrelated = { name: "unrelated", savedAt: "2026-01-04T00:00:00.000Z", assignments: { delta: { model: "google/unrelated" } } }
    await writeJson(overwriteFile, { version: 1, presets: [{ name: "saved", savedAt: "stale", assignments: {} }] })
    await loadPresets(overwriteFile)
    await writeJson(overwriteFile, { version: 1, presets: [overwritten, unrelated] })

    // When the existing name is overwritten
    const replacement = { name: "saved", savedAt: "2026-01-05T00:00:00.000Z", assignments: { epsilon: { model: "openai/replacement" } } }
    await savePreset(overwriteFile, replacement)

    // Then the latest unrelated entry survives the overwrite
    assert.deepEqual(await loadPresets(overwriteFile), [replacement, unrelated])

    // Given an externally changed file containing the name being deleted and an unrelated latest entry
    const deleteFile = path.join(scratch, "external-delete.json")
    const deleted = { name: "delete-me", savedAt: "2026-01-06T00:00:00.000Z", assignments: { zeta: { model: "openai/delete" } } }
    const retained = { name: "retain-me", savedAt: "2026-01-07T00:00:00.000Z", assignments: { eta: { model: "anthropic/retain" } } }
    await writeJson(deleteFile, { version: 1, presets: [deleted] })
    await loadPresets(deleteFile)
    await writeJson(deleteFile, { version: 1, presets: [deleted, retained] })

    // When the externally present preset is deleted
    await deletePreset(deleteFile, deleted.name)

    // Then the latest unrelated entry remains
    assert.deepEqual(await loadPresets(deleteFile), [retained])
    pass("shouldUseLatestValidStorageForMutationsAndSupportFirstSave")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldWriteExactV1BytesAndCleanTemporaryFilesAfterAtomicMutations(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-atomic."))
  try {
    // Given missing storage and a first preset
    const file = path.join(scratch, "model-configurator-presets.json")
    const first = { name: "first", savedAt: "2026-01-01T00:00:00.000Z", assignments: { alpha: { model: "openai/first" } } }

    // When the first save succeeds
    await savePreset(file, first)

    // Then the target contains the exact complete v1 document and no temporary file remains
    assert.deepEqual(
      await readFile(file),
      Buffer.from(
        '{\n  "version": 1,\n  "presets": [\n    {\n      "name": "first",\n      "savedAt": "2026-01-01T00:00:00.000Z",\n      "assignments": {\n        "alpha": {\n          "model": "openai/first"\n        }\n      }\n    }\n  ]\n}\n',
      ),
    )
    assert.deepEqual(await readdir(scratch), ["model-configurator-presets.json"])

    // Given a second preset in the valid target
    const second = { name: "second", savedAt: "2026-01-02T00:00:00.000Z", assignments: { beta: { model: "anthropic/second", variant: "high" } } }
    await savePreset(file, second)

    // When the first preset is effectively deleted
    await deletePreset(file, first.name)

    // Then replacement is exact and the atomic temporary file is cleaned up
    assert.deepEqual(
      await readFile(file),
      Buffer.from(
        '{\n  "version": 1,\n  "presets": [\n    {\n      "name": "second",\n      "savedAt": "2026-01-02T00:00:00.000Z",\n      "assignments": {\n        "beta": {\n          "model": "anthropic/second",\n          "variant": "high"\n        }\n      }\n    }\n  ]\n}\n',
      ),
    )
    assert.deepEqual(await readdir(scratch), ["model-configurator-presets.json"])
    pass("shouldWriteExactV1BytesAndCleanTemporaryFilesAfterAtomicMutations")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldPreserveUnownedTemporaryFileWhenExclusiveOpenCollides(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-presets-collision."))
  const originalRandomBytes = crypto.randomBytes
  const OriginalDate = Date
  try {
    // Given another writer owns the exact temporary path selected for this save
    const file = path.join(scratch, "model-configurator-presets.json")
    const temporary = `${file}.20260102030405-abcdef.tmp`
    const unownedBytes = Buffer.from("another writer is still using this file\n")
    await writeFile(temporary, unownedBytes)
    crypto.randomBytes = ((size: number) => {
      assert.equal(size, 3)
      return Buffer.from("abcdef", "hex")
    }) as typeof crypto.randomBytes
    globalThis.Date = class extends OriginalDate {
      constructor() {
        super("2026-01-02T03:04:05.000Z")
      }
    } as DateConstructor
    syncBuiltinESMExports()

    // When exclusive creation detects the collision
    await assert.rejects(
      () => savePreset(file, { name: "new", savedAt: "2026-01-02T03:04:05.000Z", assignments: {} }),
      /EEXIST/,
    )

    // Then the colliding path remains owned and byte-for-byte unchanged
    assert.deepEqual(await readFile(temporary), unownedBytes)
    assert.deepEqual((await readdir(scratch)).sort(), [path.basename(temporary)])
    pass("shouldPreserveUnownedTemporaryFileWhenExclusiveOpenCollides")
  } finally {
    crypto.randomBytes = originalRandomBytes
    globalThis.Date = OriginalDate
    syncBuiltinESMExports()
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldOverwritePresetWhenSavingUnderExistingName(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a saved preset that differs from the current config
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    await savePreset(presetsPath, {
      name: "saved",
      savedAt: "2026-01-01T00:00:00.000Z",
      assignments: { alpha: { model: "openai/new", variant: "high" } },
    })
    const toasts: TuiToast[] = []
    let promptedValue: string | undefined
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "__preset__:saved")
        if (title === "Preset: saved") return option(options, "__apply_preset__")
        if (title.startsWith("Apply ")) return option(options, "__apply_save__")
        if (title === 'Overwrite preset "saved"?') return option(options, "__overwrite_preset__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
      prompt(title, value) {
        if (title !== "Preset name") throw new Error(`unexpected prompt dialog: ${title}`)
        promptedValue = value
        return "saved"
      },
    })

    // When the preset is re-applied and saved back under its existing name
    await runModelConfigurator(api, scratch.profiles)

    // Then the prompt opened empty (no default), the config was written, and the preset was overwritten in place
    assert.equal(promptedValue, undefined)
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old", variant: undefined },
    })
    const presets = await loadPresets(presetsPath)
    assert.equal(presets.length, 1)
    assert.equal(presets[0].name, "saved")
    assert.deepEqual(presets[0].assignments, {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old" },
    })
    pass("shouldOverwritePresetWhenSavingUnderExistingName")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldToastAndRepromptWhenPresetNameIsEmpty(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a group-browse run that ends in "Apply and save as preset"
    const presetsPath = path.join(scratch.global, "model-configurator-presets.json")
    const toasts: TuiToast[] = []
    let hubVisits = 0
    let groupVisits = 0
    let prompts = 0
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          hubVisits += 1
          return option(options, hubVisits === 1 ? "__group__:alpha" : "__review_changes__")
        }
        if (title === "alpha") {
          groupVisits += 1
          return option(options, groupVisits === 1 ? "alpha" : "__done__")
        }
        if (title === "Configure: alpha") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title.startsWith("Apply ")) return option(options, "__apply_save__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
      prompt(title) {
        if (title !== "Preset name") throw new Error(`unexpected prompt dialog: ${title}`)
        prompts += 1
        return prompts === 1 ? "   " : "x"
      },
    })

    // When the first name is blank
    await runModelConfigurator(api, scratch.profiles)

    // Then a warning toast fires, the prompt re-opens, and the second name is saved
    assert.equal(prompts, 2)
    assert.ok(toasts.some((toast) => toast.variant === "warning" && toast.message === "Preset name cannot be empty."))
    const presets = await loadPresets(presetsPath)
    assert.deepEqual(
      presets.map((preset) => preset.name),
      ["x"],
    )
    pass("shouldToastAndRepromptWhenPresetNameIsEmpty")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldGroupReviewChangesByParentAgent(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given pending changes in a claimed group and in the leftover bucket
    scratch.agents = [
      { name: "alpha", mode: "primary", task: [{ pattern: "*", action: "deny" }] },
      { name: "beta", mode: "subagent" },
    ]
    const toasts: TuiToast[] = []
    let hubVisits = 0
    let oneVisits = 0
    let twoVisits = 0
    let reviewRows: Array<{ value: string; category?: string }> = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          hubVisits += 1
          if (hubVisits === 1) return option(options, "__group__:alpha")
          if (hubVisits === 2) return option(options, "__group__:__other_subagents__")
          return option(options, "__review_changes__")
        }
        if (title === "alpha") {
          oneVisits += 1
          return option(options, oneVisits === 1 ? "alpha" : "__done__")
        }
        if (title === "Other subagents") {
          twoVisits += 1
          return option(options, twoVisits === 1 ? "beta" : "__done__")
        }
        if (title === "Configure: alpha" || title === "Configure: beta") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title.startsWith("Apply ")) {
          reviewRows = (options as Array<{ value: string; category?: string }>).filter((candidate) =>
            candidate.value.startsWith("__change__:"),
          )
          return option(options, "__apply__")
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then each change row is categorized by its parent group
    assert.deepEqual(
      reviewRows.map((row) => ({ value: row.value, category: row.category })),
      [
        { value: "__change__:alpha", category: "alpha" },
        { value: "__change__:beta", category: "Other subagents" },
      ],
    )
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldGroupReviewChangesByParentAgent")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldRevealInternalAgentsWhenHubTogglesThem(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given an agent OpenCode marks as internal
    scratch.agents = [
      { name: "alpha", mode: "primary", task: [{ pattern: "*", action: "deny" }, { pattern: "beta", action: "allow" }] },
      { name: "beta", mode: "subagent" },
      { name: "summary", mode: "subagent", hidden: true },
    ]
    let scopeVisits = 0
    let hubVisits = 0
    let titlesBefore: string[] = []
    let titlesAfter: string[] = []
    const api = createFakeApi(scratch, [], {
      select(title, options) {
        if (title === "Configuration scope") {
          scopeVisits += 1
          return scopeVisits === 1 ? option(options, "project") : "escape"
        }
        if (title === "Agents") {
          hubVisits += 1
          if (hubVisits === 1) {
            titlesBefore = options.map((candidate) => candidate.title)
            return option(options, "__toggle_hidden__")
          }
          titlesAfter = options.map((candidate) => candidate.title)
          return "escape"
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then internal agents stay out of the hub until the toggle brings them back
    assert.equal(titlesBefore.includes("Other subagents"), false)
    assert.ok(titlesBefore.includes("Show internal agents"))
    assert.ok(titlesAfter.includes("Other subagents"))
    assert.ok(titlesAfter.includes("Hide internal agents"))
    pass("shouldRevealInternalAgentsWhenHubTogglesThem")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldConfigureAgentsWhenProfilesDirectoryIsMissing(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a standalone install that ships no profiles
    await rm(scratch.profiles, { recursive: true, force: true })
    const configFile = path.join(scratch.project, ".opencode", "opencode.jsonc")
    const toasts: TuiToast[] = []
    let hubVisits = 0
    let agentVisits = 0
    let hubCategories: Array<string | undefined> = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") {
          hubVisits += 1
          hubCategories = (options as Array<{ category?: string }>).map((candidate) => candidate.category)
          return hubVisits === 1 ? option(options, "__group__:alpha") : option(options, "__review_changes__")
        }
        if (title === "alpha") {
          agentVisits += 1
          return option(options, agentVisits === 1 ? "alpha" : "__done__")
        }
        if (title === "Configure: alpha") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the hub offers no profile rows and the agent flow still writes
    assert.equal(hubCategories.includes("Profiles"), false)
    const persisted = await readConfigSnapshot(configFile)
    assert.deepEqual(persisted.mappings.alpha, { model: "openai/new", variant: "high" })
    assert.equal(toasts.at(-1)?.variant, "success")
    pass("shouldConfigureAgentsWhenProfilesDirectoryIsMissing")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldSkipInvalidProfileWithWarningAndKeepTheRest(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a malformed profile next to a valid one
    await writeJson(path.join(scratch.profiles, "broken.json"), { tiers: { high: 5 } })
    const toasts: TuiToast[] = []
    let scopeVisits = 0
    let hubTitles: string[] = []
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") {
          scopeVisits += 1
          return scopeVisits === 1 ? option(options, "project") : "escape"
        }
        if (title === "Agents") {
          hubTitles = options.map((candidate) => candidate.title)
          return "escape"
        }
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the broken file only warns and the valid profile stays selectable
    const warning = toasts.find((toast) => toast.variant === "warning")
    assert.match(String(warning?.message), /Skipped profile .*broken\.json: tier 'high' must contain an agents array/)
    assert.ok(hubTitles.includes("default"))
    pass("shouldSkipInvalidProfileWithWarningAndKeepTheRest")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldStopWithGuidanceWhenServerCannotListAgents(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a server too old to answer GET /agent
    const toasts: TuiToast[] = []
    const api = createFakeApi(scratch, toasts, {
      select(title) {
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })
    ;(api as unknown as { client: { app: Record<string, unknown> } }).client.app = {}

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the run stops before any dialog with actionable guidance
    assert.equal(toasts.at(-1)?.variant, "error")
    assert.match(String(toasts.at(-1)?.message), /does not expose the agent list/)

    // And a server that answers with an empty list stops just as early
    scratch.agents = []
    const emptyToasts: TuiToast[] = []
    const emptyApi = createFakeApi(scratch, emptyToasts, {
      select(title) {
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })
    await runModelConfigurator(emptyApi, scratch.profiles)
    assert.equal(emptyToasts.at(-1)?.variant, "warning")
    assert.match(String(emptyToasts.at(-1)?.message), /reported no agents to configure/)
    pass("shouldStopWithGuidanceWhenServerCannotListAgents")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldPartitionPresetAssignmentsByLiveCatalog(): Promise<void> {
  // Given a live catalog and a preset referencing unknown agents, gone models, and gone variants
  const models = [
    { id: "openai/new", variants: ["high", "low"] },
    { id: "anthropic/old", variants: [] },
  ]

  // When
  const { valid, stale } = partitionPresetAssignments(
    {
      alpha: { model: "openai/new", variant: "high" },
      beta: { model: "anthropic/old" },
      known1: { model: "openai/gone" },
      known2: { model: "openai/new", variant: "gone" },
      gamma: { model: "openai/new" },
      // A built-in agent is as configurable as any other now that the catalog comes from the server.
      plan: { model: "openai/new", variant: "low" },
    },
    ["alpha", "beta", "known1", "known2", "plan"],
    models,
  )

  // Then only live agent/model/variant triples survive; the rest are stale and sorted
  assert.deepEqual(valid, {
    alpha: { model: "openai/new", variant: "high" },
    beta: { model: "anthropic/old" },
    plan: { model: "openai/new", variant: "low" },
  })
  assert.deepEqual(stale, ["gamma", "known1", "known2"])
  pass("shouldPartitionPresetAssignmentsByLiveCatalog")
}

async function shouldPlanGlobalHotApplyAsPatchWithLocalPreludeForDeletions(): Promise<void> {
  // Given a mix of a model set, an inherit, and a variant-removal-only set
  const changes: AgentChange[] = [
    { agent: "alpha", before: { model: "openai/old" }, after: { model: "openai/new", variant: "high" }, action: "set" },
    { agent: "beta", before: { model: "anthropic/old" }, after: {}, action: "inherit" },
    { agent: "gamma", before: { model: "openai/keep", variant: "low" }, after: { model: "openai/keep" }, action: "set" },
  ]

  // When
  const plan = planGlobalHotApply(changes)

  // Then deletions go to the local prelude and PATCHable leaves to the payload
  assert.equal(plan.strategy, "patch")
  if (plan.strategy !== "patch") return
  assert.deepEqual(plan.preludeChanges, [
    changes[1],
    { agent: "gamma", before: { model: "openai/keep", variant: "low" }, after: { model: "openai/keep" }, action: "set" },
  ])
  assert.deepEqual(plan.patch, {
    agent: {
      alpha: { model: "openai/new", variant: "high" },
      gamma: { model: "openai/keep" },
    },
  })
  assert.deepEqual(plan.fallbackChanges, [changes[0], changes[2]])
  pass("shouldPlanGlobalHotApplyAsPatchWithLocalPreludeForDeletions")
}

async function shouldPlanWriteOnlyWhenGlobalChangesAreRemovalOnly(): Promise<void> {
  // Given inherit-only changes, and separately a variant-removal-only set
  const inheritOnly: AgentChange[] = [
    { agent: "beta", before: { model: "anthropic/old" }, after: {}, action: "inherit" },
  ]
  const variantRemovalOnly: AgentChange[] = [
    { agent: "gamma", before: { model: "openai/keep", variant: "low" }, after: { model: "openai/keep" }, action: "set" },
  ]

  // Then neither has a byte-changing leaf the global PATCH could carry
  assert.equal(planGlobalHotApply(inheritOnly).strategy, "write-only")
  assert.equal(planGlobalHotApply(variantRemovalOnly).strategy, "write-only")
  pass("shouldPlanWriteOnlyWhenGlobalChangesAreRemovalOnly")
}

async function shouldHotApplyProjectScopeByDisposingTheProjectInstance(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-hot-apply."))
  try {
    // Given a project config snapshot and a client exposing instance disposal.
    // Like the SDK v2 generated groups, the fake is a class whose method reads
    // this — a detached (unbound) call fails here like it does in production.
    const file = path.join(scratch, "opencode.jsonc")
    await writeFile(file, '{\n  "agent": {\n    "alpha": {"model": "openai/old"}\n  }\n}\n')
    const snapshot = await readConfigSnapshot(file)
    class FakeInstanceGroup {
      disposedDirectories: string[] = []
      async dispose(parameters: { directory: string }) {
        this.disposedDirectories.push(parameters.directory)
        return { data: true }
      }
    }
    const instance = new FakeInstanceGroup()
    const client = { instance }
    const runtime = { config: scratch, worktree: "/work/project", directory: "/work/project" }
    const changes: AgentChange[] = [
      { agent: "alpha", before: { model: "openai/old" }, after: { model: "openai/new" }, action: "set" },
    ]

    // When
    const result = await applyConfigChanges(client, "project", runtime, snapshot, changes)

    // Then the write lands and the project instance is disposed once
    assert.deepEqual(result, { file, hotApplied: true })
    assert.deepEqual(instance.disposedDirectories, ["/work/project"])
    assert.deepEqual((await readConfigSnapshot(file)).mappings, { alpha: { model: "openai/new", variant: undefined } })
    pass("shouldHotApplyProjectScopeByDisposingTheProjectInstance")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldHotApplyGlobalScopeViaConfigPatchAfterLocalDeletions(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-hot-apply."))
  try {
    // Given a global config with an inherit target and a stale variant to delete
    const file = path.join(scratch, "opencode.jsonc")
    await writeFile(
      file,
      '{\n  // Keep me.\n  "agent": {\n    "alpha": {"model": "openai/old"},\n    "beta": {"model": "anthropic/old"},\n    "gamma": {"model": "openai/keep", "variant": "low"}\n  }\n}\n',
    )
    const snapshot = await readConfigSnapshot(file)
    // Class-based fake like the SDK v2 groups: update reads this, so an
    // unbound call fails here like it does in production.
    class FakeGlobalConfigGroup {
      patches: Array<{ config: unknown; fileAtPatchTime: string }> = []
      async update(parameters: { config: unknown }) {
        this.patches.push({ config: parameters.config, fileAtPatchTime: await readFile(file, "utf8") })
        return { data: {} }
      }
    }
    const globalConfig = new FakeGlobalConfigGroup()
    const client = { global: { config: globalConfig } }
    const runtime = { config: scratch, worktree: "/work/project", directory: "/work/project" }
    const changes: AgentChange[] = [
      { agent: "alpha", before: { model: "openai/old" }, after: { model: "openai/new", variant: "high" }, action: "set" },
      { agent: "beta", before: { model: "anthropic/old" }, after: {}, action: "inherit" },
      { agent: "gamma", before: { model: "openai/keep", variant: "low" }, after: { model: "openai/keep" }, action: "set" },
    ]

    // When
    const result = await applyConfigChanges(client, "global", runtime, snapshot, changes)

    // Then deletions were on disk before the PATCH, which carried only the set leaves
    assert.deepEqual(result, { file, hotApplied: true })
    assert.equal(globalConfig.patches.length, 1)
    assert.deepEqual(globalConfig.patches[0].config, {
      agent: { alpha: { model: "openai/new", variant: "high" }, gamma: { model: "openai/keep" } },
    })
    assert.equal(globalConfig.patches[0].fileAtPatchTime.includes("beta"), false)
    assert.equal(globalConfig.patches[0].fileAtPatchTime.includes("low"), false)
    assert.equal(globalConfig.patches[0].fileAtPatchTime.includes("// Keep me."), true)
    // And the set leaves stay with the server-side PATCH, not a second local write
    assert.deepEqual((await readConfigSnapshot(file)).mappings, {
      alpha: { model: "openai/old", variant: undefined },
      gamma: { model: "openai/keep", variant: undefined },
    })
    pass("shouldHotApplyGlobalScopeViaConfigPatchAfterLocalDeletions")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldFallBackToLocalWriteWhenGlobalPatchFails(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-hot-apply."))
  try {
    // Given a global PATCH that the server rejects
    const file = path.join(scratch, "opencode.jsonc")
    await writeFile(file, '{\n  "agent": {\n    "alpha": {"model": "openai/old"},\n    "beta": {"model": "anthropic/old"}\n  }\n}\n')
    const snapshot = await readConfigSnapshot(file)
    const client = {
      global: {
        config: {
          update: async () => ({ error: { name: "BadRequest" }, response: { status: 400 } }),
        },
      },
    }
    const runtime = { config: scratch, worktree: "/work/project", directory: "/work/project" }
    const changes: AgentChange[] = [
      { agent: "alpha", before: { model: "openai/old" }, after: { model: "openai/new" }, action: "set" },
      { agent: "beta", before: { model: "anthropic/old" }, after: {}, action: "inherit" },
    ]

    // When
    const result = await applyConfigChanges(client, "global", runtime, snapshot, changes)

    // Then every change still lands locally and the outcome reports the failure
    assert.equal(result.hotApplied, false)
    assert.equal(result.detail?.includes("status 400"), true)
    assert.deepEqual((await readConfigSnapshot(file)).mappings, { alpha: { model: "openai/new", variant: undefined } })
    pass("shouldFallBackToLocalWriteWhenGlobalPatchFails")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldReportRestartFallbackWhenClientLacksHotApplyRoutes(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "model-configurator-hot-apply."))
  try {
    // Given clients without the disposal and global config update capabilities
    const file = path.join(scratch, "opencode.jsonc")
    await writeFile(file, '{\n  "agent": {\n    "alpha": {"model": "openai/old"}\n  }\n}\n')
    const runtime = { config: scratch, worktree: "/work/project", directory: "/work/project" }
    const changes: AgentChange[] = [
      { agent: "alpha", before: { model: "openai/old" }, after: { model: "openai/new" }, action: "set" },
    ]

    // When / Then the write still lands and the outcome degrades to restart guidance
    const project = await applyConfigChanges({}, "project", runtime, await readConfigSnapshot(file), changes)
    assert.equal(project.hotApplied, false)
    assert.equal(project.detail?.includes("instance disposal"), true)
    assert.deepEqual((await readConfigSnapshot(file)).mappings, { alpha: { model: "openai/new", variant: undefined } })

    const back: AgentChange[] = [
      { agent: "alpha", before: { model: "openai/new" }, after: { model: "openai/old" }, action: "set" },
    ]
    const global = await applyConfigChanges({}, "global", runtime, await readConfigSnapshot(file), back)
    assert.equal(global.hotApplied, false)
    assert.equal(global.detail?.includes("global config route"), true)
    assert.deepEqual((await readConfigSnapshot(file)).mappings, { alpha: { model: "openai/old", variant: undefined } })
    pass("shouldReportRestartFallbackWhenClientLacksHotApplyRoutes")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function shouldToastLiveApplyWhenProjectInstanceDisposalSucceeds(): Promise<void> {
  const scratch = await createWizardFixture()
  try {
    // Given a wizard client that can dispose the project instance
    const toasts: TuiToast[] = []
    class FakeInstanceGroup {
      disposedDirectories: string[] = []
      async dispose(parameters: { directory: string }) {
        this.disposedDirectories.push(parameters.directory)
        return { data: true }
      }
    }
    const instanceGroup = new FakeInstanceGroup()
    const api = createFakeApi(scratch, toasts, {
      select(title, options) {
        if (title === "Configuration scope") return option(options, "project")
        if (title === "Agents") return option(options, "default")
        if (title === "Tier: high") return option(options, "openai/new")
        if (title === "Variant for openai/new") return option(options, "high")
        if (title === "Tier: low") return option(options, "__keep_current__")
        if (title === "Individual overrides") return option(options, "__override_no__")
        if (title.startsWith("Apply ")) return option(options, "__apply__")
        throw new Error(`unexpected select dialog: ${title}`)
      },
      confirm() {
        return true
      },
    })
    ;(api.client as unknown as Record<string, unknown>).instance = instanceGroup

    // When
    await runModelConfigurator(api, scratch.profiles)

    // Then the success toast reports a live apply and the project instance was disposed
    assert.deepEqual(instanceGroup.disposedDirectories, [scratch.project])
    assert.equal(toasts.at(-1)?.variant, "success")
    assert.equal(toasts.at(-1)?.message?.includes("Applied live"), true)
    pass("shouldToastLiveApplyWhenProjectInstanceDisposalSucceeds")
  } finally {
    await rm(scratch.root, { recursive: true, force: true })
  }
}

async function shouldShortenConfigFilePathsForDisplay(): Promise<void> {
  // Given
  const runtime = { config: path.join(homedir(), ".config", "opencode"), worktree: "/work/project", directory: "/work/project" }

  // Then project paths are relative to the project root
  assert.equal(
    displayConfigFile("project", path.join("/work", "project", ".opencode", "opencode.jsonc"), runtime),
    path.join(".opencode", "opencode.jsonc"),
  )
  // And global paths under home collapse the home prefix to ~
  assert.equal(
    displayConfigFile("global", path.join(homedir(), ".config", "opencode", "opencode.jsonc"), runtime),
    `~${path.sep}${path.join(".config", "opencode", "opencode.jsonc")}`,
  )
  // And global paths outside home stay absolute
  assert.equal(displayConfigFile("global", "/etc/opencode/opencode.jsonc", runtime), "/etc/opencode/opencode.jsonc")
  pass("shouldShortenConfigFilePathsForDisplay")
}

/** Fixture shorthand for a server agent: `task` rules are appended after OpenCode's catch-all default. */
type FixtureAgent = {
  name: string
  mode?: "primary" | "subagent" | "all"
  native?: boolean
  hidden?: boolean
  task?: Array<{ pattern: string; action: "allow" | "deny" | "ask" }>
}

type WizardFixture = {
  root: string
  data: string
  profiles: string
  project: string
  global: string
  /** Mutable so a contract can reshape the live agent list before running the wizard. */
  agents: FixtureAgent[]
}

type PolicyOption = { title: string; value: string; description?: string; category?: string; disabled?: boolean }

type DialogPolicy = {
  select: (title: string, options: Array<PolicyOption>) => PolicyOption | "escape"
  confirm: (title: string) => boolean | "escape"
  prompt?: (title: string, value?: string) => string | "escape"
}

async function createWizardFixture(): Promise<WizardFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "model-configurator-wizard."))
  const data = path.join(root, "runtime-data")
  const profiles = path.join(data, "profiles")
  const project = path.join(root, "project")
  const global = path.join(root, "global")
  await Promise.all([
    writeJson(path.join(profiles, "default.json"), {
      name: "default",
      description: "Fixture profile",
      tiers: {
        high: { description: "High", variant: "high", agents: ["alpha"] },
        low: { description: "Low", agents: ["beta"] },
      },
    }),
    writeJsonc(
      path.join(project, ".opencode", "opencode.jsonc"),
      '{\n  // Preserve me.\n  "agent": {\n    "alpha": {"model": "openai/old"},\n    "beta": {"model": "anthropic/old"}\n  },\n  "foreign": true\n}\n',
    ),
  ])
  return {
    root,
    data,
    profiles,
    project,
    global,
    // `alpha` allowlists `beta`, so the hub shows one group holding both.
    agents: [
      { name: "alpha", mode: "primary", task: [{ pattern: "*", action: "deny" }, { pattern: "beta", action: "allow" }] },
      { name: "beta", mode: "subagent" },
    ],
  }
}

/** Builds the same agent list the wizard sees, through the same normalizer. */
function liveAgents(...agents: FixtureAgent[]): LiveAgent[] {
  return normalizeLiveAgents({ data: agents.map(toServerAgent) })
}

/** Mirrors how OpenCode resolves a ruleset: the catch-all default first, agent rules after it. */
function toServerAgent(agent: FixtureAgent): Record<string, unknown> {
  return {
    name: agent.name,
    mode: agent.mode ?? "subagent",
    native: agent.native ?? false,
    hidden: agent.hidden ?? false,
    permission: [
      { permission: "*", pattern: "*", action: "allow" },
      ...(agent.task ?? []).map((rule) => ({ permission: "task", pattern: rule.pattern, action: rule.action })),
    ],
  }
}

function createFakeApi(
  fixture: WizardFixture,
  toasts: TuiToast[],
  policy: DialogPolicy,
): TuiPluginApi {
  let currentOnClose: (() => void) | undefined
  const dialog = {
    replace(render: () => unknown, onClose?: () => void) {
      currentOnClose = onClose
      render()
    },
    clear() {},
    setSize() {},
    size: "medium" as const,
    depth: 0,
    open: false,
  }
  const api = {
    state: {
      ready: true,
      path: { state: fixture.root, config: fixture.global, worktree: fixture.project, directory: fixture.project },
    },
    client: {
      app: {
        async agents() {
          return { data: fixture.agents.map(toServerAgent) }
        },
      },
      provider: {
        async list() {
          return {
            data: {
              connected: ["openai", "anthropic"],
              all: [
                { id: "openai", models: { new: { variants: { high: {}, low: {}, none: {} } } } },
                { id: "anthropic", models: { old: { variants: {} } } },
              ],
            },
          }
        },
      },
    },
    ui: {
      dialog,
      toast(input: TuiToast) {
        toasts.push(input)
      },
      DialogSelect<Value extends string>(props: TuiDialogSelectProps<Value>) {
        const onClose = currentOnClose
        queueMicrotask(() => {
          const answer = policy.select(props.title, props.options as unknown as PolicyOption[])
          if (answer === "escape") onClose?.()
          else props.onSelect?.(answer as TuiDialogSelectProps<Value>["options"][number])
        })
        return undefined
      },
      DialogConfirm(props: TuiDialogConfirmProps) {
        const onClose = currentOnClose
        queueMicrotask(() => {
          const answer = policy.confirm(props.title)
          if (answer === "escape") onClose?.()
          else if (answer) props.onConfirm?.()
          else props.onCancel?.()
        })
        return undefined
      },
      DialogPrompt(props: TuiDialogPromptProps) {
        const onClose = currentOnClose
        queueMicrotask(() => {
          if (!policy.prompt) throw new Error(`unexpected prompt dialog: ${props.title}`)
          const answer = policy.prompt(props.title, props.value)
          if (answer === "escape") onClose?.()
          else props.onConfirm?.(answer)
        })
        return undefined
      },
    },
  }
  return api as unknown as TuiPluginApi
}

function option<Value extends string>(
  options: Array<{ title: string; value: Value }>,
  value: Value,
): { title: string; value: Value } {
  const selected = options.find((candidate) => candidate.value === value)
  assert.ok(selected, `missing dialog option ${value}`)
  return selected
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeJsonc(file, `${JSON.stringify(value, undefined, 2)}\n`)
}

async function writeJsonc(file: string, content: string): Promise<void> {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  await writeFile(file, content)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function fixtureChanges(): AgentChange[] {
  return [
    {
      agent: "alpha",
      before: { model: "openai/old", variant: "high" },
      after: { model: "openai/new" },
      action: "set",
    },
    {
      agent: "beta",
      before: { model: "anthropic/old", variant: "low" },
      after: {},
      action: "inherit",
    },
    {
      agent: "gamma",
      before: { model: "google/old" },
      after: {},
      action: "inherit",
    },
  ]
}

function pass(name: string): void {
  passes += 1
  process.stdout.write(`PASS ${name}\n`)
}

await shouldNormalizeProfilesDirectoryWhenPluginOptionsAreProvided()
await shouldResolveConfiguredProfilesDirectoryRelativeToActiveProject()
await shouldDeclareEveryExampleRootKeyWhenProfileSchemaIsStrict()
await shouldValidateProfileAsWholeContractWhenProfileIsComplete()
await shouldRejectDuplicateAndMalformedAgentsWhenProfileIsInvalid()
await shouldKeepKnownAgentsAndWarnWhenTierReferencesAgentsMissingOnThisServer()
await shouldExposeOnlyConnectedProvidersWhenCatalogContainsDisconnectedEntries()
await shouldCalculateOnlyChangedAssignmentsWhenDecisionsMixActions()
await shouldFormatMappingCompactlyWithAtVariant()
await shouldPreserveForeignJsoncWhenRenderingAssignmentChanges()
await shouldWriteWithoutBackupAndPreserveModeWhenWriteSucceeds()
await shouldRejectConcurrentEditBeforeWriting()
await shouldRestoreOriginalWhenInjectedPersistenceStepFails()
await shouldCompleteStagedWizardAndPersistSelectedChanges()
await shouldKeepCoreConfigurationUsableWhenPresetStorageIsUnavailable()
await shouldKeepCoreConfigurationUsableWhenPresetStorageIsUnreadable()
await shouldRestorePresetStorageWhenWizardReopensAfterRepair()
await shouldLeaveConfigUntouchedWhenFinalReviewIsCancelled()
await shouldReshowPreviousDialogWhenEscapingBack()
await shouldExitWithoutWritingWhenScopeIsEscaped()
await shouldSavePresetWhenApplyingAndSaving()
await shouldRejectForbiddenLiveAgentAssignmentsBeforeReplacingPresetStorage()
await shouldApplyPresetSkippingTiersAndOverrides()
await shouldDeletePresetWithoutTouchingConfig()
await shouldKeepCoreApplyAndReportPresetSaveFailureWhenStorageBecomesInvalid()
await shouldClearPresetUiAndReportDeleteFailureWhenStorageBecomesInvalid()
await shouldOpenAdjacentAgentViaNextAgent()
await shouldPreserveOverridesWhenEscapingAgentChooser()
await shouldConfigureAgentThroughGroupBrowseAndApply()
await shouldApplyDecisionToEveryAgentInGroupThroughAllOption()
await shouldClearGroupDecisionsWhenAllAgentsKeepsCurrent()
await shouldOfferSingleDefaultOptionWhenCatalogIncludesNoneVariant()
await shouldSkipVariantDialogWhenModelHasNoVariants()
await shouldWalkBackFromGroupAgentsToScopeWithoutWriting()
await shouldNormalizeLiveAgentsWhenServerAnswersAgentList()
await shouldDeriveParentChildGroupsFromTaskPermissions()
await shouldRepeatSubagentUnderEveryParentThatClaimsIt()
await shouldExcludeInternalAgentsUntilTheyAreRevealed()
await shouldMatchAnchoredGlobsWhenEvaluatingPermissionPatterns()
await shouldRoundTripAndOverwritePresetsWhenSaved()
await shouldRejectEveryInvalidPresetStorageShapeWhenLoaded()
await shouldRejectInheritedPresetFieldsAndIgnoreInheritedOptionalValues()
await shouldLoadOnlyMissingPresetStorageAsEmptyWhenReadFailsOtherwise()
await shouldRejectInvalidUtf8BeforeLoadingOrMutatingPresetStorage()
await shouldReturnEveryValidPresetSortedWithoutNormalization()
await shouldRejectSaveAndDeleteBeforeWritingWhenStorageBecomesInvalid()
await shouldUseLatestValidStorageForMutationsAndSupportFirstSave()
await shouldWriteExactV1BytesAndCleanTemporaryFilesAfterAtomicMutations()
await shouldPreserveUnownedTemporaryFileWhenExclusiveOpenCollides()
await shouldOverwritePresetWhenSavingUnderExistingName()
await shouldToastAndRepromptWhenPresetNameIsEmpty()
await shouldGroupReviewChangesByParentAgent()
await shouldRevealInternalAgentsWhenHubTogglesThem()
await shouldConfigureAgentsWhenProfilesDirectoryIsMissing()
await shouldSkipInvalidProfileWithWarningAndKeepTheRest()
await shouldStopWithGuidanceWhenServerCannotListAgents()
await shouldPartitionPresetAssignmentsByLiveCatalog()
await shouldPlanGlobalHotApplyAsPatchWithLocalPreludeForDeletions()
await shouldPlanWriteOnlyWhenGlobalChangesAreRemovalOnly()
await shouldHotApplyProjectScopeByDisposingTheProjectInstance()
await shouldHotApplyGlobalScopeViaConfigPatchAfterLocalDeletions()
await shouldFallBackToLocalWriteWhenGlobalPatchFails()
await shouldReportRestartFallbackWhenClientLacksHotApplyRoutes()
await shouldToastLiveApplyWhenProjectInstanceDisposalSucceeds()
await shouldShortenConfigFilePathsForDisplay()
process.stdout.write(`PASS: ${passes} TypeScript model configurator contracts.\n`)
