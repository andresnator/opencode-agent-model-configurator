import type { Context } from "@opencode/plugin/tui/plugin"
import { homedir } from "node:os"
import path from "node:path"
import type { RuntimePaths } from "./persistence"

/** The wizard needs only the host's public dialogs, location-scoped catalogs, and reload API. */
export type ConfiguratorHost = {
  paths: RuntimePaths
  client: Pick<Context["client"], "agent" | "model" | "location">
  ui: Pick<Context["ui"], "dialog" | "toast">
}

export function createConfiguratorHost(context: Context): ConfiguratorHost {
  const location = context.location ?? context.data.location.default()
  if (!location.directory) throw new Error("OpenCode has no active project directory. Open a project and retry.")
  return {
    paths: {
      directory: location.directory,
      worktree: location.directory,
      // V2 Global.Service applies OPENCODE_CONFIG_DIR over the standard XDG root.
      config: process.env.OPENCODE_CONFIG_DIR
        || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode"),
    },
    client: context.client,
    ui: context.ui,
  }
}
