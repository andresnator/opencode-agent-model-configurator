# Changelog

## [0.3.2](https://github.com/andresnator/opencode-agent-model-configurator/compare/v0.3.1...v0.3.2) (2026-08-27)


### Dependencies

* bump the non-major-dependencies group with 5 updates ([#22](https://github.com/andresnator/opencode-agent-model-configurator/issues/22)) ([d5db56c](https://github.com/andresnator/opencode-agent-model-configurator/commit/d5db56cdfa8cedb3a23f86ea3faf95c79284549c))

## [0.3.1](https://github.com/andresnator/opencode-agent-model-configurator/compare/v0.3.0...v0.3.1) (2026-08-26)


### Bug Fixes

* publish models presets through npm ([#18](https://github.com/andresnator/opencode-agent-model-configurator/issues/18)) ([cd19f4f](https://github.com/andresnator/opencode-agent-model-configurator/commit/cd19f4fd5480d66451f396f87d9f34fdba0bdc0f))

## [0.3.0](https://github.com/andresnator/opencode-agent-model-configurator/compare/v0.2.1...v0.3.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* rename slash command to models-profiles ([#16](https://github.com/andresnator/opencode-agent-model-configurator/issues/16))

### Features

* rename slash command to models-profiles ([#16](https://github.com/andresnator/opencode-agent-model-configurator/issues/16)) ([133b4fc](https://github.com/andresnator/opencode-agent-model-configurator/commit/133b4fc6e6d1270ef90cf655fcf64fc74c967f2c))
* require named presets for model configurations ([#14](https://github.com/andresnator/opencode-agent-model-configurator/issues/14)) ([a79ce63](https://github.com/andresnator/opencode-agent-model-configurator/commit/a79ce63d6bddcbf5fc22a85b467bdaa50f3cc068))

## [0.2.1](https://github.com/andresnator/opencode-agent-model-configurator/compare/v0.2.0...v0.2.1) (2026-08-25)


### Dependencies

* bump the non-major-dependencies group across 1 directory with 7 updates ([#12](https://github.com/andresnator/opencode-agent-model-configurator/issues/12)) ([bef4d97](https://github.com/andresnator/opencode-agent-model-configurator/commit/bef4d9796edd9f94c4ac56d0f172f81bbad1054d))

## [0.2.0](https://github.com/andresnator/opencode-agent-model-configurator/compare/v0.1.2...v0.2.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* rename plugin to models-presets with latest install ([#9](https://github.com/andresnator/opencode-agent-model-configurator/issues/9))

### Features

* rename plugin to models-presets with latest install ([#9](https://github.com/andresnator/opencode-agent-model-configurator/issues/9)) ([434b422](https://github.com/andresnator/opencode-agent-model-configurator/commit/434b4221ef908bd7b212d1563750a8a2f1c79b8d))

## [0.1.2](https://github.com/andresnator/opencode-agent-model-configurator/compare/v0.1.1...v0.1.2) (2026-08-06)


### Dependencies

* bump the non-major-dependencies group with 2 updates ([#5](https://github.com/andresnator/opencode-agent-model-configurator/issues/5)) ([c241b7a](https://github.com/andresnator/opencode-agent-model-configurator/commit/c241b7a89140568e2fed431f0f769e07dc1102ee))

## [0.1.1](https://github.com/andresnator/opencode-agent-model-configurator/compare/v0.1.0...v0.1.1) (2026-08-06)


### Dependencies

* bump @types/node from 24.13.3 to 26.1.2 ([#6](https://github.com/andresnator/opencode-agent-model-configurator/issues/6)) ([782b1e7](https://github.com/andresnator/opencode-agent-model-configurator/commit/782b1e7d6dd461a54b17eeccb87077469347a2bd))

## 0.1.0 - 2026-08-04

- Extract the model configurator from `agents-orchestrator`.
- Discover agents and connected model catalogs live from OpenCode.
- Support primary agents, subagents, optional profiles, and saved presets.
- Preserve JSONC content with transactional project/global writes.
- Bundle runtime code into a dependency-free TUI package artifact.
