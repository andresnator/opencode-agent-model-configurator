import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import type { ModelOption } from "./domain"
import { globalConfigRoot, type RuntimePaths } from "./persistence"

const PRESETS_FILE = "model-configurator-presets.json"
const PRESETS_VERSION = 1
const DEFAULT_FILE_MODE = 0o600

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
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  const rawPresets = isRecord(parsed) && Array.isArray(parsed.presets) ? parsed.presets : []
  const presets: StoredPreset[] = []
  for (const raw of rawPresets) {
    const preset = normalizePreset(raw)
    if (preset) presets.push(preset)
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

function normalizePreset(raw: unknown): StoredPreset | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) return undefined
  const assignments: Record<string, PresetAssignment> = {}
  if (isRecord(raw.assignments)) {
    for (const [agent, value] of Object.entries(raw.assignments)) {
      if (agent === "__proto__" || agent === "constructor" || agent === "prototype") continue
      if (!isRecord(value) || typeof value.model !== "string") continue
      const assignment: PresetAssignment = { model: value.model }
      if (typeof value.variant === "string") assignment.variant = value.variant
      assignments[agent] = assignment
    }
  }
  return { name: raw.name, savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "", assignments }
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
