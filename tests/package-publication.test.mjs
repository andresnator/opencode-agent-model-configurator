import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"

const ROOT = new URL("../", import.meta.url)
const PACKAGE_NAME = "opencode-models-presets"
const NPM_REGISTRY = "https://registry.npmjs.org/"
const OPENCODE_RANGE = ">=1.17.15 <2"
const NPM_LIFECYCLE_SCRIPTS = [
  "dependencies",
  "install",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "postversion",
  "preinstall",
  "prepack",
  "prepare",
  "preprepare",
  "prepublish",
  "prepublishOnly",
  "preversion",
  "publish",
  "version",
]
const EXPECTED_PACKAGE_FILES = [
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "dist/domain.d.ts",
  "dist/hot-apply.d.ts",
  "dist/options.d.ts",
  "dist/persistence.d.ts",
  "dist/presets.d.ts",
  "dist/tui.d.ts",
  "dist/tui.js",
  "dist/wizard.d.ts",
  "examples/profiles/team.example.json",
  "package.json",
  "schemas/profile.schema.json",
]

const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))

function shouldExposeOnlyTheTuiPluginWhenPackageIsPublished() {
  // Given
  const lifecycleScripts = NPM_LIFECYCLE_SCRIPTS.filter((script) => packageJson.scripts?.[script] !== undefined)

  // When
  const actual = {
    name: packageJson.name,
    private: packageJson.private,
    publishConfig: packageJson.publishConfig,
    exports: packageJson.exports,
    opencodeEngine: packageJson.engines?.opencode,
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
    peerDependencies: packageJson.peerDependencies,
    bundledDependencies: packageJson.bundledDependencies ?? packageJson.bundleDependencies,
    bin: packageJson.bin,
    lifecycleScripts,
  }

  // Then
  assert.deepEqual(actual, {
    name: PACKAGE_NAME,
    private: undefined,
    publishConfig: {
      access: "public",
      registry: NPM_REGISTRY,
    },
    exports: {
      ".": {
        types: "./dist/tui.d.ts",
        import: "./dist/tui.js",
      },
      "./tui": {
        types: "./dist/tui.d.ts",
        import: "./dist/tui.js",
      },
    },
    opencodeEngine: OPENCODE_RANGE,
    dependencies: undefined,
    optionalDependencies: undefined,
    peerDependencies: undefined,
    bundledDependencies: undefined,
    bin: undefined,
    lifecycleScripts: [],
  })
}

function shouldContainOnlyTheExpectedFilesWhenPackageIsPacked() {
  // Given
  const expected = {
    name: PACKAGE_NAME,
    version: packageJson.version,
    filename: `${PACKAGE_NAME}-${packageJson.version}.tgz`,
    files: [...EXPECTED_PACKAGE_FILES].sort(),
  }

  // When
  const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const report = JSON.parse(packed.stdout)
  const actual = {
    name: report.name,
    version: report.version,
    filename: report.filename,
    files: report.files.map((entry) => entry.path).sort(),
  }

  // Then
  assert.deepEqual(actual, expected)
}

shouldExposeOnlyTheTuiPluginWhenPackageIsPublished()
shouldContainOnlyTheExpectedFilesWhenPackageIsPacked()
process.stdout.write("PASS: 2 npm publication contracts.\n")
