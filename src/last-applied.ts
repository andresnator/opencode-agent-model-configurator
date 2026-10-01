import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises"
import path from "node:path"
import { globalConfigRoot, type RuntimePaths } from "./persistence"

const HISTORY_FILE = "model-configurator-last-applied.json"
const HISTORY_VERSION = 1
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700

export function lastAppliedFile(runtime: RuntimePaths): string {
  return path.join(globalConfigRoot(runtime), HISTORY_FILE)
}

export async function loadLastApplied(file: string, configFile: string): Promise<string | undefined> {
  return (await readHistory(file))[path.resolve(configFile)]
}

export async function saveLastApplied(file: string, configFile: string, name: string): Promise<void> {
  if (!name.trim()) throw new Error("Last applied preset name cannot be empty.")
  await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  // Fail rather than overwrite another process's history update.
  const lock = `${file}.lock`
  await mkdir(lock, { mode: PRIVATE_DIRECTORY_MODE })
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
      await rmdir(lock)
    }
  }
}

async function readHistory(file: string): Promise<Record<string, string>> {
  let content: string
  try {
    content = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, string>
    throw error
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
