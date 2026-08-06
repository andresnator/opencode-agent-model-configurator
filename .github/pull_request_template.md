## Summary

<!-- What does this pull request change, and why? -->

## Public impact

<!-- Describe user- or contributor-facing contract changes. Write "None" when there is no public impact. -->

## Test scenarios

<!--
List every focused or manual scenario that must pass before merge. Copy the block below for each scenario.

### Scenario: <behavior or risk being verified>

- Environment: <operating system, Node.js version, OpenCode version when applicable, and project/global scope>
- Preconditions: <fixtures, configuration, or starting state>
- Steps:
  1. <exact command or action>
  2. <next command or action>
- Expected result: <observable outcome>
- Observed result and evidence: <actual outcome, logs, screenshots, or CI link>
- Outcome: Passed | Failed | Not run — <required reason>
-->

## Verification

<!-- List the commands or manual checks you ran and their results. Explain anything not run. -->

## Quality checklist

<!-- Check every applicable item. For an item that does not apply, check it and add "N/A — <reason>". -->

- [ ] The change is focused and contains no unrelated modifications.
- [ ] `npm run check` completed successfully.
- [ ] Required CI checks pass on Ubuntu and macOS.
- [ ] Observable behavior changes have contract coverage, or `N/A` is justified.
- [ ] Committed `dist/` artifacts were regenerated and match the source.
- [ ] Every required manual scenario above was executed and its evidence recorded.
- [ ] Public impact and compatibility implications are described.
- [ ] Documentation, schemas, examples, and changelog are aligned, or `N/A` is justified.
- [ ] Failure, concurrency, and recovery behavior was considered when applicable.
- [ ] The diff contains no secrets, machine-specific paths, temporary files, or local-only data.

## Documentation or Changeset effect

<!-- List updated documentation or a Changeset. If neither is needed, explain why. -->
