import { randomBytes } from "node:crypto"
import { link, mkdir, open, readFile, rm, rmdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, type FormattingOptions, type ParseError, printParseErrorCode } from "jsonc-parser"
import type { AgentChange, AgentMapping } from "./domain"

const CONFIG_JSON = "opencode.json"
const CONFIG_JSONC = "opencode.jsonc"
const DEFAULT_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const FORMATTING_OPTIONS: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
const CONFIG_WRITE_OWNERSHIP = Symbol("config-write-ownership")

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
  | "recovery-restore"
  | "ownership-release"

export type PersistenceHooks = {
  before?: (step: PersistenceStep) => void | Promise<void>
}

type WriteArtifacts = {
  directory: string
  temporary: string
  claim: string
  restoration: string
  recovery: string
}

type FileIdentity = {
  dev: number
  ino: number
}

const CONFIG_SNAPSHOT_IDENTITIES = new WeakMap<ConfigSnapshot, FileIdentity>()

type WriteArtifactName = keyof WriteArtifacts

type WriteArtifactOwnership = {
  identities: Partial<Record<WriteArtifactName, FileIdentity>>
  preserved: Set<WriteArtifactName>
}

type WriteState = {
  destinationClaimed: boolean
  claimMatchesSnapshot: boolean
  destinationPublished: boolean
}

type ConfigWriteOwnershipState = {
  snapshot: ConfigSnapshot
  content: string
  mode: number
  artifacts: WriteArtifacts
  artifactOwnership: WriteArtifactOwnership
  active: boolean
}

export type ConfigWriteOwnership = {
  readonly file: string
  readonly [CONFIG_WRITE_OWNERSHIP]: ConfigWriteOwnershipState
}

type WriteContentOptions = {
  conflictMessage?: string
  expectedOwnership?: ConfigWriteOwnership
  retainOwnership?: boolean
}

type WriteContentResult = {
  result: WriteResult
  ownership?: ConfigWriteOwnership
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
    const handle = await open(file, "r")
    try {
      const [content, metadata] = await Promise.all([handle.readFile("utf8"), handle.stat()])
      const config = parseConfig(content, file)
      const snapshot = { file, exists: true, content, mode: metadata.mode & 0o777, mappings: extractMappings(config) }
      CONFIG_SNAPSHOT_IDENTITIES.set(snapshot, identityFromMetadata(metadata))
      return snapshot
    } finally {
      await handle.close()
    }
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
  const written = await writeConfigChangesInternal(snapshot, changes, hooks)
  return written.result
}

export async function writeConfigChangesWithOwnership(
  snapshot: ConfigSnapshot,
  changes: readonly AgentChange[],
  hooks: PersistenceHooks = {},
): Promise<ConfigWriteOwnership | undefined> {
  const written = await writeConfigChangesInternal(snapshot, changes, hooks, { retainOwnership: true })
  return written.ownership
}

export async function writeConfigChangesFromOwnership(
  ownership: ConfigWriteOwnership,
  changes: readonly AgentChange[],
  hooks: PersistenceHooks = {},
): Promise<WriteResult> {
  const state = activeOwnership(ownership)
  const snapshot = { ...state.snapshot, exists: true, content: state.content, mode: state.mode }
  const written = await writeConfigChangesInternal(snapshot, changes, hooks, {
    expectedOwnership: ownership,
    retainOwnership: true,
  })
  if (written.ownership) await transferConfigWriteOwnership(ownership, written.ownership)
  return written.result
}

export async function releaseConfigWriteOwnership(ownership: ConfigWriteOwnership): Promise<void> {
  const state = ownership[CONFIG_WRITE_OWNERSHIP]
  if (!state.active) return
  if (!(await retainedClaimMatchesSnapshot(state))) {
    const claimRecovered = await preserveChangedRetainedClaim(ownership)
    await discardConfigWriteOwnership(ownership)
    if (claimRecovered) throw configWriteConflict(state.snapshot)
    return
  }
  await discardConfigWriteOwnership(ownership)
}

export async function restoreOwnedConfigSnapshot(ownership: ConfigWriteOwnership): Promise<void> {
  const state = activeOwnership(ownership)
  const { snapshot, artifacts, artifactOwnership } = state
  const conflictMessage = `${snapshot.file} rollback conflict: configuration changed after the plugin write; preserving newer content`
  let conflict = false
  let publicationMoved = false
  let restorationMatchesSnapshot = true

  if (snapshot.exists) {
    try {
      const restorationIdentity = await reserveArtifactLink(
        artifacts.claim,
        artifacts.restoration,
        artifactOwnership,
        "restoration",
      )
      const claimIdentity = artifactOwnership.identities.claim
      restorationMatchesSnapshot = Boolean(
        claimIdentity &&
        sameIdentity(restorationIdentity, claimIdentity) &&
        await matchesSnapshot(artifacts.restoration, snapshot, state.mode),
      )
    } catch (error) {
      await closeConfigWriteOwnership(ownership)
      if (isMissing(error)) throw configWriteConflict(snapshot, conflictMessage)
      throw error
    }
  }

  try {
    const recoveryIdentity = await reserveArtifactLink(snapshot.file, artifacts.recovery, artifactOwnership, "recovery")
    if (!(await removePathWithIdentity(snapshot.file, recoveryIdentity))) {
      artifactOwnership.preserved.add("recovery")
      throw new Error(`${snapshot.file} recovery found multiple concurrent edits; preserving ${artifacts.recovery}`)
    }
    publicationMoved = true
  } catch (error) {
    if (!isMissing(error)) {
      await closeConfigWriteOwnership(ownership)
      throw error
    }
    await closeConfigWriteOwnership(ownership)
    throw configWriteConflict(snapshot, conflictMessage)
  }

  try {
    if (!(await ownershipPublicationMatchesFile(state, artifacts.recovery))) {
      await restorePreservedArtifact(artifacts, artifactOwnership, "recovery", snapshot.file)
      conflict = true
    } else if (snapshot.exists) {
      const restored = restorationMatchesSnapshot
        ? await restoreWithoutClobber(artifacts.restoration, snapshot.file, false)
        : await restorePreservedArtifact(artifacts, artifactOwnership, "restoration", snapshot.file)
      conflict = !restorationMatchesSnapshot || !restored
    } else {
      conflict = await exists(snapshot.file)
    }
  } catch (error) {
    let publicationRecoveryError: unknown
    if (publicationMoved) {
      try {
        await restorePreservedArtifact(artifacts, artifactOwnership, "recovery", snapshot.file)
      } catch (recoveryError) {
        publicationRecoveryError = recoveryError
      }
    }
    await closeConfigWriteOwnership(ownership)
    if (publicationRecoveryError) {
      throw new AggregateError(
        [error, publicationRecoveryError],
        `${snapshot.file} rollback failed while preserving concurrent lineages`,
      )
    }
    throw error
  }

  await closeConfigWriteOwnership(ownership)
  if (conflict) throw configWriteConflict(snapshot, conflictMessage)
}

export function isConfigWriteConflictError(error: unknown): boolean {
  return error instanceof ConfigWriteConflictError
}

async function writeConfigChangesInternal(
  snapshot: ConfigSnapshot,
  changes: readonly AgentChange[],
  hooks: PersistenceHooks,
  options: WriteContentOptions = {},
): Promise<WriteContentResult> {
  if (changes.length === 0) {
    await requireExpectedOwnership(snapshot, options)
    return { result: { file: snapshot.file } }
  }
  const rendered = renderConfigChanges(snapshot, changes)
  if (rendered === snapshot.content) {
    await requireExpectedOwnership(snapshot, options)
    return { result: { file: snapshot.file } }
  }

  return writeConfigContent(snapshot, rendered, hooks, options)
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

  const expectedSnapshot = { ...snapshot, exists: true, content: expectedContent }
  const snapshotIdentity = CONFIG_SNAPSHOT_IDENTITIES.get(snapshot)
  if (snapshotIdentity) CONFIG_SNAPSHOT_IDENTITIES.set(expectedSnapshot, snapshotIdentity)
  await writeConfigContent(
    expectedSnapshot,
    snapshot.content,
    {},
    { conflictMessage },
  )
}

async function writeConfigContent(
  snapshot: ConfigSnapshot,
  rendered: string,
  hooks: PersistenceHooks = {},
  options: WriteContentOptions = {},
): Promise<WriteContentResult> {
  const { conflictMessage, expectedOwnership, retainOwnership = false } = options
  const directory = path.dirname(snapshot.file)
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await requireExpectedOwnership(snapshot, options)
  if (snapshot.exists) {
    try {
      if (!(await matchesSnapshot(snapshot.file, snapshot, snapshot.mode))) {
        throw configWriteConflict(snapshot, conflictMessage)
      }
    } catch (error) {
      if (isMissing(error)) throw configWriteConflict(snapshot, conflictMessage)
      throw error
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
    restoration: path.join(operationDirectory, "restoration"),
    recovery: path.join(operationDirectory, "recovery"),
  }
  const state: WriteState = {
    destinationClaimed: false,
    claimMatchesSnapshot: false,
    destinationPublished: false,
  }
  const mode = snapshot.mode
  let artifactsOwned = false
  const artifactOwnership: WriteArtifactOwnership = { identities: {}, preserved: new Set() }

  try {
    await hooks.before?.("temporary-open")
    // The exclusive sibling directory makes every path below it operation-owned.
    await mkdir(artifacts.directory, { mode: PRIVATE_DIRECTORY_MODE })
    artifactsOwned = true
    artifactOwnership.identities.directory = await fileIdentity(artifacts.directory)
    const handle = await open(artifacts.temporary, "wx", mode)
    try {
      artifactOwnership.identities.temporary = identityFromMetadata(await handle.stat())
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
      let claimIdentity: FileIdentity
      try {
        claimIdentity = await reserveArtifactLink(
          snapshot.file,
          artifacts.claim,
          artifactOwnership,
          "claim",
        )
      } catch (error) {
        if (isMissing(error)) throw configWriteConflict(snapshot, conflictMessage)
        throw error
      }
      state.claimMatchesSnapshot = await matchesWriteBaseline(
        artifacts.claim,
        snapshot,
        mode,
        expectedOwnership,
      )
      if (!state.claimMatchesSnapshot) throw configWriteConflict(snapshot, conflictMessage)
      if (!(await removePathWithIdentity(snapshot.file, claimIdentity))) {
        throw configWriteConflict(snapshot, conflictMessage)
      }
      state.destinationClaimed = true
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
      state.claimMatchesSnapshot = await matchesWriteBaseline(
        artifacts.claim,
        snapshot,
        mode,
        expectedOwnership,
      )
      if (!state.claimMatchesSnapshot) throw configWriteConflict(snapshot, conflictMessage)
    }
    if (retainOwnership) {
      return {
        result: { file: snapshot.file },
        ownership: createConfigWriteOwnership(snapshot, rendered, mode, artifacts, artifactOwnership),
      }
    }
    await cleanupWriteArtifacts(artifacts, artifactOwnership)
    artifactsOwned = false
    await syncDirectory(directory)
    return { result: { file: snapshot.file } }
  } catch (error) {
    if (!artifactsOwned) throw error
    let ownershipLost: boolean
    try {
      ownershipLost = await recoverConfigWrite(snapshot, rendered, mode, artifacts, artifactOwnership, state, hooks)
      await cleanupWriteArtifacts(artifacts, artifactOwnership)
      artifactsOwned = false
      await syncDirectory(directory)
    } catch (recoveryError) {
      try {
        await cleanupWriteArtifacts(artifacts, artifactOwnership)
        artifactsOwned = false
        await syncDirectory(directory)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, recoveryError, cleanupError],
          `${snapshot.file} write failed and operation-owned artifacts could not be recovered or cleaned`,
        )
      }
      throw new AggregateError(
        [error, recoveryError],
        `${snapshot.file} write failed and operation-owned artifacts could not be recovered`,
      )
    }
    if (ownershipLost && !(error instanceof ConfigWriteConflictError)) {
      throw new AggregateError(
        [error, configWriteConflict(snapshot, conflictMessage)],
        `${snapshot.file} write failed after a concurrent ownership conflict`,
      )
    }
    throw error
  }
}

function createConfigWriteOwnership(
  snapshot: ConfigSnapshot,
  content: string,
  mode: number,
  artifacts: WriteArtifacts,
  artifactOwnership: WriteArtifactOwnership,
): ConfigWriteOwnership {
  const ownedSnapshot = { ...snapshot, mappings: { ...snapshot.mappings } }
  const snapshotIdentity = CONFIG_SNAPSHOT_IDENTITIES.get(snapshot)
  if (snapshotIdentity) CONFIG_SNAPSHOT_IDENTITIES.set(ownedSnapshot, snapshotIdentity)
  return {
    file: snapshot.file,
    [CONFIG_WRITE_OWNERSHIP]: {
      snapshot: ownedSnapshot,
      content,
      mode,
      artifacts,
      artifactOwnership,
      active: true,
    },
  }
}

function activeOwnership(ownership: ConfigWriteOwnership): ConfigWriteOwnershipState {
  const state = ownership[CONFIG_WRITE_OWNERSHIP]
  if (!state.active) throw new Error(`${ownership.file} write ownership is no longer active`)
  return state
}

async function transferConfigWriteOwnership(
  ownership: ConfigWriteOwnership,
  replacement: ConfigWriteOwnership,
): Promise<void> {
  const current = activeOwnership(ownership)
  const next = activeOwnership(replacement)
  const nextClaimIdentity = next.artifactOwnership.identities.claim
  if (!nextClaimIdentity || !(await removePathWithIdentity(next.artifacts.claim, nextClaimIdentity))) {
    throw new Error(`${ownership.file} fallback ownership claim could not be transferred`)
  }
  delete next.artifactOwnership.identities.claim

  if (current.snapshot.exists) {
    if (!(await retainedClaimMatchesSnapshot(current))) throw configWriteConflict(current.snapshot)
    const transferredClaimIdentity = await reserveArtifactLink(
      current.artifacts.claim,
      next.artifacts.claim,
      next.artifactOwnership,
      "claim",
    )
    const currentClaimIdentity = current.artifactOwnership.identities.claim
    if (
      !currentClaimIdentity ||
      !sameIdentity(transferredClaimIdentity, currentClaimIdentity) ||
      !(await matchesSnapshot(next.artifacts.claim, current.snapshot, current.mode))
    ) {
      throw configWriteConflict(current.snapshot)
    }
  }

  const originalSnapshot = current.snapshot
  await cleanupWriteArtifacts(current.artifacts, current.artifactOwnership)
  current.snapshot = originalSnapshot
  current.content = next.content
  current.mode = next.mode
  current.artifacts = next.artifacts
  current.artifactOwnership = next.artifactOwnership
  next.active = false
  await syncDirectory(path.dirname(ownership.file))
}

async function requireExpectedOwnership(snapshot: ConfigSnapshot, options: WriteContentOptions): Promise<void> {
  if (!options.expectedOwnership) return
  if (!(await ownershipMatchesFile(options.expectedOwnership, snapshot.file))) {
    throw configWriteConflict(snapshot, options.conflictMessage)
  }
}

async function matchesWriteBaseline(
  file: string,
  snapshot: ConfigSnapshot,
  mode: number,
  expectedOwnership?: ConfigWriteOwnership,
): Promise<boolean> {
  return expectedOwnership
    ? ownershipMatchesFile(expectedOwnership, file)
    : matchesSnapshot(file, snapshot, mode)
}

async function ownershipMatchesFile(ownership: ConfigWriteOwnership, file: string): Promise<boolean> {
  const state = activeOwnership(ownership)
  if (!(await retainedClaimMatchesSnapshot(state))) return false
  try {
    return await ownershipPublicationMatchesFile(state, file)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function ownershipPublicationMatchesFile(state: ConfigWriteOwnershipState, file: string): Promise<boolean> {
  return isOwnedPublication(state.artifacts.temporary, file, state.content, state.mode)
}

async function retainedClaimMatchesSnapshot(state: ConfigWriteOwnershipState): Promise<boolean> {
  if (!state.snapshot.exists) return !(await exists(state.artifacts.claim))
  const claimIdentity = state.artifactOwnership.identities.claim
  if (!claimIdentity || !(await pathHasIdentity(state.artifacts.claim, claimIdentity))) return false
  try {
    return await matchesSnapshot(state.artifacts.claim, state.snapshot, state.mode)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function preserveChangedRetainedClaim(ownership: ConfigWriteOwnership): Promise<boolean> {
  const state = activeOwnership(ownership)
  const { artifacts, artifactOwnership } = state
  if (await retainedClaimMatchesSnapshot(state)) return false
  if (await haveSameIdentity(artifacts.claim, ownership.file)) return true

  try {
    await reserveArtifactLink(artifacts.claim, artifacts.restoration, artifactOwnership, "restoration")
  } catch (error) {
    await closeConfigWriteOwnership(ownership)
    if (isMissing(error)) throw configWriteConflict(state.snapshot)
    throw error
  }

  let publicationMoved = false
  try {
    const recoveryIdentity = await reserveArtifactLink(ownership.file, artifacts.recovery, artifactOwnership, "recovery")
    publicationMoved = await removePathWithIdentity(ownership.file, recoveryIdentity)
    if (!publicationMoved) artifactOwnership.preserved.add("recovery")
  } catch (error) {
    artifactOwnership.preserved.add("restoration")
    await closeConfigWriteOwnership(ownership)
    if (isMissing(error)) throw configWriteConflict(state.snapshot)
    throw error
  }

  try {
    if (!publicationMoved) {
      artifactOwnership.preserved.add("restoration")
      throw new Error(`${ownership.file} recovery found multiple concurrent edits; preserving ${artifacts.recovery}`)
    }
    if (!(await ownershipPublicationMatchesFile(state, artifacts.recovery))) {
      await restorePreservedArtifact(artifacts, artifactOwnership, "recovery", ownership.file)
      artifactOwnership.preserved.add("restoration")
      throw new Error(`${ownership.file} recovery found multiple concurrent edits; preserving ${artifacts.restoration}`)
    }

    await restorePreservedArtifact(artifacts, artifactOwnership, "restoration", ownership.file)
    await syncFile(ownership.file)
    await syncDirectory(path.dirname(ownership.file))
    return true
  } catch (error) {
    let publicationRecoveryError: unknown
    if (publicationMoved) {
      try {
        await restorePreservedArtifact(artifacts, artifactOwnership, "recovery", ownership.file)
      } catch (recoveryError) {
        publicationRecoveryError = recoveryError
      }
    }
    if (!(await haveSameIdentity(artifacts.restoration, ownership.file))) {
      artifactOwnership.preserved.add("restoration")
    }
    await closeConfigWriteOwnership(ownership)
    if (publicationRecoveryError) {
      throw new AggregateError(
        [error, publicationRecoveryError],
        `${ownership.file} ownership release failed while preserving concurrent lineages`,
      )
    }
    throw error
  }
}

async function discardConfigWriteOwnership(ownership: ConfigWriteOwnership): Promise<void> {
  const state = activeOwnership(ownership)
  if (!(await retainedClaimCanBeRemoved(state, ownership.file))) {
    throw new Error(`${ownership.file} retained claim changed; preserving it for recovery`)
  }
  await cleanupWriteArtifacts(state.artifacts, state.artifactOwnership)
  state.active = false
  await syncDirectory(path.dirname(ownership.file))
}

async function closeConfigWriteOwnership(ownership: ConfigWriteOwnership): Promise<void> {
  const state = activeOwnership(ownership)
  await cleanupWriteArtifacts(state.artifacts, state.artifactOwnership)
  state.active = false
  await syncDirectory(path.dirname(ownership.file))
}

async function retainedClaimCanBeRemoved(state: ConfigWriteOwnershipState, destination: string): Promise<boolean> {
  return (await retainedClaimMatchesSnapshot(state)) || haveSameIdentity(state.artifacts.claim, destination)
}

async function recoverConfigWrite(
  snapshot: ConfigSnapshot,
  rendered: string,
  mode: number,
  artifacts: WriteArtifacts,
  artifactOwnership: WriteArtifactOwnership,
  state: WriteState,
  hooks: PersistenceHooks,
): Promise<boolean> {
  if (state.destinationPublished) {
    try {
      const recoveryIdentity = await reserveArtifactLink(snapshot.file, artifacts.recovery, artifactOwnership, "recovery")
      if (!(await removePathWithIdentity(snapshot.file, recoveryIdentity))) {
        artifactOwnership.preserved.add("recovery")
        return true
      }
    } catch (error) {
      if (isMissing(error)) return true
      throw error
    }
    if (!(await isOwnedPublication(artifacts.temporary, artifacts.recovery, rendered, mode))) {
      await hooks.before?.("recovery-restore")
      await restorePreservedArtifact(artifacts, artifactOwnership, "recovery", snapshot.file)
      return true
    }
  }

  if (!state.destinationClaimed) return false
  const restored = state.claimMatchesSnapshot
    ? await restoreWithoutClobber(artifacts.claim, snapshot.file, false)
    : await restorePreservedArtifact(artifacts, artifactOwnership, "claim", snapshot.file)
  return !state.claimMatchesSnapshot || !restored
}

async function restorePreservedArtifact(
  artifacts: WriteArtifacts,
  ownership: WriteArtifactOwnership,
  name: "claim" | "restoration" | "recovery",
  destination: string,
): Promise<boolean> {
  ownership.preserved.add(name)
  const restored = await restoreWithoutClobber(artifacts[name], destination, true)
  if (restored || (await haveSameIdentity(artifacts[name], destination))) {
    ownership.preserved.delete(name)
  }
  return restored
}

async function reserveArtifactLink(
  source: string,
  destination: string,
  ownership: WriteArtifactOwnership,
  name: WriteArtifactName,
): Promise<FileIdentity> {
  const identity = await fileIdentity(source)
  try {
    await link(source, destination)
  } catch (error) {
    if (isAlreadyPresent(error)) {
      throw new Error(`${destination} already exists; preserving foreign write artifact`)
    }
    throw error
  }
  ownership.identities[name] = identity
  if (!(await pathHasIdentity(destination, identity))) {
    ownership.preserved.add(name)
    throw new Error(`${destination} identity changed after reservation; preserving foreign write artifact`)
  }
  return identity
}

async function cleanupWriteArtifacts(
  artifacts: WriteArtifacts,
  ownership: WriteArtifactOwnership,
): Promise<void> {
  for (const name of ["recovery", "restoration", "claim", "temporary"] as const) {
    if (ownership.preserved.has(name)) continue
    const identity = ownership.identities[name]
    if (identity) await removePathWithIdentity(artifacts[name], identity)
  }

  const directoryIdentity = ownership.identities.directory
  if (!directoryIdentity || !(await pathHasIdentity(artifacts.directory, directoryIdentity))) return
  try {
    await rmdir(artifacts.directory)
  } catch (error) {
    if (!isMissing(error) && !isDirectoryNotEmpty(error)) throw error
  }
}

async function removePathWithIdentity(file: string, identity: FileIdentity): Promise<boolean> {
  if (!(await pathHasIdentity(file, identity))) return false
  try {
    await rm(file)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function pathHasIdentity(file: string, identity: FileIdentity): Promise<boolean> {
  try {
    return sameIdentity(identityFromMetadata(await stat(file)), identity)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function fileIdentity(file: string): Promise<FileIdentity> {
  return identityFromMetadata(await stat(file))
}

function identityFromMetadata(metadata: { dev: number; ino: number }): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function restoreWithoutClobber(source: string, destination: string, sourceIsExternal: boolean): Promise<boolean> {
  try {
    await link(source, destination)
    return true
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error
    if (sourceIsExternal && !(await haveSameIdentity(source, destination))) {
      throw new Error(`${destination} recovery found another concurrent edit; preserving ${source}`)
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
  const handle = await open(file, "r")
  try {
    const [content, metadata] = await Promise.all([handle.readFile("utf8"), handle.stat()])
    const expectedIdentity = CONFIG_SNAPSHOT_IDENTITIES.get(snapshot)
    return (
      content === snapshot.content &&
      (metadata.mode & 0o777) === mode &&
      (!expectedIdentity || sameIdentity(identityFromMetadata(metadata), expectedIdentity))
    )
  } finally {
    await handle.close()
  }
}

async function haveSameIdentity(left: string, right: string): Promise<boolean> {
  try {
    const [leftMetadata, rightMetadata] = await Promise.all([stat(left), stat(right)])
    return leftMetadata.dev === rightMetadata.dev && leftMetadata.ino === rightMetadata.ino
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
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

function isDirectoryNotEmpty(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOTEMPTY"
}
