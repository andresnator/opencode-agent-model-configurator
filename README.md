# OpenCode Models Presets

Choose and review model, variant, and preset assignments for every agent visible to your running OpenCode server. The plugin uses live agents, providers, models, and variants, then writes only the changes you approve.

## Install the latest release

The plugin is not available on npm. Confirm that `curl`, Git, and OpenCode `>=1.17.15 <2` are installed, then copy and run this complete command:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/andresnator/opencode-agent-model-configurator/main/scripts/install.sh -o /tmp/opencode-models-presets-install.sh && sh /tmp/opencode-models-presets-install.sh latest
```

`latest` resolves to the highest published `vX.Y.Z` release tag. The installer clones or updates that release at `/tmp/opencode-models-presets`, then registers the retained path globally with OpenCode. To install a specific release, replace `latest` with its published tag; older releases retain the names and commands documented in that release. Set `MODELS_PRESETS_INSTALL_DIR` to an absolute path before running the command if `/tmp/opencode-models-presets` is not suitable.

Keep the cloned directory in place because OpenCode records its path in `tui.json`. If the operating system clears `/tmp`, rerun the command. Restart OpenCode, press `Ctrl+P`, and confirm that **models-presets** is active; then choose **Configure model presets** or run `/models-presets`.

### Load an existing checkout

To exercise code already checked out for development, start at that checkout's repository root and run the complete registration command:

```bash
opencode plugin "$PWD" --global --force
```

Keep the checkout at that path, restart OpenCode, and use **Configure model presets** or `/models-presets`. This route does not clone or switch the checkout revision.

## Configuration flow

1. Choose project or global scope.
2. Start with live agents, an optional profile, or a saved preset.
3. Keep, replace, or inherit assignments against the live model catalog.
4. Review the complete change set, then create a named preset or select an existing preset to update. A saved preset is applied under its existing name.
5. Follow the completion message: the current server may update live, or affected OpenCode sessions must restart.

For scope destinations, assignment actions, profiles, presets, and environment precedence, use the canonical [configuration guide](docs/configuration.md#configure-agent-models-safely).

## Compatibility

| Concern | Contract |
| --- | --- |
| OpenCode | `>=1.17.15 <2` |
| Providers and models | Discovered from the running OpenCode server; none is hardcoded |
| Agents | Primary agents and subagents exposed by OpenCode |
| Configuration scope | Project or global |

## Safety and recovery

The plugin shows the full change set before writing, requires a preset identity, preserves unrelated JSONC content, and protects assignment writes against concurrent edits and persistence failures. Read the [assignment write guarantees](docs/configuration.md#assignment-write-guarantees) for the canonical safety contract.

For loading, command, catalog, profile, preset, write, reload, or deliberate-removal problems, [troubleshoot by symptom](docs/troubleshooting.md#troubleshoot-by-symptom).

## Support and trust

- For non-security bugs, questions, or proposals, use [GitHub Issues](https://github.com/andresnator/opencode-agent-model-configurator/issues). Public support is best-effort.
- For a suspected vulnerability, do not use a public Issue; follow [private security reporting](SECURITY.md#report-a-security-vulnerability-privately).
- To prepare a change, follow the [contributor guide](CONTRIBUTING.md#contributing).
- Review project history in the [changelog](CHANGELOG.md) and terms in the [MIT License](LICENSE).
