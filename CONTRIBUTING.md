# Contributing

Start with the pinned Node.js and pnpm versions, install the locked dependencies, and run the repository's complete and security checks before opening a pull request.

## Set up the checkout

| Tool | Required contract |
| --- | --- |
| Node.js | 22.23.2, matching `.node-version` and CI |
| Package manager | pnpm 10.34.5, matching `packageManager` and `pnpm-lock.yaml` |
| TypeScript | 5.9.3, strict mode, targeting ES2022 |

Install exactly the dependency graph recorded in the lockfile:

```bash
pnpm install --frozen-lockfile
```

Do not replace the lockfile or rewrite it with npm, Yarn, or another pnpm version. npm remains available only for registry-signature verification.

## Load the development checkout

To exercise a change in OpenCode, follow the README's [existing-checkout loading route](README.md#load-an-existing-checkout) with the checkout under test. The README owns the registration command. Keep the checkout at the registered path and restart OpenCode before manual verification.

## Make a focused change

- Keep production behavior provider-agnostic and agent-harness-agnostic.
- Remain compatible with the OpenCode range declared in `package.json`.
- Do not add provider IDs, model IDs, agent names, or configuration paths as product defaults. Examples may use clearly identified placeholders.
- Keep public documentation in English and update the canonical owner when behavior, configuration, recovery, schemas, examples, or contribution routes change.

When changing the OpenCode API boundary, verify the current upstream TUI plugin specification and update `engines.opencode` only with runtime evidence.

## Follow the test contract

Observable behavior changes require a contract test in `tests/contracts.ts`:

- import native assertions from `node:assert/strict`;
- name the test `should...When...`; and
- divide every non-trivial test into visible `// Given`, `// When`, and `// Then` sections.

## Navigate the repository

| Path | Purpose |
| --- | --- |
| `src/` | Plugin entry point, domain behavior, wizard, persistence, presets, and live apply |
| `tests/contracts.ts` | Executable behavioral contracts |
| `scripts/` | Build and package-boundary checks |
| `schemas/` | Published profile schema |
| `examples/` | Published profile examples |
| `docs/` | Canonical configuration and recovery guidance |
| `.github/` | CI and public contribution intake |

## Verify the change

Run the one required verification sequence:

```bash
pnpm run check
```

It runs type checking, contract tests, workflow-action pinning, the build, and package verification. Record any focused manual checks separately in the pull request.

Run the dependency-security gates separately:

```bash
pnpm run security:check
```

The audit rejects every known vulnerability at `low` severity or higher. The signature check verifies registry signatures for the installed dependency graph. Do not use an automatic audit fix in place of reviewing and updating the lockfile.

## Prepare the pull request

- Use `type(scope)!: description` for the pull request title. The scope and `!` are optional; valid types are `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`.
- Use `feat`, `fix`, or `deps` when a normal release should be proposed. Before `1.0.0`, all three produce a patch release; a breaking title (`!`) or `BREAKING CHANGE:` footer produces a minor release. Other types do not produce a release unless they are breaking.
- Put useful release detail and any `BREAKING CHANGE:` footer in the pull request body. GitHub preserves the title as the squash commit subject and the body as its message.
- Summarize the change and its public impact.
- Include verification evidence, not only a claim that checks passed.
- Identify the documentation or release effect, including why neither is needed when applicable.
- Keep tests, schemas, examples, and their canonical documentation aligned.

Release Please opens or updates a release pull request after qualifying changes reach `main`. Merging that release pull request updates `package.json` and `CHANGELOG.md`, creates a `vX.Y.Z` tag, and publishes a GitHub Release. It does not publish the package to npm.
