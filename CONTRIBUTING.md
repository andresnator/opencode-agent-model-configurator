# Contributing

Use Node.js `26.4.0` and pnpm `10.34.5`.

## Quick path

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

Make one focused change, update its tests and documentation, then run both checks before opening a pull request. Do not rewrite `pnpm-lock.yaml` with npm, Yarn, or another pnpm version.

## Test locally

Register the current repository instead of the npm package:

Add an absolute path to this repository in the global `cli.json`:

```json
{
  "plugins": [{"package": "/absolute/path/to/opencode-agent-model-configurator"}]
}
```

The root `tui.ts` entrypoint loads the compiled distribution for local V2 discovery. Run `pnpm run build` before loading the package. Preserve all other plugin entries and options when replacing the npm registration.

Keep the repository at that path, restart OpenCode, and test **Configure model presets** or `/models-profiles`.

## Keep the change focused

- Keep behavior independent of providers, model IDs, and agent names.
- Keep public documentation in English.
- Put behavior contracts in `tests/contracts.ts`.
- Name tests `should...When...` and use `// Given`, `// When`, and `// Then` in non-trivial cases.
- Update schemas and examples when their shared contract changes.

## Open the pull request

Use `type(scope)!: description`; `scope` and `!` are optional. Supported types are `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`.

Describe the change and list automated and manual verification. `feat`, `fix`, and `deps` changes normally create a release through Release Please. Stable releases are published to npm by `.github/workflows/publish.yml` through Trusted Publishing; no npm token belongs in the repository.
