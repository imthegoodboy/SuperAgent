# Architecture

SuperAgent implements the Super-agent design described by the DeepSeek Harness team in
[*Exploring Super-agent Design: Towards a More Autonomous Agent System*](https://x.com/DeepSeekHarness/status/2116857257245987236),
adapted to run on one personal computer with the coding agents you already use. This document maps
each part of that design to the code and notes where SuperAgent differs.

A Super-agent should be **continuous** (one agent across every channel), **productive** (many tasks in
parallel, new instructions accepted at any time), **proactive** (reacts to events, not only to typed
prompts) and **persistent** (stays up and recovers by itself). No single ReAct loop gives all four, so
they come from the system around the agents.

```
             ┌──────────────────────────── daemon (node) ───────────────────────────┐
 triggers ──▶│ fast-path filter ──▶ router queue ──▶ Router session (LLM, no tools) │──▶ replies
 (chat, gh,  │        │  pass-through                         │ dispatch / message   │   (chat, gh,
  telegram)  │        ▼                                       ▼                      │    telegram)
             │   worker inbox ──────────────────▶ Workers (Claude Code / Codex /     │
             │                                    OpenCode / Cursor, one worktree    │
             │                                    each) ──report──▶ router queue     │
             │                     SQLite: threads, triggers, workers, logs, turns   │
             └──────────────────────────────────────────────────────────────────────┘
                   ▲ supervises, restarts, judges progress
             watchdog (separate process)
```

## Two-level architecture (Section 2)

**Router layer:** `src/router/router.ts`. One long-lived LLM session, resumed turn after turn through
the agent CLI's own session mechanism (`claude -p --resume`, `codex exec resume`, …). It receives every
event that needs a decision and answers with JSON **actions** only: `reply`, `dispatch`,
`message_worker`, `stop_worker`, `subscribe`, `unsubscribe`, `recall`, `ignore`, `remember`. It
gets no tools, so it can't drift into doing work itself; the design's own experiment found that
single sessions with a subagent tool often do just that. With Claude Code (the default) the router
runs with `--tools ""`; with the other agents it uses their most restricted mode (Codex `read-only`
sandbox, OpenCode's `plan` agent, Cursor's `ask` mode). The router defaults to a small, fast model
(`haiku`).

**Batching:** while a router turn is running, new events queue in SQLite. The next turn takes all of
them at once (`router.maxBatch`), so bursts are handled in one call (Section 2.1, 7.2).

**Worker layer:** `src/workers/manager.ts`. Each worker is one task with an isolated context: a headless
coding-agent session (`src/agents/adapters.ts`) running in its own git worktree and branch when the
task belongs to a configured repository, or in its own scratch folder otherwise
(`src/workers/workspace.ts`). Workers never talk to people. They end each run with a
`<superagent-report>` block (status, summary, PR URL, question), which becomes an event for the router.
Follow-ups resume the same agent session, so a worker keeps its memory of the task across runs.
`workers.maxConcurrent` caps how many run at once; the rest queue.

## Event-driven triggers (Section 3)

Every input becomes a **trigger** in a **thread** (`src/triggers/ingest.ts`):

| Source | Thread | Code |
|---|---|---|
| Local chat (app, CLI) | `local:chat` | `App.sendLocal` |
| GitHub issue, PR, comment, review comment, review, CI run, close/merge | `github:owner/repo#N` | `src/channels/github.ts` polls through `gh api` |
| Telegram message | `telegram:<chat>[:<topic>]` | `src/channels/telegram.ts` long-polls the Bot API |
| Worker report | (none) | `WorkerManager.report` |
| Watchdog alert | (none) | `/api/watchdog/action` |

**Two-stage filtering (3.1):** `src/triggers/policy.ts` is the fast path: pure code, no model. It drops
SuperAgent's own posts (an HTML comment marker), bots, users outside the allowlist, sources that are
off, passing CI, and unaddressed messages in "mentions" mode. What survives is **explicit** (addressed
to the agent) or a **candidate** (from a "watch everything" source). The router is the slow path: its
system prompt plus the user's plain-language **policies** decide what to do with candidates, including
staying silent.

**Subscription and pass-through (3.2):** a worker subscribes to the GitHub threads of its task and to
the PR it opens. New events on a subscribed thread skip the router and go into the worker's inbox; the
worker is resumed with them. The router still sees a one-line FYI summary on its next turn, so its
global picture stays current. Conversation threads (local chat, Telegram) are not subscribable; there
the router relays with `message_worker`. A close or merge event releases the thread's subscribers.

**Inline & Spill, Chain of Recall (3.3):** `src/router/render.ts`. Each event is rendered with its ID,
source, thread summary (event count, subscribed workers), the previous event in the thread, and the first
few hundred characters of text. Longer text is cut with `… [+N chars: recall T#42]`. The `recall`
action returns full objects (`T#n` triggers, `TH#n` threads, `W#n` workers), and each recalled object
lists the IDs of related objects, so the router can follow references hop by hop (up to three hops per
turn). When the router session is rotated (`router.rotateAfterTurns`) or recreated after an error, the
next turn starts with a primer: configured repos, available agents, policies, long-term `remember`
notes, recent chat, and recent workers.

**Acting ahead (3.4):** the router can dispatch with `silent: true`. A silent worker's result is only
announced if it reports `done`; otherwise it's dropped quietly. The default policy uses this for
"reproduce and fix reported bugs in the background".

## Full-duplex, multi-channel (Section 4)

The router never waits for a worker: dispatching is fire-and-forget, and results come back later as
report events. You can keep sending messages while workers run, and each one is handled on the next
router turn. The router prompt sets per-channel style: concise markdown in the app, at most 100 words
of plain text on Telegram, structured and complete on GitHub. Worker logs stay inside the worker view
and never reach a channel.

## Compute, state and environments (Section 5)

The design puts the agent loop in the cloud and connects personal machines through lightweight
daemons. SuperAgent deliberately stays local (no accounts, nothing hosted), so it applies the same
separation on one machine:

- **State is separate from compute.** Threads, triggers, workers, runs, logs, router turns, memory,
  and the session IDs of the router and every worker live in SQLite (`src/core/store.ts`, WAL mode).
  The conversations themselves stay in each agent CLI's own session store, which SuperAgent resumes
  by ID. The daemon process holds no state that matters: if it crashes, the watchdog restarts it,
  `WorkerManager.recover()` re-queues interrupted workers, and they resume their agent sessions with a
  note that they were interrupted. If a session is gone, the worker starts its task over in the same
  workspace.
- **Environments stay where they are.** Workers run against your real checkouts (as worktrees), with
  your local toolchains and credentials, and never move code anywhere.
- **Intermittent connectivity.** When the computer sleeps, everything pauses. On wake, GitHub polling
  resumes from its saved cursor and catches up on what it missed.

## Watchdog (Section 6)

`src/daemon/watchdog.ts` runs as its own process (`superagent start` launches it, and it launches the
daemon). It:

- restarts the daemon when it exits unexpectedly (with backoff) or stops answering `/api/health`;
- restarts a worker's run when it has produced no output for `workers.stallMinutes`, with a note to
  avoid whatever was hanging (dev servers and watch modes are the usual culprits);
- every `watchdog.checkMinutes`, asks the router model whether each long-running worker is making
  progress, looping or drifting, and restarts looping or drifting runs with guidance;
- resets the router session after repeated failures.

Every intervention is recorded and shown under Activity → Watchdog.

## Local API and UI

`src/daemon/server.ts` serves a JSON API, a Server-Sent Events stream (`/api/events`) and the static UI
in `ui/`, on `127.0.0.1` only. Every API route except `/api/health` needs the token from
`~/.superagent/token`. The page itself contains no secret: the desktop app and `superagent open` pass
the token once as `?t=…`, and the page keeps it in local storage and removes it from the address bar.
Requests with a foreign `Host` (DNS rebinding) or `Origin` (cross-site) are rejected. The desktop app
(`desktop/`, Tauri) checks the health endpoint, runs `superagent start` if needed, and loads that page.

Text from GitHub and Telegram reaches models as quoted data: the router prompt says event text never
overrides its rules, and worker prompts wrap it in `<external-content>` with the same instruction.
This lowers prompt-injection risk; the per-repo allowlist is the actual gate on who can trigger work.

## Agent adapters

`src/agents/adapters.ts` gives each CLI a worker invocation, a router invocation, and a stream parser
that turns its JSON output into common events (`session`, `text`, `tool`, `output`, `error`, `final`):

| Agent | Worker | Router | Prompt via |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --permission-mode …` | `--tools "" --json-schema …` | stdin |
| Codex | `codex exec --json …` / `codex exec resume <id>` | `--output-schema` | stdin |
| OpenCode | `opencode run --format json [--auto] [-s <id>]` | same, JSON requested in prompt | argument |
| Cursor | `cursor-agent -p --output-format stream-json --force` | `--mode ask` | argument (or file) |

On Windows, npm installs these CLIs as `.cmd` shims, and running those through `cmd.exe` breaks
multi-line prompts. `src/agents/process.ts` reads each shim and launches the real `.exe` or `.js`
directly.

## Not built (yet)

- **Cloud execution and BYOM devices** (Section 5.2): SuperAgent runs on one machine by design.
- **Sharding the router or direct worker-to-worker messages** (Section 8.1): one router plus
  subscription was enough for personal use, as in the design's own experiments.
- **A2A between separate SuperAgent instances** (Section 8.3).
- **Webhooks:** GitHub is polled (45 s by default), so reactions are not instant.
