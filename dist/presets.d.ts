import type { ModelOption } from "./domain";
import { type RuntimePaths } from "./persistence";
export type PresetAssignment = {
    model: string;
    variant?: string;
};
export type StoredPreset = {
    name: string;
    savedAt: string;
    assignments: Record<string, PresetAssignment>;
};
export type PartitionedAssignments = {
    valid: Record<string, PresetAssignment>;
    stale: string[];
};
export declare function presetsFile(runtime: RuntimePaths): string;
export declare function loadPresets(file: string): Promise<StoredPreset[]>;
export declare function savePreset(file: string, preset: StoredPreset): Promise<void>;
export declare function deletePreset(file: string, name: string): Promise<void>;
export declare function partitionPresetAssignments(assignments: Readonly<Record<string, PresetAssignment>>, agents: readonly string[], models: readonly ModelOption[]): PartitionedAssignments;
