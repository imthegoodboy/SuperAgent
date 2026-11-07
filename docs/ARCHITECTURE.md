# Architecture

SuperAgent implements the Super-agent design described by the DeepSeek Harness team in
[*Exploring Super-agent Design: Towards a More Autonomous Agent System*](https://x.com/DeepSeekHarness/status/2116857257245987236),
adapted to run on one personal computer with the coding agents you already use. Like the article's own
prototype, it is a plugin for existing harnesses, not a harness: a skill teaches Claude Code, Codex,
OpenCode or Cursor to act as the router, and a background service provides everything a single session
cannot. This document maps each part of the design to the code and notes where SuperAgent differs.

A Super-agent should be **continuous** (one agent across every channel), **productive** (many tasks in
parallel, new instructions accepted at any time), **proactive** (reacts to events, not only to typed
prompts) and **persistent** (stays up and recovers by itself). No single ReAct loop gives all four, so
they come from the system around the agents.

```
   you ⇄ your agent (Claude Code / Codex / …) with the superagent skill = the ROUTER
                 │ superagent events · dispatch · tell · reply · recall …  (CLI → local HTTP API)
             ┌───▼────────────────────────── daemon (node) ───────────────────────────┐
 triggers ──▶│ fast-path filter ──▶ router queue ──▶ attached agent, or the background│──▶ replies
 (github,    │        │  pass-through                 router (LLM, no tools) when    │   (github,
  telegram,  │        ▼                               no agent is attached           │    telegram)
  reports)   │   worker inbox ──────────────────▶ Workers (Claude Code / Codex /     │
             │                                    OpenCode / Cursor, one worktree    │
             │                                    each) ──report──▶ router queue     │
             │                     SQLite: threads, triggers, workers, logs, turns   │
             └──────────────────────────────────────────────────────────────────────┘
                   ▲ supervises, restarts, judges progress
             watchdog (separate process)
```

## Two-level architecture (Section 2)

**Router layer:** `src/router/router.ts`. Exactly one router decides at any moment. Every decision is
one of a fixed set of **actions**: `reply`, `dispatch`, `message_worker`, `stop_worker`, `subscribe`,
`unsubscribe`, `recall`, `ignore`, `remember`. The router can take two forms, and both share all
state:

- **An attached agent session.** The user's own Claude Code, Codex, OpenCode or Cursor loads the skill
  (`skill/superagent/SKILL.md`) and runs `superagent router attach`. It then reads `superagent events`
  and acts with CLI commands that map one-to-one onto the actions (`dispatch`, `tell`, `cancel`,
  `reply`, `ignore`, `recall`, `follow`, `remember`). The skill forbids it from doing task work itself:
  the design's own experiment found that single sessions with a subagent tool often do just that.
  It holds a **lease** (`router.lease` in the kv table) that `attach`, `events` and every action renew.
  It expires after `router.leaseMinutes` (15) of quiet or on `router detach`. A second session can't
  attach while the lease is held unless it passes `--take`. Events are acknowledged when `events`
  delivers them. If the lease then expires without any action on that last batch, its events from
  people (not worker reports) go back to the queue for the background router. The lease belongs to the
  session that holds it when its harness exposes an identity: the CLI sends `CLAUDE_CODE_SESSION_ID`
  (or `SUPERAGENT_SESSION`, which any harness can set). Then the same session can attach again at will,
  another session gets a 409 until it passes `--take`, and the replaced session's next command is
  refused. A detach or take-over also ends a waiting `events --wait` call at once. Sessions without an
  identity can't be told apart, so for them `--take` is advisory. What the background router did after
  the lease ended is kept for the next `attach` or `events`, whichever comes first.
- **The background router**, used whenever no lease is held: one long-lived LLM session, resumed turn
  after turn through the agent CLI's own session mechanism (`claude -p --resume`,
  `codex exec resume`, …), answering with JSON actions only. It gets no tools: with Claude Code (the
  default) it runs with `--tools ""`; with the other agents it uses their most restricted mode (Codex
  `read-only` sandbox, OpenCode's `plan` agent, Cursor's `ask` mode). It defaults to a small, fast
  model (`haiku`). When an agent attaches again, it gets a "while you were away" summary of what the
  background router said and did.

**Batching:** while a router turn is running, new events queue in SQLite. The next turn (or the next
`superagent events`) takes all of them at once (`router.maxBatch`), so bursts are handled in one call
(Section 2.1, 7.2).

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
| GitHub issue, PR, comment, review comment, review, CI run, close/merge | `github:owner/repo#N` | `src/channels/github.ts` polls through `gh api` |
| Telegram message | `telegram:<chat>[:<topic>]` | `src/channels/telegram.ts` long-polls the Bot API |
| Worker report | (none; reports name their reply thread, by default the local thread with the user) | `WorkerManager.report` |
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
global picture stays current. Conversation threads (the local thread, Telegram) are not subscribable;
there the router relays with `message_worker`. A close or merge event releases the thread's subscribers.

**Inline & Spill, Chain of Recall (3.3):** `src/router/render.ts`. Each event is rendered with its ID,
source, thread summary (event count, subscribed workers), the previous event in the thread, and the first
few hundred characters of text. Longer text is cut with `… [+N chars: recall T#42]`. The `recall`
action returns full objects (`T#n` triggers, `TH#n` threads, `W#n` workers), and each recalled object
lists the IDs of related objects, so the router can follow references hop by hop (up to three hops per
turn). When the router session is rotated (`router.rotateAfterTurns`) or recreated after an error, the
next turn starts with a primer: configured repos, available agents, policies, long-term `remember`
notes, recent messages, and recent workers. `superagent router attach` prints the same context for an
attached agent.

**Acting ahead (3.4):** the router can dispatch with `silent: true`. A silent worker's result is only
announced if it reports `done`. Otherwise its report is dropped by the fast path in code, so neither
router is asked to announce it. It is still on the worker and in `superagent activity`. The default policy uses this for
"reproduce and fix reported bugs in the background".

## Full-duplex, multi-channel (Section 4)

The router never waits for a worker: `dispatch` is the article's asynchronous `start()`. It returns at
once, and results come back later as report events. `cancel` is its `stop()`. The user keeps talking to
their agent while workers run. `superagent events --wait N` lets an idle agent wait for the next event.
The router prompt and the skill set per-channel style: at most 100 words of plain text on Telegram,
structured and complete on GitHub. Worker logs stay with the worker (`superagent logs`) and never reach
a channel.

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

## The agent interface: skill, CLI, local API

SuperAgent has no UI of its own. Agents use it through:

- **The skill** (`skill/superagent/SKILL.md`): when to use SuperAgent, the router loop, how to handle each
  kind of event, how to brief a worker, and the rules. A global npm install copies it into every agent's
  global skills folder (`scripts/postinstall.mjs`). Every CLI command checks again (`ensureIntegrations`
  in `src/daemon/system.ts`), so agents installed later get it too, and an updated skill reaches the
  folders that have it. `superagent uninstall` removes it.
- **The CLI** (`src/cli/commands.ts`): plain text for the agent to read, or JSON with `--json`. Text
  arguments given as `-` come from stdin. Router commands start the service on demand.
- **The local API** (`src/daemon/server.ts`): a JSON API and a Server-Sent Events stream (`/api/events`)
  on `127.0.0.1` only. Every route except `/api/health` needs the token from `~/.superagent/token`.
  Requests with a foreign `Host` (DNS rebinding) or `Origin` (cross-site) are rejected. The router's
  routes are `router/attach`, `router/detach`, `router/events?wait=`, `router/actions`, `recall` and
  `graph`.

Workers run with `SUPERAGENT_WORKER=W#n` in their environment, and the router commands refuse to run
there, so a worker that loads the skill can't act as the router or start more workers.

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

- **Pushing events into an open session.** An attached agent sees new events when it runs
  `superagent events` (after each user message, or in a `--wait` loop). Agent hooks could insert them
  automatically on every turn.

- **Cloud execution and BYOM devices** (Section 5.2): SuperAgent runs on one machine by design.
- **Sharding the router or direct worker-to-worker messages** (Section 8.1): one router plus
  subscription was enough for personal use, as in the design's own experiments.
- **A2A between separate SuperAgent instances** (Section 8.3).
- **Webhooks:** GitHub is polled (45 s by default), so reactions are not instant.
