export declare const ACTIVE_PRESET_FILE = "models-presets-active.json";
export type ActivePresetDocument = {
    version: 1;
    activePreset: string;
};
export declare function activePresetFile(configFile: string): string;
export declare function loadActivePreset(file: string): Promise<string | undefined>;
export declare function saveActivePreset(file: string, activePreset: string): Promise<void>;
export declare function clearActivePreset(file: string): Promise<void>;
