# Configure agent models safely

Choose a scope, review the complete change set, and apply it under a preset name. Models Presets writes only the selected agent assignments and reports whether the current OpenCode server applied them live. For a failure, go to [Troubleshoot by symptom](troubleshooting.md#troubleshoot-by-symptom).

## Choose a scope and destination

The scope controls which OpenCode configuration file receives the assignments.

| Scope | Destination | Effect |
| --- | --- | --- |
| Project | `.opencode/opencode.jsonc` when it exists; otherwise `.opencode/opencode.json` in the active project | Applies to that project |
| Global | `opencode.jsonc` when it exists; otherwise `opencode.json` in the effective global OpenCode configuration directory | Applies as the global default |

If neither destination exists, the plugin creates `opencode.json`. It prefers an existing JSONC file when both filename forms are present and shows the resolved destination in the scope chooser.

The effective global directory comes from OpenCode. Its fallback is `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when `XDG_CONFIG_HOME` is not set.

## Choose an assignment action

Each action affects only the selected agent at the chosen scope.

| Action | Result |
| --- | --- |
| Keep current | Leaves the current assignment unchanged and writes nothing for that decision |
| Replace | Writes the selected model and, when selected, its variant; choosing the provider default removes an explicit variant |
| Inherit | Removes the explicit model and variant at this scope so a lower-precedence or default value can take effect |

The review screen shows every effective change before the write. Unrelated agent settings are not removed.

## Use optional profiles

Profiles group known agent names into reusable tiers. They are optional: if the profile directory is missing, no profiles appear, but every live agent remains individually configurable.

Set `profilesDir` in this plugin's `tui.json` options. The value can be:

| Form | Resolution |
| --- | --- |
| Project-relative path | Resolved from the active project directory |
| Absolute path | Used as provided |
| `~` or `~/...` path | Resolved from the user home directory |
| `file://` URL | Converted to its local file path |

Only `.json` files in that directory are loaded. A malformed or invalid profile is reported and skipped. An unknown agent is also reported and skipped, while known agents from the same valid profile remain usable.

Start from the [published profile example](../examples/profiles/team.example.json) and use its [JSON Schema](../schemas/profile.schema.json) rather than copying either document into configuration guidance. If a profile does not appear, follow [A profile is missing or skipped](troubleshooting.md#a-profile-is-missing-or-skipped).

## Save presets and revalidate live data

Presets store concrete agent, model, and optional variant assignments in `model-configurator-presets.json` under the effective global OpenCode configuration directory. They are separate from profiles and can be selected after either scope is chosen.

Every assignment write has a preset identity. After configuring agents or using a profile, the review offers two actions:

- **Create new preset** prompts for a new, non-empty name. An existing name must be chosen through the update flow.
- **Update existing preset** opens the saved preset list and replaces the selected entry without asking you to type its name again.

Starting from a saved preset instead shows **Apply preset "name"**. The normal configuration write still runs when that preset already matches every live concrete assignment; the plugin does not persist or infer an active preset.

Before applying a preset, the plugin checks its assignments against the live agents, connected providers, models, and variants. It identifies stale entries and skips them before applying any valid remainder. It does not silently delete the saved preset.

Immediately before the final write, the plugin reloads the model catalog. If a pending model or variant has become stale, it stops without writing and asks you to reopen Models Presets and select again. For storage or stale-entry recovery, see [A preset cannot be loaded or applied](troubleshooting.md#a-preset-cannot-be-loaded-or-applied).

## Understand environment precedence

`OPENCODE_CONFIG_CONTENT` and `OPENCODE_CONFIG` can each override values read from configuration files. When either variable is present, the scope chooser warns that the selected file can be written successfully without becoming the effective value.

If the written assignment is not the value OpenCode uses, follow [Environment values appear instead of file changes](troubleshooting.md#environment-values-appear-instead-of-file-changes).

## Know which files are touched

| Data | Plugin behavior |
| --- | --- |
| Project or global OpenCode configuration | Writes targeted `agent.<name>.model` and `agent.<name>.variant` values; preserves unrelated JSONC keys, comments, and file mode |
| Global preset store | Writes saved concrete assignments to `model-configurator-presets.json` |
| Profile files | Reads them as optional input; does not write them |
| `tui.json` | Reads the plugin registration and `profilesDir` option; Models Presets does not edit it |

Models Presets writes model identifiers and variants; it never writes provider credentials.

### Assignment write guarantees

Named apply and assignment writes follow this order:

1. The plugin reloads the live model catalog. When creating or updating a preset, it replaces the global preset store atomically; if that write fails, it does not write `opencode.json(c)`.
2. Before writing the assignment destination, it compares it with the snapshot opened by the wizard. If the file changed or appeared in the meantime, it aborts instead of overwriting newer content.
3. It writes and flushes a temporary file, atomically replaces the destination, preserves the destination mode, and validates the persisted content.
4. If assignment persistence fails after its transaction starts, recovery restores the previous configuration content or removes a destination created by the failed attempt. A preset saved before that failure remains available for a later retry.

Use the focused recovery steps for [a concurrent change](troubleshooting.md#the-configuration-changed-while-the-wizard-was-open) or [a write failure](troubleshooting.md#the-configuration-cannot-be-written).

## Predict live apply and restart outcomes

The completion message distinguishes a successful write from live application:

| Reported outcome | What to do |
| --- | --- |
| Applied live | The current OpenCode server has the assignments. Restart any other running OpenCode processes. |
| Restart required | The file was written, but the applicable reload route was unavailable, rejected the update, or could not apply a global removal-only change. Restart the affected OpenCode sessions. |
| Preset saved, configuration not applied | The named preset remains saved. Resolve the reported configuration failure, reopen, and retry. |
| Error before completion | Do not assume a write succeeded. Follow the reported path and the matching recovery symptom. |

See [Changes were written but are not active](troubleshooting.md#changes-were-written-but-are-not-active) for restart recovery.
