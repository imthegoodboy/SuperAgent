---
name: superagent
description: Hand work to SuperAgent, the always-on local orchestrator that runs Claude Code, Codex, OpenCode and Cursor workers in parallel, each in its own git worktree, and keeps going in the background. Use when the user says "superagent", wants something done in the background or in parallel, wants a task run with a specific agent ("have Codex do it", "use OpenCode for this"), asks what background tasks are doing, or wants a GitHub repo watched so issues and review comments get handled.
---

# SuperAgent

SuperAgent runs on this computer as a background service with its own CLI, `superagent`. It has one
long-lived **router** that remembers everything across chats and channels, and **workers**: headless
coding agents that each do one task in an isolated git worktree and open draft PRs when done.

Use it to delegate work that should run **in the background or in parallel** with what you are doing
here, or that should be done by a **different agent**. Do the work yourself when the user wants it
done right here, right now, in this session.

## Before you start

```bash
superagent status        # is it running? which agents are available?
superagent start         # start it if it is not running
```

If `superagent` is not found, tell the user to install it: `npm install -g github:imthegoodboy/SuperAgent`.

## Delegating

Prefer talking to the router: it keeps the global picture, picks the agent and repo, and follows up
on its own.

```bash
superagent say "Fix the flaky login test in the web repo and open a draft PR"
superagent say "Use Codex to add CSV export to the reports page in api"
```

`say` prints the router's first reply (usually which worker it started). Results arrive later in the
SuperAgent app and with `superagent tasks`.

To start one worker directly, with an exact agent and repo:

```bash
superagent run "Upgrade eslint to v10 and fix all new warnings" --agent codex --repo web
superagent run "Write a migration guide for the v2 API" --repo docs --title "v2 migration guide" --wait
```

`--wait` blocks until the worker finishes and prints its summary and PR link. Only use it for short
tasks; otherwise return to the user right away and say how to follow progress.

Write tasks the way you would brief a colleague: the goal, relevant context from this conversation
(file paths, error messages, decisions made), constraints, and what "done" means. Workers start with
nothing but that text.

## Checking on work

```bash
superagent tasks             # all workers: status, agent, repo, PR
superagent logs W3           # what worker 3 did (add -f to follow live)
superagent msg W3 "Also update the README"   # follow-up for a running or finished worker
superagent cancel W3         # stop it
superagent retry W3          # run a failed or stopped worker again
```

A worker with status `waiting` needs an answer: `superagent logs W3` shows its question at the end.
Show it to the user and send their reply with `superagent msg W3 "<answer>"`.

## Repositories and GitHub

```bash
superagent repo list
superagent repo add .                      # the current checkout
superagent repo add owner/name --mode all  # consider all issues and comments, not only mentions
superagent repo add owner/name --allow alice,bob   # who may trigger it (default: only you)
```

With a GitHub repo added, writing `/superagent` in an issue or PR comment calls the agent. Only
allowlisted GitHub users can trigger work, and the list starts with just the user, so add teammates
with `--allow` when they should be able to. Workers follow the PRs they open, so review comments and
failing CI go straight back to them.

## Rules

- Don't start a worker for something you were asked to do yourself in this session.
- Never pass secrets in task text.
- After delegating, tell the user what was started (worker id and agent) and how to follow it,
  for example "W4 (Codex) is on it. Run `superagent logs W4 -f` or open the SuperAgent app."
