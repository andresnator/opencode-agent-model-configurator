import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises"
import path from "node:path"
import { TextDecoder } from "node:util"

export const ACTIVE_PRESET_FILE = "models-presets-active.json"

const ACTIVE_PRESET_VERSION = 1
const DEFAULT_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const ACTIVE_PRESET_DOCUMENT_KEYS = ["version", "activePreset"] as const
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export type ActivePresetDocument = {
  version: 1
  activePreset: string
}

export function activePresetFile(configFile: string): string {
  return path.join(path.dirname(configFile), ACTIVE_PRESET_FILE)
}

export async function loadActivePreset(file: string): Promise<string | undefined> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw unreadableActivePresetState(file, error)
  }

  let content: string
  try {
    content = FATAL_UTF8_DECODER.decode(bytes)
  } catch {
    throw invalidActivePresetState(file, "file is not valid UTF-8")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw invalidActivePresetState(file, "malformed JSON")
  }
  return validateActivePresetDocument(parsed, file).activePreset
}

export async function saveActivePreset(file: string, activePreset: string): Promise<void> {
  await loadActivePreset(file)
  const document: ActivePresetDocument = { version: ACTIVE_PRESET_VERSION, activePreset }
  validateActivePresetDocument(document, file)
  await writeActivePreset(file, document)
}

export async function clearActivePreset(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  await syncDirectory(path.dirname(file))
}

async function writeActivePreset(file: string, document: ActivePresetDocument): Promise<void> {
  const rendered = `${JSON.stringify(document, null, 2)}\n`
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const suffix = `${timestamp()}-${randomBytes(3).toString("hex")}`
  const temporary = `${file}.${suffix}.tmp`
  let temporaryOwned = false
  try {
    const handle = await open(temporary, "wx", DEFAULT_FILE_MODE)
    temporaryOwned = true
    try {
      await handle.writeFile(rendered, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    temporaryOwned = false
    await syncDirectory(directory)
  } catch (error) {
    if (temporaryOwned) await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function validateActivePresetDocument(raw: unknown, file: string): ActivePresetDocument {
  if (!isRecord(raw)) throw invalidActivePresetState(file, "root must be an object")
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) throw invalidActivePresetState(file, `root: forbidden key '${key}'`)
    if (!(ACTIVE_PRESET_DOCUMENT_KEYS as readonly string[]).includes(key)) {
      throw invalidActivePresetState(file, `root: unknown field '${key}'`)
    }
  }
  if (!Object.hasOwn(raw, "version")) throw invalidActivePresetState(file, "version is missing")
  if (raw.version !== ACTIVE_PRESET_VERSION) {
    throw invalidActivePresetState(file, `unsupported version ${String(raw.version)}`)
  }
  if (!Object.hasOwn(raw, "activePreset") || typeof raw.activePreset !== "string" || raw.activePreset.length === 0) {
    throw invalidActivePresetState(file, "activePreset must be a non-empty string")
  }
  return { version: ACTIVE_PRESET_VERSION, activePreset: raw.activePreset }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function invalidActivePresetState(file: string, reason: string): never {
  throw new Error(`Invalid active preset state at ${file}: ${reason}`)
}

function unreadableActivePresetState(file: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(`Unable to read active preset state at ${file}: ${reason}`)
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
