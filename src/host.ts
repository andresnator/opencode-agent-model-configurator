import type { Context } from "@opencode/plugin/tui/plugin"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { RuntimePaths } from "./persistence"

/** The wizard needs only the host's public dialogs, location-scoped catalogs, and reload API. */
export type ConfiguratorHost = {
  paths: RuntimePaths
  client: Pick<Context["client"], "agent" | "model" | "location">
  ui: Pick<Context["ui"], "dialog" | "toast">
}

export async function createConfiguratorHost(context: Context): Promise<ConfiguratorHost> {
  const location = context.location ?? context.data.location.default()
  if (!location.directory) throw new Error("OpenCode has no active project directory. Open a project and retry.")
  // The client has no public connection URL/locality flag. Verify shared storage
  // rather than trusting a loopback URL, which could point to a remote tunnel.
  await assertSharedFilesystem(context.client, location)
  const resolved = await context.client.location.get({ location }, { signal: AbortSignal.timeout(5000) })
  return {
    paths: {
      directory: location.directory,
      worktree: resolved.project.directory,
      // V2 Global.Service applies OPENCODE_CONFIG_DIR over the standard XDG root.
      config: process.env.OPENCODE_CONFIG_DIR
        || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode"),
    },
    client: context.client,
    ui: context.ui,
  }
}

async function assertSharedFilesystem(client: Context["client"], location: NonNullable<Context["location"]>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "models-presets-local."))
  const nonce = randomBytes(24).toString("hex")
  try {
    await writeFile(path.join(directory, nonce), "", { flag: "wx", mode: 0o600 })
    // Send only the directory, never the unpredictable filename. A server on
    // another filesystem cannot return this entry even if the same paths exist.
    const result = await client.file.list({ location, path: directory }, { signal: AbortSignal.timeout(5000) })
    if (!result.data.some((entry) => entry.type === "file"
      && path.resolve(result.location.directory, entry.path) === path.join(directory, nonce))) {
      throw new Error("Local filesystem probe did not match")
    }
  } catch (cause) {
    throw new Error("Model presets require the CLI and server to share the local filesystem. Remote configuration is not supported; open OpenCode on the server machine.", { cause })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
