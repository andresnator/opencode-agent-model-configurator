import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
export declare const MODELS_PRESETS_PLUGIN_ID = "models-presets";
export declare const MODELS_PRESETS_COMMAND_ID = "models-presets.open";
export declare const MODELS_PRESETS_SLASH_NAME = "models-profiles";
export declare const MINIMUM_OPENCODE_VERSION = "1.17.15";
declare const plugin: TuiPluginModule & {
    id: string;
};
export default plugin;
