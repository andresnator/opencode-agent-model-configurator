import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, type FormattingOptions, type ParseError, printParseErrorCode } from "jsonc-parser"
import type { AgentChange, AgentMapping } from "./domain"

const CONFIG_JSON = "opencode.json"
const CONFIG_JSONC = "opencode.jsonc"
const DEFAULT_FILE_MODE = 0o600
const FORMATTING_OPTIONS: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }

export type ConfigScope = "global" | "project"

export type RuntimePaths = {
  config: string
  worktree: string
  directory: string
}

export type ConfigSnapshot = {
  file: string
  exists: boolean
  content: string
  mode: number
  mappings: Record<string, AgentMapping>
}

export type WriteResult = {
  file: string
}

export type PersistenceStep =
  | "temporary-open"
  | "temporary-write"
  | "temporary-flush"
  | "rename"
  | "destination-flush"
  | "post-validate"

export type PersistenceHooks = {
  before?: (step: PersistenceStep) => void | Promise<void>
}

export async function resolveConfigFile(scope: ConfigScope, runtime: RuntimePaths): Promise<string> {
  const root = scope === "global" ? globalConfigRoot(runtime) : projectConfigRoot(runtime)
  const jsonc = path.join(root, CONFIG_JSONC)
  const json = path.join(root, CONFIG_JSON)
  if (await exists(jsonc)) return jsonc
  if (await exists(json)) return json
  return json
}

export async function readConfigSnapshot(file: string): Promise<ConfigSnapshot> {
  try {
    const [content, metadata] = await Promise.all([readFile(file, "utf8"), stat(file)])
    const config = parseConfig(content, file)
    return { file, exists: true, content, mode: metadata.mode & 0o777, mappings: extractMappings(config) }
  } catch (error) {
    if (!isMissing(error)) throw error
    return { file, exists: false, content: "{}\n", mode: DEFAULT_FILE_MODE, mappings: {} }
  }
}

export function renderConfigChanges(snapshot: ConfigSnapshot, changes: readonly AgentChange[]): string {
  let content = snapshot.content
  for (const change of changes) {
    if (change.action === "inherit") {
      content = edit(content, ["agent", change.agent, "model"], undefined)
      content = edit(content, ["agent", change.agent, "variant"], undefined)
      const parsed = parseConfig(content, snapshot.file)
      const agent = isRecord(parsed.agent) && isRecord(parsed.agent[change.agent]) ? parsed.agent[change.agent] : undefined
      if (agent && Object.keys(agent).length === 0) content = edit(content, ["agent", change.agent], undefined)
    } else {
      content = edit(content, ["agent", change.agent, "model"], change.after.model)
      content = edit(content, ["agent", change.agent, "variant"], change.after.variant)
    }
  }

  const parsed = parseConfig(content, snapshot.file)
  if (isRecord(parsed.agent) && Object.keys(parsed.agent).length === 0) content = edit(content, ["agent"], undefined)
  parseConfig(content, snapshot.file)
  return content
}

export async function writeConfigChanges(
  snapshot: ConfigSnapshot,
  changes: readonly AgentChange[],
  hooks: PersistenceHooks = {},
): Promise<WriteResult> {
  if (changes.length === 0) return { file: snapshot.file }
  const rendered = renderConfigChanges(snapshot, changes)
  if (rendered === snapshot.content) return { file: snapshot.file }

  await mkdir(path.dirname(snapshot.file), { recursive: true, mode: 0o700 })
  if (snapshot.exists) {
    const current = await readFile(snapshot.file, "utf8")
    if (current !== snapshot.content) throw new Error(`${snapshot.file} changed while the configurator was open; reload and retry`)
  } else if (await exists(snapshot.file)) {
    throw new Error(`${snapshot.file} was created while the configurator was open; reload and retry`)
  }

  const suffix = `${timestamp()}-${randomBytes(3).toString("hex")}`
  const temporary = `${snapshot.file}.${suffix}.tmp`

  try {
    await hooks.before?.("temporary-open")
    const handle = await open(temporary, "wx", snapshot.mode || DEFAULT_FILE_MODE)
    try {
      await hooks.before?.("temporary-write")
      await handle.writeFile(rendered, "utf8")
      await hooks.before?.("temporary-flush")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await hooks.before?.("rename")
    await rename(temporary, snapshot.file)
    await chmodFile(snapshot.file, snapshot.mode || DEFAULT_FILE_MODE)
    await hooks.before?.("destination-flush")
    await syncFile(snapshot.file)
    await syncDirectory(path.dirname(snapshot.file))

    await hooks.before?.("post-validate")
    const persisted = await readFile(snapshot.file, "utf8")
    parseConfig(persisted, snapshot.file)
    if (persisted !== rendered) throw new Error(`${snapshot.file} did not persist the expected content`)
    return { file: snapshot.file }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    if (snapshot.exists) await writeFile(snapshot.file, snapshot.content, { mode: snapshot.mode }).catch(() => undefined)
    else await rm(snapshot.file, { force: true }).catch(() => undefined)
    throw error
  }
}

export function higherPrecedenceWarning(): string | undefined {
  if (process.env.OPENCODE_CONFIG_CONTENT) return "OPENCODE_CONFIG_CONTENT can override values written here"
  if (process.env.OPENCODE_CONFIG) return "OPENCODE_CONFIG can override values written here"
  return undefined
}

export function globalConfigRoot(runtime: RuntimePaths): string {
  if (runtime.config) return runtime.config
  const xdgConfig = process.env.XDG_CONFIG_HOME
  return path.join(xdgConfig || path.join(homedir(), ".config"), "opencode")
}

function projectConfigRoot(runtime: RuntimePaths): string {
  const root = runtime.worktree && runtime.worktree !== "/" ? runtime.worktree : runtime.directory
  return path.join(root, ".opencode")
}

export function displayConfigFile(scope: ConfigScope, file: string, runtime: RuntimePaths): string {
  if (scope === "project") {
    const projectRoot = path.dirname(projectConfigRoot(runtime))
    const relative = path.relative(projectRoot, file)
    return relative.startsWith("..") ? file : relative
  }
  const home = homedir()
  if (file === home) return "~"
  if (file.startsWith(`${home}${path.sep}`)) return `~${file.slice(home.length)}`
  return file
}

function extractMappings(config: Record<string, unknown>): Record<string, AgentMapping> {
  if (!isRecord(config.agent)) return {}
  const mappings: Record<string, AgentMapping> = {}
  for (const [agent, value] of Object.entries(config.agent)) {
    if (!isRecord(value)) continue
    const model = typeof value.model === "string" ? value.model : undefined
    const variant = typeof value.variant === "string" ? value.variant : undefined
    mappings[agent] = { model, variant }
  }
  return mappings
}

function edit(content: string, jsonPath: (string | number)[], value: unknown): string {
  return applyEdits(content, modify(content, jsonPath, value, { formattingOptions: FORMATTING_OPTIONS }))
}

function parseConfig(content: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(`${file}:${first.offset}: ${printParseErrorCode(first.error)}`)
  }
  if (!isRecord(parsed)) throw new Error(`${file}: configuration root must be an object`)
  return parsed
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function chmodFile(file: string, mode: number): Promise<void> {
  const handle = await open(file, "r+")
  try {
    await handle.chmod(mode)
  } finally {
    await handle.close()
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
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

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}
