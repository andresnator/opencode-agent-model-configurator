import { type RuntimePaths } from "./persistence";
export declare function lastAppliedFile(runtime: RuntimePaths): string;
export declare function loadLastApplied(file: string, configFile: string): Promise<string | undefined>;
export declare function saveLastApplied(file: string, configFile: string, name: string): Promise<void>;
