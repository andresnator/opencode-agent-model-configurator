import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { TextDecoder } from "node:util"
import { globalConfigRoot, type RuntimePaths } from "./persistence"

const HISTORY_FILE = "model-configurator-last-applied.json"
const HISTORY_VERSION = 1
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const LOCK_ATTEMPTS = 3
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export function lastAppliedFile(runtime: RuntimePaths): string {
  return path.join(globalConfigRoot(runtime), HISTORY_FILE)
}

export async function loadLastApplied(file: string, configFile: string): Promise<string | undefined> {
  return (await readHistory(file))[path.resolve(configFile)]
}

export async function saveLastApplied(file: string, configFile: string, name: string): Promise<void> {
  if (!name.trim()) throw new Error("Last applied preset name cannot be empty.")
  await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const lock = `${file}.lock`
  const owner = await acquireLock(lock)
  const temporary = `${file}.${randomUUID()}.tmp`
  let temporaryOwned = false
  try {
    const lastApplied = await readHistory(file)
    lastApplied[path.resolve(configFile)] = name
    const handle = await open(temporary, "wx", PRIVATE_FILE_MODE)
    temporaryOwned = true
    try {
      await handle.writeFile(`${JSON.stringify({ version: HISTORY_VERSION, lastApplied }, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    temporaryOwned = false
  } finally {
    try {
      if (temporaryOwned) await rm(temporary, { force: true })
    } finally {
      await releaseLock(lock, owner)
    }
  }
}

async function acquireLock(lock: string): Promise<string> {
  const owner = `owner-${randomUUID()}.json`
  const prepared = `${lock}.${randomUUID()}.pending`
  await mkdir(prepared, { mode: PRIVATE_DIRECTORY_MODE })
  try {
    await writeFile(path.join(prepared, owner), JSON.stringify({ pid: process.pid, hostname: hostname() }), {
      flag: "wx", mode: PRIVATE_FILE_MODE,
    })
    // Publish an already populated directory: a crash never leaves an ownerless active lock.
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        await rename(prepared, lock)
        return owner
      } catch (error) {
        if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) throw error
        if (!(await recoverAbandonedLock(lock))) throw lockConflict(lock)
      }
    }
    throw lockConflict(lock)
  } finally {
    await rm(prepared, { recursive: true, force: true })
  }
}

async function recoverAbandonedLock(lock: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(lock)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true
    throw error
  }
  // Empty directories can only be legacy locks or interrupted cleanup.
  if (entries.length === 0) return removeEmptyLock(lock)
  if (entries.length !== 1 || !/^owner-[\da-f-]+\.json$/.test(entries[0])) return false
  const ownerFile = path.join(lock, entries[0])
  let owner: unknown
  try {
    owner = JSON.parse(FATAL_UTF8_DECODER.decode(await readFile(ownerFile)))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true
    return false
  }
  if (!isRecord(owner) || owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false
  try {
    process.kill(owner.pid as number, 0)
    return false
  } catch (error) {
    if (!hasCode(error, "ESRCH")) return false
  }
  // Unlink only this owner's unique file; another contender cannot remove a replacement lock.
  try {
    await unlink(ownerFile)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true
    throw error
  }
  return removeEmptyLock(lock)
}

async function releaseLock(lock: string, owner: string): Promise<void> {
  await unlink(path.join(lock, owner))
  await removeEmptyLock(lock)
}

async function removeEmptyLock(lock: string): Promise<boolean> {
  try {
    await rmdir(lock)
    return true
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true
    if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) return false
    throw error
  }
}

function lockConflict(lock: string): Error {
  return Object.assign(new Error(`Last applied preset history is locked at ${lock}.`), { code: "EEXIST" })
}

async function readHistory(file: string): Promise<Record<string, string>> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, string>
    throw error
  }
  let content: string
  try {
    content = FATAL_UTF8_DECODER.decode(bytes)
  } catch {
    throw new Error(`Invalid last applied preset history at ${file}: file is not valid UTF-8.`)
  }
  const raw: unknown = JSON.parse(content)
  if (
    !isRecord(raw) || raw.version !== HISTORY_VERSION ||
    Object.keys(raw).some((key) => key !== "version" && key !== "lastApplied") ||
    !isRecord(raw.lastApplied)
  ) throw new Error(`Invalid last applied preset history at ${file}.`)
  const history = Object.create(null) as Record<string, string>
  for (const [configFile, name] of Object.entries(raw.lastApplied)) {
    if (!path.isAbsolute(configFile) || typeof name !== "string" || !name.trim()) {
      throw new Error(`Invalid last applied preset history at ${file}.`)
    }
    history[configFile] = name
  }
  return history
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
