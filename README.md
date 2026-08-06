# OpenCode Agent Model Configurator

Choose and review model and variant assignments for every agent visible to your running OpenCode server. The plugin uses live agents, providers, models, and variants, then writes only the changes you approve.

## Quick path

This is the temporary distribution route: the plugin is not available on npm, so choose a published `vX.Y.Z` tag from [GitHub Releases](https://github.com/andresnator/opencode-agent-model-configurator/releases) and retain its local checkout.

1. Confirm that Git is installed and OpenCode is `>=1.17.15 <2`.
2. Replace the placeholder with the release tag you selected, then clone it:
   ```bash
   RELEASE_TAG=vX.Y.Z
   git clone --branch "$RELEASE_TAG" --depth 1 https://github.com/andresnator/opencode-agent-model-configurator.git
   ```
3. Enter the checkout:
   ```bash
   cd opencode-agent-model-configurator
   ```
4. Register that local path globally:
   ```bash
   opencode plugin "$PWD" --global
   ```
5. Keep the cloned directory at that path and restart OpenCode.
6. Press `Ctrl+P` and choose **Configure agent models**, or run `/model-configurator`. Success means **Configure agent models** is available and the configurator opens.

### Load an existing checkout

To exercise code already checked out for development, start at that checkout's repository root, use the registration action in step 4, then follow steps 5–6. This route does not clone or switch the checkout revision.

## Configuration flow

1. Choose project or global scope.
2. Start with live agents, an optional profile, or a saved preset.
3. Keep, replace, or inherit assignments against the live model catalog.
4. Review the complete change set before applying it.
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

The configurator shows the full change set before writing, preserves unrelated JSONC content, and protects assignment writes against concurrent edits and persistence failures. Read the [assignment write guarantees](docs/configuration.md#assignment-write-guarantees) for the canonical safety contract.

For loading, command, catalog, profile, preset, write, reload, or deliberate-removal problems, [troubleshoot by symptom](docs/troubleshooting.md#troubleshoot-by-symptom).

## Support and trust

- For non-security bugs, questions, or proposals, use [GitHub Issues](https://github.com/andresnator/opencode-agent-model-configurator/issues). Public support is best-effort.
- For a suspected vulnerability, do not use a public Issue; follow [private security reporting](SECURITY.md#report-a-security-vulnerability-privately).
- To prepare a change, follow the [contributor guide](CONTRIBUTING.md#contributing).
- Review project history in the [changelog](CHANGELOG.md) and terms in the [MIT License](LICENSE).
