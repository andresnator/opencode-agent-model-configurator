import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { resolveProfilesRoot } from "./domain"
import { normalizePluginOptions } from "./options"
import { runModelConfigurator } from "./wizard"

export const MODELS_PRESETS_PLUGIN_ID = "models-presets"
export const MODELS_PRESETS_COMMAND_ID = "models-presets.open"
export const MODELS_PRESETS_SLASH_NAME = "models-profiles"
export const MINIMUM_OPENCODE_VERSION = "1.17.15"

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = normalizePluginOptions(rawOptions)
  // Registration never depends on installed data: agents come from the server and profiles are optional.
  api.keymap.registerLayer({
    commands: [
      {
        name: MODELS_PRESETS_COMMAND_ID,
        title: "Configure model presets",
        desc: "Assign models and variants by agent or reuse a saved preset",
        category: "Model Presets",
        namespace: "palette",
        slashName: MODELS_PRESETS_SLASH_NAME,
        run() {
          void resolveProfilesRoot(import.meta.url, options.profilesDir, api.state.path.directory)
            .then((profilesRoot) => runModelConfigurator(api, profilesRoot))
            .catch((error) => {
              api.ui.toast({
                variant: "error",
                title: "Model presets failed",
                message: String(error instanceof Error ? error.message : error),
                duration: 8000,
              })
            })
        },
      },
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: MODELS_PRESETS_PLUGIN_ID,
  tui,
}

export default plugin
