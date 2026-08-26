import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const ROOT = new URL("../", import.meta.url)
const PUBLISH_WORKFLOW = new URL("../.github/workflows/publish.yml", import.meta.url)
const RELEASE_TAG_VERIFIER = new URL("../scripts/verify-release-tag.mjs", import.meta.url)
const workflow = await readFile(PUBLISH_WORKFLOW, "utf8")
const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))

function shouldRunOnlyForPublishedStableReleasesWhenPublishWorkflowIsTriggered() {
  // Given
  const trigger = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1].trim()

  // When
  const actual = {
    trigger,
    stableReleaseGuard: workflow.includes(
      "if: ${{ github.event.release.draft == false && github.event.release.prerelease == false }}",
    ),
    runsOnGitHubHostedUbuntu: workflow.includes("runs-on: ubuntu-latest"),
  }

  // Then
  assert.deepEqual(actual, {
    trigger: "release:\n    types: [published]",
    stableReleaseGuard: true,
    runsOnGitHubHostedUbuntu: true,
  })
}

function shouldUseExactToolchainAndReleaseTagWhenPackageIsPrepared() {
  // Given
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])

  // When
  const actual = {
    actionReferences,
    checkoutRef: workflow.includes("ref: ${{ github.event.release.tag_name }}"),
    checkoutPersistsCredentials: !workflow.includes("persist-credentials: false"),
    releaseTagEnvironment: workflow.includes("RELEASE_TAG: ${{ github.event.release.tag_name }}"),
    tagVerifier: workflow.includes("run: node scripts/verify-release-tag.mjs"),
    nodeVersion: workflow.includes("node-version: 22.23.2"),
    pnpmVersion: workflow.includes("version: 10.34.5"),
    npmVersion: workflow.includes("npm install --global npm@12.0.2"),
  }

  // Then
  assert.deepEqual(actual, {
    actionReferences: [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    ],
    checkoutRef: true,
    checkoutPersistsCredentials: false,
    releaseTagEnvironment: true,
    tagVerifier: true,
    nodeVersion: true,
    pnpmVersion: true,
    npmVersion: true,
  })
}

function shouldAcceptReleaseTagWhenPackageVersionMatches() {
  // Given
  const releaseTag = `v${packageJson.version}`

  // When
  const result = runReleaseTagVerifier(releaseTag)

  // Then
  assert.deepEqual(result, {
    status: 0,
    stdout: `PASS: release tag ${releaseTag} matches package version.\n`,
    stderr: "",
  })
}

function shouldRejectReleaseTagWhenPackageVersionDoesNotMatch() {
  // Given
  const releaseTag = "v999.999.999"

  // When
  const result = runReleaseTagVerifier(releaseTag)

  // Then
  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: `Release tag ${releaseTag} does not match package version v${packageJson.version}.\n`,
  })
}

function shouldUseExplicitGatesAndOidcWhenPackageIsPublished() {
  // Given
  const permissions = workflow.match(/^permissions:\n([\s\S]*?)\n\nconcurrency:/m)?.[1].trim()

  // When
  const actual = {
    permissions,
    installsFrozenDependencies: workflow.includes("pnpm install --frozen-lockfile"),
    runsRepositoryCheck: workflow.includes("pnpm run check"),
    runsSecurityCheck: workflow.includes("pnpm run security:check"),
    verifiesDistribution: workflow.includes("git diff --exit-code -- dist"),
    publishCommand: workflow.includes("npm publish --ignore-scripts --access public"),
    containsNpmSecret: /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./.test(workflow),
  }

  // Then
  assert.deepEqual(actual, {
    permissions: "contents: read\n  id-token: write",
    installsFrozenDependencies: true,
    runsRepositoryCheck: true,
    runsSecurityCheck: true,
    verifiesDistribution: true,
    publishCommand: true,
    containsNpmSecret: false,
  })
}

function runReleaseTagVerifier(releaseTag) {
  const result = spawnSync(process.execPath, [fileURLToPath(RELEASE_TAG_VERIFIER)], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: releaseTag,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

shouldRunOnlyForPublishedStableReleasesWhenPublishWorkflowIsTriggered()
shouldUseExactToolchainAndReleaseTagWhenPackageIsPrepared()
shouldAcceptReleaseTagWhenPackageVersionMatches()
shouldRejectReleaseTagWhenPackageVersionDoesNotMatch()
shouldUseExplicitGatesAndOidcWhenPackageIsPublished()
process.stdout.write("PASS: 5 npm publish workflow contracts.\n")
