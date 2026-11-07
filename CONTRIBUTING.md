# Contributing

Thanks for helping. SuperAgent is small on purpose: Node built-ins only, no UI (its users are coding
agents, through the skill and the CLI), and tests that run without any LLM.

## Setup

```sh
git clone https://github.com/imthegoodboy/SuperAgent && cd SuperAgent
npm install        # installs TypeScript and builds dist/
npm test
```

Run an isolated daemon with the fake agent while you work, so nothing touches your real data:

```sh
# macOS / Linux
SUPERAGENT_HOME=/tmp/sa SUPERAGENT_MOCK=1 node dist/cli.js __daemon
# Windows PowerShell
$env:SUPERAGENT_HOME="$env:TEMP\sa"; $env:SUPERAGENT_MOCK="1"; node dist/cli.js __daemon
```

Set `"router": {"agent": "mock"}` and `"workers": {"defaultAgent": "mock"}` in that folder's
`config.json` to drive the whole pipeline with the mock agent (`src/agents/mock-agent.ts`). Then act as
the router yourself, with the same environment:

```sh
SUPERAGENT_HOME=/tmp/sa SUPERAGENT_SKIP_INTEGRATIONS=1 node dist/cli.js router attach
SUPERAGENT_HOME=/tmp/sa SUPERAGENT_SKIP_INTEGRATIONS=1 node dist/cli.js dispatch "write a file"
SUPERAGENT_HOME=/tmp/sa SUPERAGENT_SKIP_INTEGRATIONS=1 node dist/cli.js events --wait 30
```

`SUPERAGENT_SKIP_INTEGRATIONS=1` keeps a development checkout from installing its skill into your real
agents.

## Pull requests

- One topic per PR, with a description of what changed and how you tested it.
- Add or update tests: parsers and policies in `test/unit.test.mjs`, behaviour in `test/e2e.test.mjs`.
- `npm run typecheck` and `npm test` must pass. CI runs them on Windows, macOS and Linux.
- Read [AGENTS.md](AGENTS.md) for layout and conventions, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
  before changing the router, triggers or workers.

## Adding a coding agent

1. Add an adapter in `src/agents/adapters.ts`: worker args, router args, and a stream parser.
2. Add its id to `AGENT_IDS` in `src/core/config.ts`.
3. Add its global skills folder to `targets()` in `src/daemon/system.ts`, so the skill is installed for it.
4. Add parser tests with real output lines from the CLI.

## Releasing

Bump `version` in `package.json`, then tag `vX.Y.Z` and create a GitHub release. The skill reaches
users' agents on their next `npm install -g` (or their next `superagent` command).
