import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { Host } from "@opencode/plugin/host"
import { pathToFileURL } from "node:url"

const root = new URL("../", import.meta.url)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const bundleUrl = new URL("dist/tui.js", root)
const bundle = await readFile(bundleUrl, "utf8")

assert.equal(packageJson.name, "opencode-models-presets")
assert.deepEqual(packageJson.dependencies, { "@opencode/plugin": "2.0.28" })
assert.equal(packageJson.exports?.["./tui"]?.import, "./dist/tui.js")
assert.equal(packageJson.engines?.opencode, ">=2.0.28 <3")
assert.ok(!bundle.includes("agents-orchestrator"), "bundle still contains source-harness coupling")

const bareImports = [...bundle.matchAll(/\b(?:from\s+|import\s*\()(["'])([^"']+)\1/g)].map((match) => match[2])
assert.deepEqual(
  bareImports.filter((specifier) => !specifier.startsWith("node:")),
  ["@opencode/plugin/tui"],
  "bundle contains an unexpected host runtime import",
)

const plugin = await import(pathToFileURL(bundleUrl.pathname).href)
assert.equal(plugin.default?.id, "opencode-models-presets")
assert.equal(typeof plugin.default?.setup, "function")
assert.equal("server" in plugin.default, false, "TUI entry must not also export a server plugin")

const packageEntrypoint = Host.resolve({ name: packageJson.name, directory: root.pathname }).tui
assert.equal(packageEntrypoint, bundleUrl.href, "published V2 CLI export does not resolve")

const localEntrypoint = Host.resolve({ directory: root.pathname }).tui
assert.equal(localEntrypoint, new URL("tui.ts", root).href, "local checkout has no V2 TUI entrypoint")
const localPlugin = await import(localEntrypoint)
assert.equal(localPlugin.default?.id, plugin.default.id)

const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
})
assert.equal(packed.status, 0, packed.stderr || packed.stdout)
const report = JSON.parse(packed.stdout)
const files = new Set(report.files.map((entry) => entry.path))
for (const required of ["dist/tui.js", "dist/tui.d.ts", "README.md", "LICENSE", "NOTICE.md", "schemas/profile.schema.json"]) {
  assert.ok(files.has(required), `package is missing ${required}`)
}
for (const forbidden of ["src/tui.tsx", "tests/contracts.ts", ".github/workflows/ci.yml"]) {
  assert.ok(!files.has(forbidden), `package unexpectedly contains ${forbidden}`)
}

process.stdout.write(`PASS: package contains ${files.size} files and the V2 CLI entrypoint.\n`)
