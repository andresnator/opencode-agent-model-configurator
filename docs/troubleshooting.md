# Troubleshoot by symptom

Find the symptom you can see and follow its first action.

| Symptom | First action |
| --- | --- |
| Plugin or command is missing | Check the npm entry in `tui.json`, then restart OpenCode |
| Agent, provider, model, or variant is missing | Refresh the live OpenCode catalog |
| Profile or preset is missing | Read the warning before editing stored data |
| Configuration changed or cannot be written | Keep the current file, fix the cause, and reopen the plugin |
| Changes were written but are inactive | Check environment overrides, then restart OpenCode |

Normal behavior is described in [Configuration](configuration.md).

## The plugin does not load

1. Open the `tui.json` used by OpenCode.
2. Confirm that exactly one string or tuple uses the npm spec `opencode-models-presets` or `opencode-models-presets@<version>`.
3. If the entry pins a version, confirm that the release exists and supports your OpenCode version.
4. Restart OpenCode and try **Configure model presets** or `/models-profiles`.
5. If the entry is absent or invalid, repeat the [installation](../README.md#quick-start).

The README is the only source for installation commands.

## Update the plugin

- For normal updates, keep the bare `"opencode-models-presets"` entry and restart OpenCode. Bare npm specs follow `latest` and can refresh when the cached package is stale.
- For a pinned install, change only the version in the matching `tui.json` entry, for example from `opencode-models-presets@0.3.1` to a newer stable release.
- If the entry is a tuple, preserve its options object.

Do not edit unrelated entries or use `npm install -g`.

## OpenCode says paths are still syncing

Wait for project path syncing to finish, then open Models Presets again.

## An agent, provider, model, or variant is missing

- **Agent list fails to load:** update to a supported OpenCode version, restart, and retry.
- **No agents appear:** confirm that OpenCode exposes agents for the active directory. Enable **Show internal agents** if the missing agent is hidden.
- **No providers or models appear:** connect the provider in OpenCode, then reopen the plugin.
- **A model or variant disappears during review:** reopen the plugin and select again. The stopped flow did not write the stale selection.

## A profile is missing or skipped

1. Check the `profilesDir` rules in [Configuration](configuration.md#add-profiles).
2. Confirm that the directory is readable and the file ends in `.json`.
3. Fix the file using the linked example and schema.
4. Reopen the plugin.

Warnings name invalid files and unknown agents. Valid agents in the same profile remain available. A missing profile directory does not stop individual agent configuration.

## A preset cannot be loaded or applied

- **Preset storage is invalid or unreadable:** back up and repair `model-configurator-presets.json`, then reopen the plugin. Named actions stay disabled until the file is valid.
- **Some assignments are stale:** review the warning, apply any useful valid assignments, then update the preset with current values.
- **Every assignment is stale:** create a new preset from the live catalog.
- **A final selection became stale:** reopen and select again. Nothing was written.
- **The preset changed before update:** reopen the list and review the newer version. The plugin kept it unchanged.

Do not delete preset storage only to hide a warning. Delete it only when you want the full preset reset described below.

## Environment values override file changes

`OPENCODE_CONFIG_CONTENT` or `OPENCODE_CONFIG` can override a successful file write.

1. Check the environment of the process that starts OpenCode.
2. Update or remove the unwanted variable.
3. Restart OpenCode and verify the assignment.

## The configuration changed during the wizard

The plugin stops instead of overwriting a file that changed after the wizard opened.

Keep the newer file, reopen Models Presets, review the recalculated changes, and retry.

## The configuration cannot be written

1. Note the exact path and error.
2. Keep any existing content.
3. Fix the cause, such as invalid JSON/JSONC, permissions, or unavailable storage.
4. Reopen Models Presets, review, and retry.

If a write started and failed, the plugin restores the previous configuration. A preset saved before that failure remains available.

## Changes were written but are not active

If the completion message says **Restart required**, restart every affected OpenCode session. Global removal-only changes also require a restart.

If it says **Applied live**, only the current server was updated. Restart other running OpenCode processes.

If a restart still shows the old value, check [environment overrides](#environment-values-override-file-changes).

## Remove or reset the plugin

First remove the registration:

1. Close OpenCode sessions that use the plugin.
2. Open `tui.json`.
3. Remove only the string or tuple whose npm spec is `opencode-models-presets` or `opencode-models-presets@<version>`.
4. Keep every other plugin entry and option.
5. Restart OpenCode and confirm that the Models Presets entry points are gone.

Then choose only the cleanup you need:

- Delete `model-configurator-presets.json` only if you want to remove every saved preset.
- Remove only known Models Presets assignments from project or global OpenCode configuration. The files do not record who created each assignment.
- Keep or delete your profile files separately. The plugin does not own them.

Never delete an entire OpenCode configuration file to remove a few assignments.

## Report a bug

If these steps do not fix the problem, [open a GitHub Issue](https://github.com/andresnator/opencode-agent-model-configurator/issues) with:

- plugin tag or commit and OpenCode version;
- operating system, shell, and project or global scope;
- short reproduction steps, expected result, and actual result;
- the exact sanitized error; and
- the smallest relevant sanitized configuration excerpt.

Remove secrets, credentials, user names, private paths, and private repository data. Report suspected vulnerabilities through the [private security process](../SECURITY.md), not a public Issue.
