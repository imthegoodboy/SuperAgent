# AGENTS.md

Guidance for coding agents (Claude Code, Codex, OpenCode, Cursor, …) working **on this repository**.

## What this is

SuperAgent turns a coding agent (Claude Code, Codex, OpenCode, Cursor) into a Super-agent. A skill
teaches the user's agent to act as the **Router** through the `superagent` CLI; the router dispatches
**Workers**: headless runs of Claude Code, Codex, OpenCode or Cursor Agent, each in its own git worktree.
A local background service keeps state, collects GitHub and Telegram events, and runs its own router
whenever no agent session is attached. It is a harness manager, not a harness, and it has no UI: its
users are agents. Everything runs on the user's machine; there are no accounts and no servers. Read
`docs/ARCHITECTURE.md` before changing core behaviour.

## Layout

| Path | What lives there |
|---|---|
| `src/cli.ts`, `src/cli/` | The `superagent` CLI (the agents' interface) and its HTTP client |
| `src/daemon/` | Daemon entry, `App` wiring, HTTP/SSE server, watchdog, OS helpers |
| `src/router/` | Router lease, background router loop and prompt, actions, Inline & Spill rendering, Chain of Recall, graph |
| `src/workers/` | Worker lifecycle, worktrees, worker prompts and report parsing |
| `src/triggers/` | Fast-path policy (`policy.ts`) and ingestion/pass-through (`ingest.ts`) |
| `src/channels/` | GitHub poller, Telegram, outbound replies |
| `src/agents/` | Adapters for each coding-agent CLI, process spawning, mock agent |
| `src/core/` | Config, SQLite store, paths, small utilities |
| `skill/superagent/` | The skill that makes an agent the router; installed into every agent on `npm i -g` |
| `scripts/postinstall.mjs` | Installs the skill after a global npm install |
| `test/` | `node:test` suites; `e2e.test.mjs` runs a real daemon and the CLI with the mock agent |

## Commands

```sh
npm install          # also builds (prepare)
npm run build        # tsc -> dist/
npm run typecheck
npm test             # build + unit + end-to-end tests (no LLM calls)
node dist/cli.js start --foreground   # run the daemon in this terminal
SUPERAGENT_HOME=/tmp/sa SUPERAGENT_MOCK=1 node dist/cli.js __daemon   # isolated dev daemon with the mock agent
```

When you run the CLI from a checkout, set `SUPERAGENT_SKIP_INTEGRATIONS=1` so it doesn't install that
checkout's skill into your own agents, and `SUPERAGENT_SKIP_AUTOSTART=1` so it never changes start-at-login.

## Rules

- Node ≥ 22.13, ESM, TypeScript strict. No runtime dependencies: use Node built-ins (`node:sqlite`,
  `node:http`, `fetch`). Ask before adding a dependency.
- Never spawn agent CLIs through a shell. Use `resolveCommand`/`startProcess` in `src/agents/process.ts`;
  they unwrap Windows `.cmd` shims so multi-line prompts survive.
- Every new agent CLI gets an adapter in `src/agents/adapters.ts` plus a parser test in `test/unit.test.mjs`.
- Every router capability is an action type in `src/router/router.ts` (schema, background prompt,
  `execute`), a CLI command in `src/cli/commands.ts`, and a line in the skill. Keep the background router
  tool-free, and keep the skill telling the attached agent never to do task work itself.
- The skill is the product's interface: keep it short, accurate, and in sync with `superagent help`
  (`test/skill.test.mjs` checks that every command it mentions exists).
- The HTTP API is local-only and token-protected; keep the Host and Origin checks in `src/daemon/server.ts`.
- CLI output is read by models: plain, dense text with IDs (`W#3`, `TH#8`, `T#42`); `--json` on every command.
- Add or update tests with every behaviour change; `npm test` must pass on Windows, macOS and Linux.
- Commit messages: imperative, present tense ("Add Telegram topics support").
