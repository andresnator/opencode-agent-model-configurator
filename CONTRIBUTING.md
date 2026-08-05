# Contributing

Start with Node 22 and npm, install the locked dependencies, and run the repository's complete check before opening a pull request.

## Set up the checkout

| Tool | Required contract |
| --- | --- |
| Node.js | Node 22, matching CI |
| Package manager | npm with the committed lockfile-v3 `package-lock.json` |
| TypeScript | 5.9.3, strict mode, targeting ES2022 |

Install exactly the dependency graph recorded in the lockfile:

```bash
npm ci
```

Do not replace the lockfile or rewrite it with another package manager.

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
npm run check
```

It runs type checking, contract tests, the build, and package verification. Record any focused manual checks separately in the pull request.

## Prepare the pull request

- Summarize the change and its public impact.
- Include verification evidence, not only a claim that checks passed.
- Identify the documentation or Changeset effect, including why neither is needed when applicable.
- Keep tests, schemas, examples, and their canonical documentation aligned.
