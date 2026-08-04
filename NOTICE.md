# Origin notice

The initial implementation in this repository was extracted on 2026-08-04 from:

- Repository: `andresnator/agents-orchestrator`
- Source commit: `f5e061e7ae2ea7a5a2097c96aae241f459d64224`
- Source paths: `domains/meta/tui-plugins/model-configurator.tsx`, its companion `model-configurator/` directory, and the corresponding model-configurator contract tests
- Original license: MIT

The standalone adaptation replaces harness-specific identifiers and packaging, makes profiles opt-in, adds package-relative and user-configured profile resolution, and bundles the JSONC implementation so the published runtime has no npm dependencies.
