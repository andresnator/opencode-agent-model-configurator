# OpenCode Agent Model Configurator

Configure the model and variant of every agent visible to a running OpenCode server, without coupling the configuration to one agent harness, provider, or model catalog.

The plugin discovers agents, connected providers, models, and variants live from OpenCode. It supports both primary agents and subagents, project or global scope, optional reusable profiles, and saved concrete presets.

## Quick path

The repository is usable directly from a pinned GitHub release while the npm package is prepared for its first publication:

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/andresnator/opencode-agent-model-configurator.git
cd opencode-agent-model-configurator
opencode plugin "$PWD" --global
```

Keep the cloned directory: OpenCode records its absolute path in `tui.json`. No `npm install` or build step is required because the release contains the verified self-contained bundle.

Restart OpenCode, then open **Configure agent models** from `Ctrl+P` or run:

```text
/model-configurator
```

Use project scope to write `.opencode/opencode.json[c]`, or global scope to write the user OpenCode configuration.

> The npm manifest is ready for `opencode plugin opencode-agent-model-configurator@<version> --global`, but the package is not claimed to be available until an npm release is published. Direct `github:` and local `.tgz` specs are not documented as supported by OpenCode 1.18.10 and are intentionally not recommended here.

## What it does

1. Reads the live agent catalog from the current OpenCode server.
2. Groups primary agents with the subagents they explicitly delegate to.
3. Reads the connected provider/model/variant catalog at selection time.
4. Lets you keep, replace, or inherit each agent assignment.
5. Shows the complete change set before writing.
6. Preserves unrelated JSONC keys and comments through targeted edits.
7. Applies changes live when the OpenCode API supports the required reload route; otherwise it explains that a restart is needed.

Hidden internal agents remain hidden by default and can be revealed from the agent hub. Saved presets are revalidated against the live agents and model catalog before use.

## Compatibility and dependencies

| Concern | Contract |
|---|---|
| OpenCode | `>=1.17.15 <2`; tested locally with `1.18.10` |
| Providers | Any provider connected to OpenCode; none is hardcoded |
| Agent harness | None; agents are discovered through OpenCode |
| Runtime npm dependencies | None in the built package |
| Build tooling | Development-only; locked by `package-lock.json` |

`jsonc-parser` is used during development but bundled into `dist/tui.js`. `@opencode-ai/plugin` is a type/build dependency; runtime compatibility is declared through `engines.opencode`, as required by OpenCode's TUI plugin contract.

## Optional profiles

Profiles map agent names to abstract tiers. They never contain provider or model identifiers. The plugin works without profiles; every live agent remains configurable individually.

Point the plugin at a directory through its `tui.json` options:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-agent-model-configurator",
      { "profilesDir": ".opencode/model-profiles" }
    ]
  ]
}
```

Relative paths resolve from the active project directory. Absolute paths, `~` paths, and `file://` URLs are also accepted. See [the example profile](examples/profiles/team.example.json) and [its JSON Schema](schemas/profile.schema.json).

Unknown agents in a profile produce a warning and are skipped, allowing the same profile to work across partial or evolving harness installations.

## Persistence and safety

- Project assignments live under `.opencode/opencode.json` or `.opencode/opencode.jsonc`.
- Global assignments live in the effective OpenCode config directory.
- Presets live in `model-configurator-presets.json` under the global OpenCode config directory.
- Writes are atomic, preserve file mode and unrelated JSONC content, and abort if the file changes while the wizard is open.
- The plugin stores model identifiers and variants, never provider credentials.
- `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` can override file-based values; the wizard warns when either is present.

## Package shape

The package follows OpenCode's current TUI plugin contract:

- `exports["./tui"]` points to a target-exclusive TUI module.
- The default export is `{ id, tui }` and never includes a server plugin.
- `engines.opencode` declares the supported ABI range.
- The build produces a self-contained ESM bundle.
- Installation is delegated to `opencode plugin`, rather than a Homebrew formula or a harness-specific installer.

This matches the [OpenCode TUI plugin specification](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/specs/tui-plugins.md). Representative ecosystem packages use the same CLI/package route, including [oc-plugin-rainbow](https://github.com/anomalyco/oc-plugin-rainbow), [OpenCode DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), and [opencode-tree](https://github.com/ishaksebsib/opencode-tree).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify:package
```

Run everything with:

```bash
npm run check
```

The contract suite covers profile validation, live catalog normalization, parent/subagent grouping, wizard navigation, JSONC preservation, concurrent edits, rollback, presets, and project/global hot-apply behavior. Package verification checks the npm file list, entry shape, host compatibility range, absence of harness identifiers, and absence of non-Node runtime imports.

## Repository map

| Path | Purpose |
|---|---|
| `src/tui.tsx` | OpenCode TUI entry and command registration |
| `src/domain.ts` | Agent, profile, provider, model, and change contracts |
| `src/wizard.tsx` | Interactive selection and review flow |
| `src/persistence.ts` | Transactional JSON/JSONC configuration updates |
| `src/hot-apply.ts` | Project/global reload strategies and fallbacks |
| `src/presets.ts` | User-side reusable assignment presets |
| `tests/contracts.ts` | Extracted behavioral regression suite |
| `scripts/verify-package.mjs` | Published-artifact boundary checks |

## Origin

This standalone package was extracted from [`andresnator/agents-orchestrator`](https://github.com/andresnator/agents-orchestrator) at commit [`f5e061e`](https://github.com/andresnator/agents-orchestrator/commit/f5e061e7ae2ea7a5a2097c96aae241f459d64224). The extraction keeps the original MIT license and records the source in [NOTICE.md](NOTICE.md).

## License

[MIT](LICENSE)
