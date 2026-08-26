# Configure agent models safely

Models Presets changes model assignments in six steps:

1. Choose project or global scope.
2. Start from live agents, a profile, or a saved preset.
3. Choose what to do for each agent.
4. Review the full change set.
5. Create or update a named preset.
6. Apply the changes.

For an error, find the matching symptom in [Troubleshooting](troubleshooting.md).

## Choose a scope

The scope decides which OpenCode configuration file is changed.

| Scope | File | Used by |
| --- | --- | --- |
| Project | Existing `.opencode/opencode.jsonc`, or `.opencode/opencode.json` | Current project |
| Global | Existing `opencode.jsonc`, or `opencode.json`, in the global OpenCode configuration directory | All projects by default |

If no file exists, the plugin creates `opencode.json`. If both formats exist, it uses JSONC. The scope screen always shows the exact path.

OpenCode supplies the global configuration directory. The fallback is `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when `XDG_CONFIG_HOME` is not set.

## Choose an action for each agent

| Action | Result |
| --- | --- |
| Keep current | Makes no change for this agent |
| Replace | Saves the selected model and optional variant |
| Inherit | Removes this scope's explicit model and variant |

Choosing the provider's default variant removes an explicit variant. Inherit lets a lower-precedence or default value take effect.

The review screen shows every change before anything is written. Other agent settings stay unchanged.

## Understand profiles and presets

| Item | Purpose | Location |
| --- | --- | --- |
| Profile | Groups known agents into reusable tiers | Optional directory you choose |
| Preset | Saves concrete agent, model, and variant assignments | `model-configurator-presets.json` in the global OpenCode configuration directory |

Profiles are optional input. Presets are named saved results. The plugin never writes profile files.

### Add profiles

Set `profilesDir` in the plugin options in `tui.json`.

| Value | Resolution |
| --- | --- |
| Relative path | From the active project directory |
| Absolute path | Used as written |
| `~` or `~/...` | From your home directory |
| `file://` URL | Converted to a local path |

Only `.json` files are loaded. Invalid files are reported and skipped. Unknown agents are skipped, but valid agents in the same profile remain available.

Start with the [profile example](../examples/profiles/team.example.json) and validate it with the [profile schema](../schemas/profile.schema.json).

### Save and apply presets

After reviewing assignments, choose one action:

- **Create new preset**: enter a new, non-empty name.
- **Update existing preset**: select a saved preset to replace.

When you start from a saved preset, choose **Apply preset "name"**.

Before applying, the plugin checks every assignment against the current agents, providers, models, and variants. It skips stale entries and shows them to you. If every entry is stale, nothing is applied.

The plugin checks the live catalog again before the final write. If a model or variant disappeared, the write stops. Reopen the plugin and select again.

When updating a preset, the plugin also checks that another process did not change or delete it. If it changed, the update stops and keeps the newer data.

## Check environment overrides

`OPENCODE_CONFIG_CONTENT` and `OPENCODE_CONFIG` can override values from configuration files. The scope screen warns you when either variable is present.

In that case, a file write can succeed without changing the value OpenCode uses. Update or remove the environment override, then restart OpenCode.

## Know which files can change

| Data | Plugin behavior |
| --- | --- |
| Project or global OpenCode configuration | Changes only selected `agent.<name>.model` and `agent.<name>.variant` values; keeps other keys, JSONC comments, and file mode |
| Global preset store | Saves named assignments in `model-configurator-presets.json` |
| Profile files | Reads only |
| `tui.json` | Reads registration and `profilesDir`; never writes it |

The plugin never writes provider credentials.

## Write safety

Assignment writes protect existing data:

1. The plugin refreshes the live catalog.
2. It saves the preset atomically. If this fails, configuration is not changed.
3. It checks that the target configuration did not change while the wizard was open.
4. It writes through a temporary file, replaces the target atomically, preserves its mode, and validates the result.
5. If assignment persistence fails, it restores the previous content or removes the new file. The saved preset remains available for another attempt.

## Know when to restart

| Message | Next step |
| --- | --- |
| Applied live | Current server is updated. Restart other running OpenCode processes. |
| Restart required | File was written. Restart affected OpenCode sessions. |
| Preset saved, configuration not applied | Fix the reported file problem, reopen the plugin, and retry. |
| Error before completion | Follow the reported error. Do not assume the write succeeded. |
