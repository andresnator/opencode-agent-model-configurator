import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const INSTALLER = path.join(ROOT, "scripts", "install.sh")

async function shouldUseTmpAsTheDefaultInstallLocation() {
  // Given
  const source = await readFile(INSTALLER, "utf8")

  // When
  const defaultAssignment = source.match(/^DEFAULT_INSTALL_DIR=(.+)$/m)?.[1]

  // Then
  assert.equal(defaultAssignment, '"/tmp/opencode-models-presets"')
}

async function shouldResolveLatestStableReleaseAndAllowExactReleaseWhenInstalling() {
  const scratch = await mkdtemp(path.join(tmpdir(), "models-presets-installer."))
  try {
    // Given
    const source = path.join(scratch, "source")
    const remote = path.join(scratch, "remote.git")
    const destination = path.join(scratch, "installed")
    const fakeBin = path.join(scratch, "bin")
    const opencodeArguments = path.join(scratch, "opencode-arguments")
    await createReleaseRepository(source, remote)
    await mkdir(fakeBin)
    const fakeOpencode = path.join(fakeBin, "opencode")
    await writeFile(fakeOpencode, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$MOCK_OPENCODE_ARGS"\n')
    await chmod(fakeOpencode, 0o755)
    const environment = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      MODELS_PRESETS_INSTALL_DIR: destination,
      MODELS_PRESETS_REPOSITORY_URL: remote,
      MOCK_OPENCODE_ARGS: opencodeArguments,
    }

    // When
    const latest = spawnSync("sh", [INSTALLER, "latest"], { encoding: "utf8", env: environment })

    // Then
    assert.equal(latest.status, 0, latest.stderr || latest.stdout)
    assert.match(latest.stdout, /Installed models-presets v0\.2\.0/)
    assert.equal(await readFile(path.join(destination, "version.txt"), "utf8"), "0.2.0\n")
    assert.deepEqual((await readFile(opencodeArguments, "utf8")).trim().split("\n"), [
      "plugin",
      destination,
      "--global",
      "--force",
    ])

    // When latest is installed again at the retained path
    const repeated = spawnSync("sh", [INSTALLER, "latest"], { encoding: "utf8", env: environment })

    // Then the same release is installed idempotently
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout)
    assert.equal(await readFile(path.join(destination, "version.txt"), "utf8"), "0.2.0\n")

    // When an exact version without the v prefix is requested in the retained checkout
    const exact = spawnSync("sh", [INSTALLER, "0.1.0"], { encoding: "utf8", env: environment })

    // Then
    assert.equal(exact.status, 0, exact.stderr || exact.stdout)
    assert.match(exact.stdout, /Installed models-presets v0\.1\.0/)
    assert.equal(await readFile(path.join(destination, "version.txt"), "utf8"), "0.1.0\n")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function createReleaseRepository(source, remote) {
  await mkdir(source)
  git(["init", "--quiet"], source)
  git(["config", "user.name", "Models Presets Test"], source)
  git(["config", "user.email", "models-presets@example.invalid"], source)
  for (const version of ["0.1.0", "0.2.0"]) {
    await writeFile(path.join(source, "version.txt"), `${version}\n`)
    git(["add", "version.txt"], source)
    git(["commit", "--quiet", "-m", `release ${version}`], source)
    git(["tag", `v${version}`], source)
  }
  // Higher non-stable tags must not displace the highest stable release.
  git(["tag", "v0.3.0-rc.1"], source)
  git(["tag", "v1"], source)
  execFileSync("git", ["clone", "--quiet", "--bare", source, remote])
}

function git(arguments_, cwd) {
  execFileSync("git", arguments_, { cwd })
}

await shouldUseTmpAsTheDefaultInstallLocation()
await shouldResolveLatestStableReleaseAndAllowExactReleaseWhenInstalling()
process.stdout.write("PASS: 2 installer contracts.\n")
