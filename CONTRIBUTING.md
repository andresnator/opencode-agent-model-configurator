# Contributing

Use Node.js `22.23.2` and pnpm `10.34.5`.

## Quick path

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

Make one focused change, update its tests and documentation, then run both checks before opening a pull request. Do not rewrite `pnpm-lock.yaml` with npm, Yarn, or another pnpm version.

## Test locally

Register the current repository instead of the npm package:

```bash
opencode plugin "$PWD" --global --force
```

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
