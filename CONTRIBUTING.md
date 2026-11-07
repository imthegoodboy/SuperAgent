# Contributing

Thanks for helping. SuperAgent is small on purpose: Node built-ins only, no UI (its users are coding
agents, through the skill and the CLI), and tests that run without any LLM.

## Setup

```sh
git clone https://github.com/imthegoodboy/SuperAgent && cd SuperAgent
npm install        # installs TypeScript and builds dist/
npm test
```

Run an isolated daemon with the fake agent while you work, so nothing touches your real data. First
create the data folder with a `config.json` that uses the mock agent (`src/agents/mock-agent.ts`) and a
spare port, then start the daemon:

```sh
# macOS / Linux
mkdir -p /tmp/sa && echo '{"port":7979,"router":{"agent":"mock"},"workers":{"defaultAgent":"mock"}}' > /tmp/sa/config.json
export SUPERAGENT_HOME=/tmp/sa SUPERAGENT_SKIP_INTEGRATIONS=1 SUPERAGENT_SKIP_AUTOSTART=1
SUPERAGENT_MOCK=1 node dist/cli.js __daemon
```

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$env:TEMP\sa" | Out-Null
'{"port":7979,"router":{"agent":"mock"},"workers":{"defaultAgent":"mock"}}' | Set-Content "$env:TEMP\sa\config.json"
$env:SUPERAGENT_HOME="$env:TEMP\sa"; $env:SUPERAGENT_SKIP_INTEGRATIONS="1"; $env:SUPERAGENT_SKIP_AUTOSTART="1"
$env:SUPERAGENT_MOCK="1"; node dist/cli.js __daemon
```

Then, in another terminal with the same environment variables, act as the router yourself:

```sh
node dist/cli.js router attach
node dist/cli.js dispatch "write a file"
node dist/cli.js events --wait 30
```

`SUPERAGENT_SKIP_INTEGRATIONS=1` keeps a development checkout from installing its skill into your real
agents, and `SUPERAGENT_SKIP_AUTOSTART=1` keeps it from touching start-at-login.

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

1. Bump `version` in `package.json` on main.
2. Publish a GitHub release tagged `vX.Y.Z`.

The **Publish to npm** workflow checks that the tag matches `package.json`, runs the tests, and publishes
`@imthegoodboy/superagent` with provenance. It needs the repository secret `NPM_TOKEN` (an npm automation
token). The updated skill reaches users' agents on their next `npm install -g`, or on their next
`superagent` command.
