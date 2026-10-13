import { Plugin } from "@opencode/plugin/tui"
import { resolveProfilesRoot } from "./domain"
import { createConfiguratorHost } from "./host"
import { normalizePluginOptions } from "./options"
import { runModelConfigurator } from "./wizard"

export const MODELS_PRESETS_PLUGIN_ID = "opencode-models-presets"
export const MODELS_PRESETS_COMMAND_ID = "models-presets.open"
export const MODELS_PRESETS_SLASH_NAME = "models-profiles"
export const MINIMUM_OPENCODE_VERSION = "2.0.28"

export default Plugin.define({
  id: MODELS_PRESETS_PLUGIN_ID,
  setup(context) {
    const options = normalizePluginOptions(context.options)
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: MODELS_PRESETS_COMMAND_ID,
        title: "Configure model presets",
        description: "Assign models and variants by agent or reuse a saved preset",
        group: "Model Presets",
        palette: true,
        slash: { name: MODELS_PRESETS_SLASH_NAME },
        async run() {
          try {
            const host = createConfiguratorHost(context)
            const profilesRoot = await resolveProfilesRoot(import.meta.url, options.profilesDir, host.paths.directory)
            await runModelConfigurator(host, profilesRoot)
          } catch (error) {
            context.ui.toast.show({
              variant: "error", title: "Model presets failed",
              message: String(error instanceof Error ? error.message : error), duration: 8000,
            })
          }
        },
      }],
    }))
  },
})
