# Tenon

A Codex-style desktop client for the [pi](https://github.com/earendil-works/pi) coding agent.

- **Three-pane UI**: sessions tree / streaming conversation / review · files · trajectory tabs
- **Multi-vendor models**: every pi-ai provider, API keys managed in-app, model lists auto-fetched
- **Sandboxed execution** (Seatbelt / bubblewrap) with approval escalation
- **Built-in codegraph** (tree-sitter → SQLite) exposed as agent tools
- **Everything replayable**: pi's tree-shaped JSONL sessions power a DeepSeek-harness-style trajectory viewer

## Layout

```
apps/desktop            Electron app (electron-vite, React)
packages/protocol       pi RPC wire types + typed client + main↔renderer IPC contract
packages/pi-extensions  Extensions loaded inside the pi process (codegraph / sandbox / review)
packages/codegraph-core tree-sitter WASM indexer + SQLite storage
packages/trajectory     session JSONL → trajectory view model
packages/ui             shared React components (streaming markdown, diff cards, timeline)
```

## Development

```bash
pnpm install
pnpm dev        # run the desktop app
pnpm typecheck
```

pi ships as a bundled sidecar binary in release builds; during development the app spawns
the `pi` binary from `node_modules` (`@earendil-works/pi-coding-agent`).
