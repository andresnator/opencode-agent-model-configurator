## Summary

<!-- What changed, why, and who is affected? -->

## Verification

<!-- List each command or manual check and its result. Explain anything not run. -->

## Manual scenarios

<!--
Delete this section when no manual check is needed. Copy this block for each scenario.

### Scenario: <what you checked>

- Environment: <operating system, OpenCode version, and project/global scope>
- Steps:
  1. <action>
  2. <action>
- Expected result: <observable outcome>
- Result and evidence: <what happened, with logs, screenshots, or a CI link>
-->

## Checklist

<!-- Check each applicable item. For N/A, check it and add a short reason. -->

- [ ] The title follows `type(scope)!: description` with an allowed Conventional Commit type.
- [ ] `pnpm run check` completed successfully.
- [ ] `pnpm run security:check` completed successfully.
- [ ] Required CI checks pass on Ubuntu and macOS.
- [ ] Observable behavior changes have contract coverage, or `N/A` is justified.
- [ ] Required manual scenarios and evidence are included.
- [ ] Documentation was updated or created when needed.
- [ ] Relevant failure, concurrency, and recovery behavior was considered.
- [ ] The diff contains no secrets, machine-specific paths, temporary files, or local-only data.

## Documentation or release effect

<!-- List changed docs and say whether this should produce a release. Explain N/A. -->
