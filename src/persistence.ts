import { randomBytes } from "node:crypto"
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, type FormattingOptions, type ParseError, printParseErrorCode } from "jsonc-parser"
import type { AgentChange, AgentMapping } from "./domain"

const CONFIG_JSON = "opencode.json"
const CONFIG_JSONC = "opencode.jsonc"
const DEFAULT_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
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

type WriteArtifacts = {
  directory: string
  temporary: string
  claim: string
  recovery: string
}

type WriteState = {
  destinationClaimed: boolean
  claimMatchesSnapshot: boolean
  destinationPublished: boolean
}

class ConfigWriteConflictError extends Error {}

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

  return writeConfigContent(snapshot, rendered, hooks)
}

export async function restoreConfigSnapshot(snapshot: ConfigSnapshot, expectedContent: string): Promise<void> {
  const conflictMessage = `${snapshot.file} rollback conflict: configuration changed after the plugin write; preserving newer content`
  if (!snapshot.exists) {
    let current: string
    try {
      current = await readFile(snapshot.file, "utf8")
    } catch (error) {
      if (isMissing(error)) throw new Error(conflictMessage)
      throw error
    }
    if (current !== expectedContent) throw new Error(conflictMessage)
    await rm(snapshot.file)
    await syncDirectory(path.dirname(snapshot.file))
    return
  }

  await writeConfigContent({ ...snapshot, exists: true, content: expectedContent }, snapshot.content, {}, conflictMessage)
}

async function writeConfigContent(
  snapshot: ConfigSnapshot,
  rendered: string,
  hooks: PersistenceHooks = {},
  conflictMessage?: string,
): Promise<WriteResult> {
  const directory = path.dirname(snapshot.file)
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  if (snapshot.exists) {
    let current: string
    try {
      current = await readFile(snapshot.file, "utf8")
    } catch (error) {
      if (isMissing(error)) throw configWriteConflict(snapshot, conflictMessage)
      throw error
    }
    if (current !== snapshot.content) {
      throw configWriteConflict(snapshot, conflictMessage)
    }
  } else if (await exists(snapshot.file)) {
    throw configWriteConflict(snapshot, conflictMessage)
  }

  const suffix = `${timestamp()}-${randomBytes(3).toString("hex")}`
  const operationDirectory = `${snapshot.file}.${suffix}.write`
  const artifacts: WriteArtifacts = {
    directory: operationDirectory,
    temporary: path.join(operationDirectory, "temporary"),
    claim: path.join(operationDirectory, "claim"),
    recovery: path.join(operationDirectory, "recovery"),
  }
  const state: WriteState = {
    destinationClaimed: false,
    claimMatchesSnapshot: false,
    destinationPublished: false,
  }
  const mode = snapshot.mode
  let artifactsOwned = false

  try {
    await hooks.before?.("temporary-open")
    // The exclusive sibling directory makes every path below it operation-owned.
    await mkdir(artifacts.directory, { mode: PRIVATE_DIRECTORY_MODE })
    artifactsOwned = true
    const handle = await open(artifacts.temporary, "wx", mode)
    try {
      await hooks.before?.("temporary-write")
      await handle.writeFile(rendered, "utf8")
      await hooks.before?.("temporary-flush")
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await hooks.before?.("rename")
    if (snapshot.exists) {
      try {
        await rename(snapshot.file, artifacts.claim)
      } catch (error) {
        if (isMissing(error)) throw configWriteConflict(snapshot, conflictMessage)
        throw error
      }
      state.destinationClaimed = true
      state.claimMatchesSnapshot = await matchesSnapshot(artifacts.claim, snapshot, mode)
      if (!state.claimMatchesSnapshot) throw configWriteConflict(snapshot, conflictMessage)
    }
    try {
      // A hard link publishes the complete flushed inode without clobbering a late writer.
      await link(artifacts.temporary, snapshot.file)
    } catch (error) {
      if (isAlreadyPresent(error)) throw configWriteConflict(snapshot, conflictMessage)
      throw error
    }
    state.destinationPublished = true
    await hooks.before?.("destination-flush")
    await syncFile(artifacts.temporary)
    await syncDirectory(directory)

    await hooks.before?.("post-validate")
    const persisted = await readFile(artifacts.temporary, "utf8")
    parseConfig(persisted, snapshot.file)
    if (persisted !== rendered) throw new Error(`${snapshot.file} did not persist the expected content`)
    if (!(await isOwnedPublication(artifacts.temporary, snapshot.file, rendered, mode))) {
      throw configWriteConflict(snapshot, conflictMessage)
    }
    if (state.destinationClaimed) {
      state.claimMatchesSnapshot = false
      state.claimMatchesSnapshot = await matchesSnapshot(artifacts.claim, snapshot, mode)
      if (!state.claimMatchesSnapshot) throw configWriteConflict(snapshot, conflictMessage)
    }
    await rm(artifacts.directory, { recursive: true })
    artifactsOwned = false
    await syncDirectory(directory)
    return { file: snapshot.file }
  } catch (error) {
    if (!artifactsOwned) throw error
    let ownershipLost: boolean
    try {
      ownershipLost = await recoverConfigWrite(snapshot, rendered, mode, artifacts, state)
      await rm(artifacts.directory, { recursive: true })
      artifactsOwned = false
      await syncDirectory(directory)
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `${snapshot.file} write failed and operation-owned artifacts could not be recovered`,
      )
    }
    if (ownershipLost && !(error instanceof ConfigWriteConflictError)) {
      throw configWriteConflict(snapshot, conflictMessage)
    }
    throw error
  }
}

async function recoverConfigWrite(
  snapshot: ConfigSnapshot,
  rendered: string,
  mode: number,
  artifacts: WriteArtifacts,
  state: WriteState,
): Promise<boolean> {
  if (state.destinationPublished) {
    try {
      await rename(snapshot.file, artifacts.recovery)
    } catch (error) {
      if (isMissing(error)) return true
      throw error
    }
    if (!(await isOwnedPublication(artifacts.temporary, artifacts.recovery, rendered, mode))) {
      await restoreWithoutClobber(artifacts.recovery, snapshot.file, true)
      return true
    }
  }

  if (!state.destinationClaimed) return false
  const restored = await restoreWithoutClobber(
    artifacts.claim,
    snapshot.file,
    !state.claimMatchesSnapshot,
  )
  return !state.claimMatchesSnapshot || !restored
}

async function restoreWithoutClobber(source: string, destination: string, sourceIsExternal: boolean): Promise<boolean> {
  try {
    await link(source, destination)
    return true
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error
    if (sourceIsExternal && !(await haveSameState(source, destination))) {
      throw new Error(`${destination} recovery found multiple concurrent edits; preserving both paths`)
    }
    return false
  }
}

async function isOwnedPublication(
  temporary: string,
  destination: string,
  rendered: string,
  mode: number,
): Promise<boolean> {
  const [temporaryMetadata, destinationMetadata, content] = await Promise.all([
    stat(temporary),
    stat(destination),
    readFile(temporary, "utf8"),
  ])
  return (
    temporaryMetadata.dev === destinationMetadata.dev &&
    temporaryMetadata.ino === destinationMetadata.ino &&
    (destinationMetadata.mode & 0o777) === mode &&
    content === rendered
  )
}

async function matchesSnapshot(file: string, snapshot: ConfigSnapshot, mode: number): Promise<boolean> {
  const [content, metadata] = await Promise.all([readFile(file, "utf8"), stat(file)])
  return content === snapshot.content && (metadata.mode & 0o777) === mode
}

async function haveSameState(left: string, right: string): Promise<boolean> {
  const [leftMetadata, rightMetadata, leftBytes, rightBytes] = await Promise.all([
    stat(left),
    stat(right),
    readFile(left),
    readFile(right),
  ])
  return (
    (leftMetadata.mode & 0o777) === (rightMetadata.mode & 0o777) &&
    leftBytes.equals(rightBytes)
  )
}

function configWriteConflict(snapshot: ConfigSnapshot, message?: string): ConfigWriteConflictError {
  const defaultMessage = snapshot.exists
    ? `${snapshot.file} changed while the configurator was open; reload and retry`
    : `${snapshot.file} was created while the configurator was open; reload and retry`
  return new ConfigWriteConflictError(message ?? defaultMessage)
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

function isAlreadyPresent(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST"
}
