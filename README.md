# OpenCode Models Presets

Assign models and variants to OpenCode agents without editing configuration files by hand. Save those choices as named presets and reuse them later.

The plugin reads agents, providers, models, and variants from your running OpenCode server. It does not use a hardcoded catalog.

## Quick start

You need `curl`, Git, and OpenCode `>=1.17.15 <2`. The plugin is not published on npm.

Install the latest release:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/andresnator/opencode-agent-model-configurator/main/scripts/install.sh -o /tmp/opencode-models-presets-install.sh && sh /tmp/opencode-models-presets-install.sh latest
```

Then:

1. Keep `/tmp/opencode-models-presets` in place. OpenCode loads the plugin from that path.
2. Restart OpenCode.
3. Press `Ctrl+P` and choose **Configure model presets**, or run `/models-profiles`.

If your system clears `/tmp`, run the installer again. To use a permanent location, set `MODELS_PRESETS_INSTALL_DIR` to an absolute path before installing.

To install a specific release, replace `latest` with a tag such as `v0.3.0`.

## Use the plugin

1. Choose project or global scope.
2. Start from live agents, an optional profile, or a saved preset.
3. Keep, replace, or inherit each agent assignment.
4. Review every change.
5. Create a named preset or update an existing one, then apply it.
6. Restart affected OpenCode sessions if the completion message asks you to.

See [Configuration](docs/configuration.md) for scopes, profiles, presets, files, and write safety.

## Load a development checkout

From the repository root, run:

```bash
opencode plugin "$PWD" --global --force
```

Keep the checkout at the registered path, then restart OpenCode. This command registers the current checkout without changing its revision.

## Compatibility

| Item | Support |
| --- | --- |
| OpenCode | `>=1.17.15 <2` |
| Agents | Primary agents and subagents exposed by OpenCode |
| Models | Connected providers and their live model catalogs |
| Scope | Project or global configuration |

## Help and project information

- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Report a non-security problem](https://github.com/andresnator/opencode-agent-model-configurator/issues)
- [Report a security vulnerability](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)
