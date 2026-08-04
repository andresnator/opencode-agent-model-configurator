import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const root = new URL("../", import.meta.url)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const bundleUrl = new URL("dist/tui.js", root)
const bundle = await readFile(bundleUrl, "utf8")

assert.equal(packageJson.name, "opencode-agent-model-configurator")
assert.equal(packageJson.dependencies, undefined, "published package must not have runtime dependencies")
assert.equal(packageJson.exports?.["./tui"]?.import, "./dist/tui.js")
assert.equal(packageJson.engines?.opencode, ">=1.17.15 <2")
assert.ok(!bundle.includes("agents-orchestrator"), "bundle still contains source-harness coupling")

const bareImports = [...bundle.matchAll(/\b(?:from\s+|import\s*\()(["'])([^"']+)\1/g)].map((match) => match[2])
assert.deepEqual(
  bareImports.filter((specifier) => !specifier.startsWith("node:")),
  [],
  "bundle contains a non-Node runtime import",
)

const plugin = await import(pathToFileURL(bundleUrl.pathname).href)
assert.equal(plugin.default?.id, "andresnator.agent-model-configurator")
assert.equal(typeof plugin.default?.tui, "function")
assert.equal("server" in plugin.default, false, "TUI entry must not also export a server plugin")

const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root,
  encoding: "utf8",
})
assert.equal(packed.status, 0, packed.stderr || packed.stdout)
const report = JSON.parse(packed.stdout)[0]
const files = new Set(report.files.map((entry) => entry.path))
for (const required of ["dist/tui.js", "dist/tui.d.ts", "README.md", "LICENSE", "NOTICE.md", "schemas/profile.schema.json"]) {
  assert.ok(files.has(required), `package is missing ${required}`)
}
for (const forbidden of ["src/tui.tsx", "tests/contracts.ts", ".github/workflows/ci.yml"]) {
  assert.ok(!files.has(forbidden), `package unexpectedly contains ${forbidden}`)
}

process.stdout.write(`PASS: package contains ${files.size} files and no runtime dependencies.\n`)
