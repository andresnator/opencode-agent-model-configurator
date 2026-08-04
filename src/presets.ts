import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import type { ModelOption } from "./domain"
import { globalConfigRoot, type RuntimePaths } from "./persistence"

const PRESETS_FILE = "model-configurator-presets.json"
const PRESETS_VERSION = 1
const DEFAULT_FILE_MODE = 0o600
const PRESET_DOCUMENT_KEYS = ["version", "presets"] as const
const PRESET_KEYS = ["name", "savedAt", "assignments"] as const
const ASSIGNMENT_KEYS = ["model", "variant"] as const
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

export type PresetAssignment = {
  model: string
  variant?: string
}

export type StoredPreset = {
  name: string
  savedAt: string
  assignments: Record<string, PresetAssignment>
}

export type PartitionedAssignments = {
  valid: Record<string, PresetAssignment>
  stale: string[]
}

export function presetsFile(runtime: RuntimePaths): string {
  return path.join(globalConfigRoot(runtime), PRESETS_FILE)
}

export async function loadPresets(file: string): Promise<StoredPreset[]> {
  let content: string
  try {
    content = await readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return []
    throw unreadablePresetStorage(file, error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw invalidPresetStorage(file, "malformed JSON")
  }

  if (!isRecord(parsed)) throw invalidPresetStorage(file, "root must be an object")
  assertExactKeys(parsed, PRESET_DOCUMENT_KEYS, "root", file)
  if (!Object.hasOwn(parsed, "version")) throw invalidPresetStorage(file, "version is missing")
  if (typeof parsed.version !== "number") throw invalidPresetStorage(file, "version must be numeric")
  if (parsed.version !== PRESETS_VERSION) {
    throw invalidPresetStorage(file, `unsupported version ${String(parsed.version)}`)
  }
  if (!Object.hasOwn(parsed, "presets")) throw invalidPresetStorage(file, "presets is missing")
  if (!Array.isArray(parsed.presets)) throw invalidPresetStorage(file, "presets must be an array")

  const presets: StoredPreset[] = []
  const names = new Set<string>()
  for (const [index, raw] of parsed.presets.entries()) {
    const preset = validatePreset(raw, index, file)
    if (names.has(preset.name)) {
      throw invalidPresetStorage(file, `duplicate preset name '${preset.name}' at presets[${index}].name`)
    }
    names.add(preset.name)
    presets.push(preset)
  }
  return presets.sort((left, right) => left.name.localeCompare(right.name))
}

export async function savePreset(file: string, preset: StoredPreset): Promise<void> {
  const existing = await loadPresets(file)
  const next = existing.filter((entry) => entry.name !== preset.name)
  next.push(preset)
  next.sort((left, right) => left.name.localeCompare(right.name))
  await writePresets(file, next)
}

export async function deletePreset(file: string, name: string): Promise<void> {
  const existing = await loadPresets(file)
  const next = existing.filter((entry) => entry.name !== name)
  if (next.length === existing.length) return
  await writePresets(file, next)
}

export function partitionPresetAssignments(
  assignments: Readonly<Record<string, PresetAssignment>>,
  agents: readonly string[],
  models: readonly ModelOption[],
): PartitionedAssignments {
  const knownAgents = new Set(agents)
  const live = new Map(models.map((model) => [model.id, new Set(model.variants)]))
  const valid: Record<string, PresetAssignment> = {}
  const stale: string[] = []
  for (const [agent, assignment] of Object.entries(assignments)) {
    const variants = live.get(assignment.model)
    const usable =
      knownAgents.has(agent) && variants !== undefined && (!assignment.variant || variants.has(assignment.variant))
    if (usable) valid[agent] = assignment
    else stale.push(agent)
  }
  stale.sort()
  return { valid, stale }
}

async function writePresets(file: string, presets: readonly StoredPreset[]): Promise<void> {
  const rendered = `${JSON.stringify({ version: PRESETS_VERSION, presets }, null, 2)}\n`
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const suffix = `${timestamp()}-${randomBytes(3).toString("hex")}`
  const temporary = `${file}.${suffix}.tmp`
  try {
    const handle = await open(temporary, "wx", DEFAULT_FILE_MODE)
    try {
      await handle.writeFile(rendered, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    await syncDirectory(directory)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function validatePreset(raw: unknown, index: number, file: string): StoredPreset {
  const presetPath = `presets[${index}]`
  if (!isRecord(raw)) throw invalidPresetStorage(file, `${presetPath} must be an object`)
  assertExactKeys(raw, PRESET_KEYS, presetPath, file)
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw invalidPresetStorage(file, `${presetPath}.name must be a non-empty string`)
  }
  if (typeof raw.savedAt !== "string") throw invalidPresetStorage(file, `${presetPath}.savedAt must be a string`)
  if (!Object.hasOwn(raw, "assignments")) {
    throw invalidPresetStorage(file, `${presetPath}.assignments is missing`)
  }
  if (!isRecord(raw.assignments)) {
    throw invalidPresetStorage(file, `${presetPath}.assignments must be an object`)
  }
  for (const agent of Object.keys(raw.assignments)) {
    if (FORBIDDEN_KEYS.has(agent)) {
      throw invalidPresetStorage(file, `${presetPath}.assignments: forbidden key '${agent}'`)
    }
    const value = raw.assignments[agent]
    const assignmentPath = `${presetPath}.assignments.${agent}`
    if (!isRecord(value)) throw invalidPresetStorage(file, `${assignmentPath} must be an object`)
    assertExactKeys(value, ASSIGNMENT_KEYS, assignmentPath, file)
    if (typeof value.model !== "string" || value.model.length === 0) {
      throw invalidPresetStorage(file, `${assignmentPath}.model must be a non-empty string`)
    }
    if (Object.hasOwn(value, "variant") && typeof value.variant !== "string") {
      throw invalidPresetStorage(file, `${assignmentPath}.variant must be a string`)
    }
  }
  return {
    name: raw.name,
    savedAt: raw.savedAt,
    assignments: raw.assignments as Record<string, PresetAssignment>,
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  location: string,
  file: string,
): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw invalidPresetStorage(file, `${location}: forbidden key '${key}'`)
    if (!expectedKeys.includes(key)) throw invalidPresetStorage(file, `${location}: unknown field '${key}'`)
  }
}

function invalidPresetStorage(file: string, reason: string): never {
  throw new Error(`Invalid preset storage at ${file}: ${reason}`)
}

function unreadablePresetStorage(file: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(`Unable to read preset storage at ${file}: ${reason}`)
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error as { code?: string }).code === "ENOENT"
}
