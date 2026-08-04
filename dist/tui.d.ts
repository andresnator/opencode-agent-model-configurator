import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
export declare const MODEL_CONFIGURATOR_PLUGIN_ID = "andresnator.agent-model-configurator";
export declare const MODEL_CONFIGURATOR_COMMAND_ID = "andresnator.agent-model-configurator.open";
export declare const MODEL_CONFIGURATOR_SLASH_NAME = "model-configurator";
export declare const MINIMUM_OPENCODE_VERSION = "1.17.15";
declare const plugin: TuiPluginModule & {
    id: string;
};
export default plugin;
