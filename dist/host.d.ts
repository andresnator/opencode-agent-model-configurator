import type { Context } from "@opencode/plugin/tui/plugin";
import type { RuntimePaths } from "./persistence";
/** The wizard needs only the host's public dialogs, location-scoped catalogs, and reload API. */
export type ConfiguratorHost = {
    paths: RuntimePaths;
    client: Pick<Context["client"], "agent" | "model" | "location">;
    ui: Pick<Context["ui"], "dialog" | "toast">;
};
export declare function createConfiguratorHost(context: Context): Promise<ConfiguratorHost>;
