// OpenCode V2 resolves local CLI packages through a root tui entrypoint.
// Published packages resolve ./tui through package.json exports instead.
export { default } from "./dist/tui.js"
