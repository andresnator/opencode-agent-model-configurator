# Contributing

Keep changes provider-agnostic, harness-agnostic, and compatible with the OpenCode range declared in `package.json`.

## Before opening a pull request

```bash
npm ci
npm run check
git diff --check
```

Behavior changes need a contract test with visible `// Given`, `// When`, and `// Then` phases. Do not add provider IDs, model IDs, agent names, or config paths as product defaults. Examples may use placeholders when the text makes that explicit.

When changing the OpenCode API boundary, verify the current upstream TUI plugin specification and update `engines.opencode` only with runtime evidence.
