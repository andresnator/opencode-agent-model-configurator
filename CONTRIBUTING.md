# Contributing

## Quick path

1. Use Node.js `22.23.2` and pnpm `10.34.5`.
2. Install locked dependencies.
3. Make one focused change and add contract coverage for changed behavior.
4. Run the complete and security checks.
5. Open a pull request with evidence.

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

## Set up the repository

| Tool | Version |
| --- | --- |
| Node.js | `22.23.2`, from `.node-version` |
| pnpm | `10.34.5`, from `packageManager` |
| TypeScript | `5.9.3`, strict mode, ES2022 target |

Do not replace `pnpm-lock.yaml` or rewrite it with npm, Yarn, or another pnpm version. npm is used only to verify registry signatures.

## Test the plugin in OpenCode

From the checkout under test, follow [Load a development checkout](README.md#load-a-development-checkout). Keep the checkout at its registered path and restart OpenCode before manual testing.

## Keep changes focused

- Keep behavior independent of specific providers and agent harnesses.
- Support the OpenCode range in `package.json`.
- Do not add provider IDs, model IDs, agent names, or configuration paths as product defaults.
- Use obvious placeholders in examples.
- Keep public documentation in English.
- Update tests, schemas, examples, and docs when their shared behavior changes.

For OpenCode API changes, check the current upstream TUI plugin specification. Change `engines.opencode` only with runtime evidence.

## Write contract tests

Put observable behavior tests in `tests/contracts.ts`.

- Import assertions from `node:assert/strict`.
- Name tests `should...When...`.
- Use visible `// Given`, `// When`, and `// Then` sections in non-trivial tests.

## Find your way around

| Path | Contents |
| --- | --- |
| `src/` | Plugin entry point, wizard, persistence, presets, and live apply |
| `tests/contracts.ts` | Behavioral contracts |
| `scripts/` | Build, installation, and package checks |
| `schemas/` | Profile JSON Schema |
| `examples/` | Profile examples |
| `docs/` | Configuration and troubleshooting |
| `.github/` | CI, issue form, and pull request template |

## Verify the change

`pnpm run check` runs type checking, contract tests, workflow pin checks, the build, and package verification.

`pnpm run security:check` rejects known vulnerabilities at `low` severity or higher and verifies dependency registry signatures. Review and update the lockfile instead of using an automatic audit fix.

Record focused manual checks separately in the pull request.

## Open the pull request

- Use `type(scope)!: description` for the title. The scope and `!` are optional.
- Use one of these types: `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, or `test`.
- Explain the change, public impact, verification evidence, and documentation effect.
- Include a `BREAKING CHANGE:` footer when needed.
- Keep secrets, private paths, temporary files, and local-only data out of the diff.

`feat`, `fix`, and `deps` normally propose a release. Before `1.0.0`, they produce a patch release. Breaking changes produce a minor release. Other types do not produce a release unless they are breaking.

After a qualifying change reaches `main`, Release Please opens or updates a release pull request. Merging it updates `package.json` and `CHANGELOG.md`, creates a `vX.Y.Z` tag, and publishes a GitHub Release. It does not publish to npm.
