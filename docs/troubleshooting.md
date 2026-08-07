# Troubleshoot by symptom

Start with the message or missing behavior you can see. Normal scope, file, profile, preset, precedence, and write behavior is defined in [Configure agent models safely](configuration.md#configure-agent-models-safely).

| Symptom | First action |
| --- | --- |
| Plugin or entry point is missing | Verify the registered local path, then restart OpenCode |
| Agent, provider, model, or variant is missing | Refresh the relevant live OpenCode catalog |
| Profile or preset is unavailable | Read the warning before changing or deleting stored data |
| File changed or cannot be written | Preserve the current file and reopen after fixing the cause |
| Write succeeded but values are inactive | Check environment precedence, then restart affected sessions |

## The plugin does not load or its entry points are missing

1. Open the `tui.json` used by OpenCode and confirm its plugin entry points to the retained checkout's current absolute path.
2. If the checkout moved, restore it at that path or [remove the stale registration](#remove-or-reset-the-plugin-deliberately) before registering another path.
3. Restart OpenCode and try either entry point from [Install the latest release](../README.md#install-the-latest-release).
4. If the checkout is missing or damaged, repeat the documented release installation and retain the new checkout.

The README owns the registration commands; this page does not provide a second installation route.

## OpenCode says paths are still syncing

Wait for OpenCode to finish syncing its project paths, then open Models Presets again. The plugin does not start until OpenCode reports a usable project directory.

## An agent, provider, model, or variant is missing

- **Agent list cannot be read:** update to a compatible OpenCode version, restart it, and reopen Models Presets. The plugin needs the live agent endpoint.
- **No agents are shown:** confirm OpenCode itself exposes agents for the active directory. Use **Show internal agents** in the agent hub if the missing agent is hidden.
- **No providers or models are shown:** connect the provider in OpenCode, verify that it exposes models, and reopen Models Presets.
- **A model or variant disappeared at review:** reopen and reselect. Final live-catalog validation stops the flow before writing stale selections.

The catalog and revalidation contract is in [Save presets and revalidate live data](configuration.md#save-presets-and-revalidate-live-data).

## A profile is missing or skipped

1. Check how `profilesDir` resolves in [Use optional profiles](configuration.md#use-optional-profiles), and confirm that the directory is readable.
2. Confirm the file ends in `.json`.
3. Read the warning for the file path and validation error, repair the profile against the linked schema, and reopen Models Presets.
4. If the warning names unknown agents, correct those names or accept that they are skipped. Known agents in the same valid profile remain available.

A missing profile directory is not a plugin-load failure. Continue by configuring live agents individually if profiles are not needed.

## A preset cannot be loaded or applied

- **Preset storage is malformed, unreadable, or has an invalid shape:** Models Presets preserves the legacy-compatible `model-configurator-presets.json` filename, disables preset operations, and keeps core agent configuration usable. Back up and repair the file, then reopen the plugin.
- **Some assignments are stale:** review the listed agents. Apply the valid remainder if it is still useful, then reselect live assignments and overwrite the preset when ready.
- **Every assignment is stale:** nothing is applied. Recreate the preset from live agents, models, and variants.
- **A final selection became stale:** reopen and reselect; the stopped flow did not write those pending changes.

Do not delete malformed storage merely to dismiss the warning. Delete it only as the deliberate reset described in [Remove or reset the plugin deliberately](#remove-or-reset-the-plugin-deliberately). Preset storage and validation are defined in [Save presets and revalidate live data](configuration.md#save-presets-and-revalidate-live-data).

## Environment values appear instead of file changes

The wizard can write the selected file while the environment variable named in its precedence warning supplies the effective value.

1. Check the environment of the process that launches OpenCode.
2. Update or remove the variable that should no longer take precedence.
3. Restart OpenCode, reopen Models Presets, and verify the assignment again.

See [Understand environment precedence](configuration.md#understand-environment-precedence) for the canonical precedence contract.

## The configuration changed while the wizard was open

The write aborts rather than overwrite a file that changed or appeared after the plugin read it.

Preserve the newer content, close the failed flow, reopen Models Presets to load a fresh snapshot, review the recalculated changes, and retry. The concurrency guarantee is defined under [Assignment write guarantees](configuration.md#assignment-write-guarantees).

## The configuration cannot be written

Assignment writes are atomic. If persistence fails after writing starts, recovery restores the previous content or removes a destination created by the failed attempt; Models Presets does not report partial success.

1. Note the exact destination and error shown by Models Presets.
2. Inspect the destination before editing it, and preserve any content that exists.
3. Fix the reported cause, such as invalid JSON/JSONC, directory permissions, or unavailable storage.
4. Reopen Models Presets, review the changes again, and retry.

The complete transaction contract is under [Assignment write guarantees](configuration.md#assignment-write-guarantees).

## Changes were written but are not active

If the completion message says the file was written but live application was unavailable or rejected, restart every affected OpenCode session. A global removal-only change also requires a restart.

If the message says the current server applied the change live, other running OpenCode processes still need a restart. If a restart does not reveal the written value, check [Environment values appear instead of file changes](#environment-values-appear-instead-of-file-changes). See [Predict live apply and restart outcomes](configuration.md#predict-live-apply-and-restart-outcomes) for the canonical outcomes.

## Remove or reset the plugin deliberately

Remove the path registration before deleting any checkout:

1. Close OpenCode sessions that use the plugin.
2. Open the `tui.json` used by OpenCode.
3. In its plugin list, remove only the local-path entry that points to this retained checkout. Preserve every other plugin entry and option.
4. Save `tui.json`, restart OpenCode, and confirm the Models Presets entry points are gone.

Then choose each cleanup action independently:

- Delete the retained checkout only when no registration points to it.
- Delete `model-configurator-presets.json` only if all saved presets should be discarded.
- In project or global OpenCode configuration, remove only agent `model` and `variant` assignments you know were created through Models Presets. The files do not record assignment provenance, so preserve uncertain and unrelated settings.
- Keep or delete user-authored profile files according to your own reuse needs; the plugin never owns them.

This is a manual, deliberate reset. Do not erase an entire OpenCode configuration file to remove targeted assignments.

## A public Issue is still needed

[Open a GitHub Issue](https://github.com/andresnator/opencode-agent-model-configurator/issues) only after the focused recovery step still fails. Include:

- plugin source tag and OpenCode version;
- operating system, shell, and whether the scope is project or global;
- minimal reproduction steps, expected result, and actual result;
- the exact error after replacing user names and private paths with placeholders; and
- only the smallest relevant, sanitized configuration excerpt.

Remove tokens, API keys, credentials, private repository details, and unrelated configuration. Do not post secrets or suspected vulnerability details in a public Issue.
