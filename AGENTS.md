# AGENTS.md

Guidance for coding agents (Claude Code, Codex, OpenCode, Cursor, …) working **on this repository**.

## What this is

SuperAgent is a local, always-on orchestrator. One long-lived **Router** session talks to people
(desktop app, CLI, GitHub, Telegram) and dispatches **Workers**: headless runs of Claude Code, Codex,
OpenCode or Cursor Agent, each in its own git worktree. Everything runs on the user's machine; there
are no accounts and no servers. Read `docs/ARCHITECTURE.md` before changing core behaviour.

## Layout

| Path | What lives there |
|---|---|
| `src/cli.ts`, `src/cli/` | The `superagent` CLI and its HTTP client |
| `src/daemon/` | Daemon entry, `App` wiring, HTTP/SSE server, watchdog, OS helpers |
| `src/router/` | Router loop, system prompt, Inline & Spill rendering, Chain of Recall |
| `src/workers/` | Worker lifecycle, worktrees, worker prompts and report parsing |
| `src/triggers/` | Fast-path policy (`policy.ts`) and ingestion/pass-through (`ingest.ts`) |
| `src/channels/` | GitHub poller, Telegram, outbound replies |
| `src/agents/` | Adapters for each coding-agent CLI, process spawning, mock agent |
| `src/core/` | Config, SQLite store, paths, small utilities |
| `ui/` | The web UI (plain HTML/CSS/JS, no build step), served by the daemon |
| `desktop/` | Tauri shell that starts the daemon and shows the UI |
| `skill/superagent/` | The Claude Code / Codex skill |
| `test/` | `node:test` suites; `e2e.test.mjs` runs a real daemon with the mock agent |

## Commands

```sh
npm install          # also builds (prepare)
npm run build        # tsc -> dist/
npm run typecheck
npm test             # build + unit + end-to-end tests (no LLM calls)
node dist/cli.js start --foreground   # run the daemon in this terminal
SUPERAGENT_HOME=/tmp/sa SUPERAGENT_MOCK=1 node dist/cli.js __daemon   # isolated dev daemon with the mock agent
```

Desktop: `cd desktop && npm install && npm run dev` (needs Rust and the Tauri prerequisites).

## Rules

- Node ≥ 22.13, ESM, TypeScript strict. No runtime dependencies: use Node built-ins (`node:sqlite`,
  `node:http`, `fetch`). Ask before adding a dependency.
- Never spawn agent CLIs through a shell. Use `resolveCommand`/`startProcess` in `src/agents/process.ts`;
  they unwrap Windows `.cmd` shims so multi-line prompts survive.
- Every new agent CLI gets an adapter in `src/agents/adapters.ts` plus a parser test in `test/unit.test.mjs`.
- Keep the Router tool-free: it only emits JSON actions. New router capabilities are new action types in
  `src/router/router.ts` (schema, prompt, `execute`) and a mock-agent case if the e2e test needs it.
- The HTTP API is local-only and token-protected; keep the Host and Origin checks in `src/daemon/server.ts`.
- UI stays dependency-free and simple: one accent colour, system font, light and dark themes.
- Add or update tests with every behaviour change; `npm test` must pass on Windows, macOS and Linux.
- Commit messages: imperative, present tense ("Add Telegram topics support").
