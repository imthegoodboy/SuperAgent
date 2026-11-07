import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_IDS, applyConfigPatch, loadConfig, publicConfig, saveConfig, type SourceMode } from '../core/config.js';
import { CLI_PATH, ensureDirs, paths, pkgVersion } from '../core/paths.js';
import { ago, duration, sleep, slugify, snippet, tryJson } from '../core/util.js';
import { ADAPTERS } from '../agents/adapters.js';
import { commandLine, isAlive, killTree, resolveCommand, run, runInteractive } from '../agents/process.js';
import { checkSignIn, detectAgents, startWorkerRun } from '../agents/runner.js';
import {
  autostartStatus,
  chooseAutostart,
  ensureAutostartOnce,
  ensureIntegrations,
  installIntegrations,
  integrationStatus,
  addRepo,
  repoForFolder,
  resolveRepoInput,
  uninstallIntegrations,
} from '../daemon/system.js';
import { STOP_FLAG, watchdogPid } from '../daemon/watchdog.js';
import { api, baseUrl, events, health, sessionId, token } from './client.js';
import { fileUrl, pageIn, preview, serve, type PreviewResult } from './preview.js';

// The `superagent` CLI is used by coding agents (Claude Code, Codex, OpenCode, Cursor) that load the
// superagent skill and act as SuperAgent's router. Output is plain text for the agent to read, or
// JSON with --json.

// ---------- output helpers ----------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const blue = paint('34');
const magenta = paint('35');
const cyan = paint('36');

const STATUS_COLOR: Record<string, (s: string) => string> = {
  running: cyan,
  queued: dim,
  waiting: yellow,
  done: green,
  failed: red,
  stopped: dim,
};

let asJson = false;

function fit(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n);
}

/** Unwinds to main(), which sets the exit code. (process.exit() with a fetch socket still open crashes Node on Windows.) */
class CliExit extends Error {}

function die(msg: string): never {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(red('✗ ') + msg);
  throw new CliExit(msg);
}

function out(value: unknown, text: () => void): void {
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else text();
}

/** "W#3", "W3", "w3" and "3" all mean worker 3. */
function workerRef(s: string | undefined): string {
  const n = Number(String(s ?? '').replace(/^w\s*#?\s*/i, ''));
  if (!Number.isInteger(n) || n <= 0) die(`Expected a worker id like W#3, got "${s ?? ''}"`);
  return `W#${n}`;
}

function threadRef(s: string | undefined): string {
  const m = String(s ?? '').trim().match(/^(?:th\s*#?\s*)?(\d+)$/i);
  if (!m) die(`Expected a thread id like TH#8, got "${s ?? ''}"`);
  return `TH#${m[1]}`;
}

function list(v: unknown): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Text from the arguments, or from stdin when the argument is "-" (for long, multi-line text). */
async function textArg(parts: string[], usage: string): Promise<string> {
  let text = parts.join(' ').trim();
  if (text === '-') {
    text = '';
    process.stdin.setEncoding('utf8'); // decode across chunk boundaries (…, →, CJK)
    for await (const chunk of process.stdin) text += chunk;
    text = text.trim();
  }
  if (!text) die(`Usage: ${usage}`);
  return text;
}

const HELP = `${bold('SuperAgent')} ${dim('v' + pkgVersion())} - turns your coding agent into a Super-agent: an always-on router
that runs Claude Code, Codex, OpenCode and Cursor workers in parallel, each in its own git worktree.

These commands are for coding agents. The ${bold('superagent')} skill explains how to use them.

${bold('Be the router')}
  claude [request]            Open Claude Code in this terminal as the router (no editing tools)
  router attach [--take]      Become the router: context, memory, and what happened while you were away
  router detach               Hand the router role back to the background router
  router status               Who is the router right now, and its recent turns
  events [--wait <seconds>]   New events that need a decision (waits up to 280 s for one with --wait)
                                --peek shows them without handing them out; --again repeats the last batch
  dispatch <task|->           Start a worker and return at once
                                --agent claude|codex|opencode|cursor  --repo <name|owner/repo|.>  --title <text>
                                --follow TH#8,TH#9  --reply TH#8  --base <branch>  --silent
                                --after W#2 (start when W#2 is done)  --verify syntax|tests|browser
  tell <W#3> <text|-> [--now] New instructions for a worker (it resumes with its memory); --now interrupts it
                              and redoes the step it is on
  cancel <W#3> [--reason r]   Stop a worker
  reply <TH#8> <text|->       Post on a thread: a GitHub issue or PR, a Telegram chat
  ignore <T#41> [T#42 …]      Mark events as needing nothing  [--reason r]
  recall <id> [id …]          Read T#n, TH#n or W#n in full, with the IDs it links to
  follow <W#3> <TH#9>         Send a thread's new events straight to a worker (unfollow to stop)
  remember <fact|->           Keep a long-term fact; memory lists them, forget <id> removes one

${bold('Workers')}
  workers [--all]             List workers with their time so far (alias: ls)
  result <W#3>                A worker's full final answer, its report, and the files it changed
  wait <W#3> [W#4 …]          Block until these workers finish or need input  [--timeout 280]
  logs <W#3> [-f]             What a worker did; -f follows live. Without an id: the service log
  diff <W#3> [--patch]        What a worker changed: commits, files, uncommitted work
  preview <W#3|path> [file]   Screenshot a web page at a real device width; lists the page's errors
                                --width 375,1280  --height 800  --full  --dark  --out shot.png
  serve <W#3|path> [--port n] Serve a worker's folder on http://127.0.0.1 to open in a browser; returns
                              at once (the service serves it). serve lists them, serve --stop stops them
  merge <W#3> [W#4 …]         Merge workers' branches, in order, into the repo folder's branch  [--into main]
  retry <W#3>                 Run a failed or stopped worker again
  archive <W#3>               Remove a finished worker's workspace (its branch and PR stay)
  cleanup [--days 7]          Archive every worker that finished more than N days ago  [--dry-run]
  graph [--all] [--mermaid]   Router → workers → threads they follow (active and last 3 hours)

${bold('Service and setup')}
  start | stop | status
  restart [--when-idle]       Restart the service; --when-idle waits until no worker is running
  repo add <path|owner/repo> [--mode mentions|all|off] [--name n] [--agent a] [--allow u1,u2]
  repo list | repo rm <name>
  activity                    Recent events and what happened to each (why something was ignored)
  agents | doctor [--deep]    --deep makes a tiny real call to each agent (catches stale logins)
  config [get <key> | set <key> <value>]
  install | uninstall         Add or remove the skill for every coding agent on this computer
  autostart on|off

Quote text arguments. Text given as "-" is read from stdin; anything after -- is text, not options.
Every command accepts --json.
${dim('Data lives in ' + paths.home)}`;

// ---------- service lifecycle ----------

async function start(foreground: boolean, quiet = false): Promise<void> {
  const say = (s: string) => (quiet || asJson ? console.error(s) : console.log(s));
  const h = await health();
  if (h) {
    if (!quiet) out({ ok: true, running: true, pid: h.pid }, () => say(`${green('●')} SuperAgent is already running ${dim(`(pid ${h.pid})`)}`));
    return;
  }
  if (foreground) {
    try {
      await (await import('../daemon/main.js')).runDaemon();
    } catch (e) {
      console.error('daemon failed:', e);
      process.exit(1);
    }
    return;
  }
  ensureDirs();
  fs.rmSync(STOP_FLAG, { force: true });
  if (quiet) say(dim('Starting SuperAgent…'));
  const child = spawn(process.execPath, [CLI_PATH, '__watchdog'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: paths.home, env: serviceEnv() });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const ok = await health(1000);
    if (ok) {
      await ensureAutostartOnce();
      if (!quiet) out({ ok: true, running: true, pid: ok.pid }, () => say(`${green('●')} SuperAgent started ${dim(`(pid ${ok.pid})`)}`));
      return;
    }
  }
  die(`SuperAgent did not start. See ${path.join(paths.logs, 'daemon.log')}`);
}

/**
 * Router commands start the service from inside an agent's shell. The long-lived service and its
 * workers must not inherit that one session's identity or sandbox, so those variables are dropped.
 */
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|SSE_PORT)|CODEX_SANDBOX\w*|CODEX_THREAD_ID|SUPERAGENT_SESSION|SUPERAGENT_WORKER)$/;

function serviceEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));
}

/** Commands that need the service start it on demand, so an agent never has to. */
let checkedVersion = false;
async function ensureRunning(): Promise<void> {
  const h = await health();
  if (!h) return start(false, true);
  // After `npm i -g` the old service keeps running until restarted.
  if (!checkedVersion && h.version !== pkgVersion()) {
    console.error(yellow(`SuperAgent ${h.version} is running, but ${pkgVersion()} is installed. Run \`superagent restart --when-idle\` to switch once no worker is running.`));
  }
  checkedVersion = true;
}

async function stop(quiet = false): Promise<void> {
  const h = await health();
  ensureDirs();
  fs.writeFileSync(STOP_FLAG, '1');
  if (h) await api('POST', '/api/shutdown').catch(() => {});
  for (let i = 0; i < 20 && (await health(500)); i++) await sleep(500);
  const wd = watchdogPid();
  for (let i = 0; i < 10 && isAlive(wd); i++) await sleep(500);
  // After a reboot the pid file can name an unrelated program: only end it if it is our watchdog.
  if (wd && isAlive(wd) && (await commandLine(wd)).includes('__watchdog')) killTree(wd);
  if (quiet) return;
  out({ ok: true, running: false }, () => console.log(h ? `${dim('●')} SuperAgent stopped` : dim('SuperAgent was not running')));
}

/**
 * A restart interrupts running workers: they resume afterwards, but redo the step they were on (a
 * model writing a large file loses all of it). Say so first; --when-idle waits, --force goes ahead.
 */
async function restartGuard(v: Record<string, any>): Promise<void> {
  if (v.force || !(await health())) return;
  const running = async () => ((await api<any[]>('GET', '/api/workers')) ?? []).filter((w) => w.status === 'running');
  let busy = await running();
  if (!busy.length) return;
  const names = (ws: any[]) => ws.map((w) => `W#${w.id} (${duration(w.elapsed_ms ?? 0)})`).join(', ');
  if (!v['when-idle']) {
    die(
      `${busy.length} worker${busy.length === 1 ? ' is' : 's are'} running: ${names(busy)}. A restart interrupts ${busy.length === 1 ? 'it' : 'them'}; ` +
        `${busy.length === 1 ? 'it resumes' : 'they resume'} afterwards but redo${busy.length === 1 ? 'es' : ''} the step in progress. ` +
        'Run `superagent restart --when-idle` to restart once none is running, or `--force` to restart now.',
    );
  }
  if (!asJson) console.log(dim(`Waiting for ${names(busy)} to finish before restarting…`));
  while (busy.length) {
    await sleep(5000);
    busy = await running();
  }
}

async function status(): Promise<void> {
  const h = await health();
  if (!h) {
    return out({ running: false }, () => console.log(`${dim('●')} SuperAgent is not running. Router commands start it automatically, or run ${bold('superagent start')}.`));
  }
  const s = await api('GET', '/api/state');
  out({ running: true, ...s }, () => {
    const c = s.workers.counts as Record<string, number>;
    console.log(`${green('●')} ${bold('SuperAgent')} v${s.version} · pid ${s.pid} · up ${duration(Date.now() - s.startedAt)}`);
    const r = s.router;
    const who = r.attached
      ? `${green('an agent session')} (attached ${ago(r.attached.since)}, last command ${ago(r.attached.renewedAt)})`
      : `background router ${r.agent}${r.model ? '/' + r.model : ''} · ${r.busy ? cyan('thinking') : 'idle'}`;
    console.log(`  ${dim('Router ')}  ${who}${r.pending ? ` · ${yellow(`${r.pending} events waiting`)}` : ''}${r.lastError && !r.attached ? red(` · last error: ${String(r.lastError).slice(0, 80)}`) : ''}`);
    const parts = ['running', 'queued', 'waiting', 'done', 'failed'].filter((k) => c[k]).map((k) => STATUS_COLOR[k](`${c[k]} ${k}`));
    console.log(`  ${dim('Workers')}  ${parts.join(' · ') || 'none yet'} ${dim(`(max ${s.workers.max} in parallel)`)}`);
    for (const q of (s.workers.queued ?? []) as { id: number; why: string | null }[]) if (q.why) console.log(dim(`           W#${q.id} queued: ${q.why}`));
    const agentList = s.agents.map((a: any) => (a.installed ? `${green('✓')} ${a.id}` : `${red('✗')} ${dim(a.id)}`)).join('  ');
    console.log(`  ${dim('Agents ')}  ${agentList || dim('detecting…')}`);
    const gh = s.github;
    console.log(
      `  ${dim('Inputs ')}  GitHub ${gh.enabled ? `${gh.repos} repo${gh.repos === 1 ? '' : 's'}${gh.login ? ` as @${gh.login}` : ''}` : 'off'}${
        gh.lastError ? red(` (${gh.lastError.slice(0, 60)})`) : ''
      } · Telegram ${s.telegram.enabled ? `@${s.telegram.bot ?? '…'}` : 'off'}`,
    );
  });
}

// ---------- the router: an attached agent session ----------

/** Workers see the skill too. They may look around, but only the router changes anything. */
const WORKER_COMMANDS = new Set(['status', 'workers', 'ls', 'logs', 'diff', 'result', 'wait', 'preview', 'recall', 'graph', 'memory', 'activity', 'agents', 'doctor', 'hook']);

function refuseInWorker(cmd: string | undefined, sub: string | undefined): void {
  const w = process.env.SUPERAGENT_WORKER;
  if (!w) return;
  const readOnly =
    cmd === undefined || WORKER_COMMANDS.has(cmd) || (cmd === 'config' && (!sub || sub === 'get')) || ((cmd === 'repo' || cmd === 'repos') && (!sub || sub === 'list'));
  if (!readOnly) die(`You are SuperAgent worker ${w}; \`superagent ${cmd}\` is for the router. Finish your own task and end with your report.`);
}

/**
 * `--repo` takes a configured name, an owner/repo slug, or a folder ("." for the project the agent is
 * in). A folder that isn't configured yet is added on the spot, so working "here" takes one command.
 */
async function repoArg(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  await ensureRunning();
  const cfg = await api<{ repos: { name: string; slug?: string; path?: string }[] }>('GET', '/api/config');
  const v = value.toLowerCase();
  if (cfg.repos.some((r) => r.name.toLowerCase() === v || r.slug?.toLowerCase() === v)) return value;
  const dir = path.resolve(value);
  const isFolder = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  if (!isFolder && /^[\w.-]+\/[\w.-]+$/.test(value)) {
    // A GitHub repo that isn't configured yet: add it (it is cloned when the worker starts).
    const added = await api('POST', '/api/repos', { input: value });
    console.error(dim(`Added repository ${added.name} (${added.slug}).`));
    return added.name;
  }
  if (!isFolder) return value; // the router reports it as unknown
  const known = await repoForFolder(cfg.repos as never, dir);
  if (known) return known.name;
  const added = await api('POST', '/api/repos', { input: dir });
  console.error(dim(`Added repository ${added.name}${added.slug ? ` (${added.slug})` : ''} at ${added.path}.`));
  return added.name;
}

async function act(action: Record<string, unknown>, print: (r: any) => void): Promise<void> {
  await ensureRunning();
  const { results, away_pending } = await api<{ results: any[]; away_pending: boolean }>('POST', '/api/router/actions', { actions: [action] });
  const r = results[0];
  if (asJson) {
    console.log(JSON.stringify({ ...r, away_pending }, null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (!r.ok) die(r.error);
  print(r);
  if (away_pending) console.log(yellow('  Things happened while no agent was the router: run `superagent events` to see them.'));
}

async function router(sub: string | undefined, v: Record<string, any>): Promise<void> {
  if (sub === 'attach') {
    await ensureRunning();
    const r = await api('POST', '/api/router/attach', { take: !!v.take });
    return out(r, () => console.log(r.text));
  }
  if (sub === 'detach') {
    await api('POST', '/api/router/detach');
    return out({ ok: true }, () => console.log(`${green('✓')} Detached. The background router handles events until an agent attaches again.`));
  }
  if (sub === 'status' || !sub) {
    if (!(await health())) die('SuperAgent is not running.');
    const r = await api('GET', '/api/router');
    return out(r, () => {
      const s = r.status;
      if (s.attached) console.log(`Router: an agent session, attached ${ago(s.attached.since)}, last command ${ago(s.attached.renewedAt)} (hands back after ${loadConfig().router.leaseMinutes} min of quiet)`);
      else console.log(`Router: background (${s.agent}${s.model ? '/' + s.model : ''}), ${s.busy ? 'thinking' : 'idle'}, ${s.turns} turns in this session${s.lastError ? red(` · last error: ${s.lastError.slice(0, 120)}`) : ''}`);
      if (s.pending) console.log(yellow(`${s.pending} events waiting`));
      for (const t of r.turns.slice(0, 8)) {
        let acts: any[] = [];
        try {
          acts = JSON.parse(t.actions || '[]');
        } catch {
          /* none */
        }
        const what = acts.map((a) => a.type).join(', ') || (t.error ? red('error') : 'no action');
        console.log(dim(`  ${new Date(t.started_at).toTimeString().slice(0, 5)} ${t.session === 'attached agent' ? 'agent     ' : 'background'} ${t.batch_size} event${t.batch_size === 1 ? ' ' : 's'} → `) + what);
      }
    });
  }
  die('Usage: superagent router attach [--take] | detach | status');
}

async function eventsCmd(v: Record<string, any>): Promise<void> {
  await ensureRunning();
  if (v.peek || v.again) {
    const r = await api('GET', `/api/router/events?${v.again ? 'again' : 'peek'}=1`);
    return out(r, () => {
      console.log(r.text);
      if (v.again) console.log(dim('[end of the repeated batch]'));
    });
  }
  const wait = Math.max(0, Math.min(280, Number(v.wait ?? 0) || 0));
  const r = await api('GET', `/api/router/events?wait=${wait}`);
  out(r, () => {
    console.log(r.text);
    // Agents' shells cut long output; without this line they can tell the batch was cut short.
    if (r.events?.length) console.log(dim(`[end of ${r.events.length} event${r.events.length === 1 ? '' : 's'}; if you did not see them all, run \`superagent events --again\`]`));
  });
}

// ---------- workers ----------

async function workers(all: boolean): Promise<void> {
  await ensureRunning();
  const rows: any[] = await api('GET', `/api/workers${all ? '?archived=1' : ''}`);
  out(rows, () => {
    if (!rows.length) return console.log(dim('No workers yet. Start one with `superagent dispatch "<task>"`.'));
    for (const w of rows) {
      const st = (STATUS_COLOR[w.status] ?? ((s: string) => s))(fit(w.status, 8));
      const took = w.elapsed_ms ? duration(w.elapsed_ms) : '-';
      console.log(
        `${bold(fit('W#' + w.id, 6))} ${st} ${dim(fit(w.agent, 9))} ${fit(w.title, 44)} ${dim(fit(w.repo ?? '-', 14))} ${dim(fit(took, 8))} ${dim(fit(ago(w.created_at), 8))}${w.pr_url ? ' ' + blue(w.pr_url) : ''}`,
      );
      if (w.status === 'waiting' && w.summary) console.log(yellow(`        ${String(w.summary).split('\n').pop()}`));
      else if (w.status === 'running' && w.last) console.log(dim(`        ▸ ${fit(w.last, 100).trimEnd()}`));
      else if (w.status === 'queued' && w.waiting) console.log(dim(`        ⏸ ${w.waiting}`));
    }
  });
}

function printLog(l: { kind: string; text: string }): void {
  const t = l.text.trimEnd();
  switch (l.kind) {
    case 'text':
      console.log(t.replace(/^/gm, '  '));
      break;
    case 'tool':
      console.log(cyan('  ▸ ') + t);
      break;
    case 'output':
      console.log(dim(t.split('\n').slice(-6).join('\n').replace(/^/gm, '    ')));
      break;
    case 'error':
      console.log(red('  ✗ ' + t));
      break;
    case 'inbox':
      console.log(magenta('  ✉ ') + t);
      break;
    default:
      console.log(yellow('● ') + t);
  }
}

async function logs(idArg: string | undefined, follow: boolean): Promise<void> {
  if (!idArg) {
    const file = path.join(paths.logs, 'daemon.log');
    if (!fs.existsSync(file)) die('No service log yet.');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-80);
    return out({ file, lines }, () => console.log(lines.join('\n')));
  }
  await ensureRunning();
  const id = workerRef(idArg).slice(2);
  const rows: any[] = await api('GET', `/api/workers/${id}/logs`);
  if (asJson && !follow) return console.log(JSON.stringify(rows, null, 2));
  rows.forEach((l) => (asJson ? console.log(JSON.stringify(l)) : printLog(l)));
  if (!follow) return;
  events((ev) => {
    if (ev.type === 'worker_log' && ev.data?.worker_id === Number(id)) asJson ? console.log(JSON.stringify(ev.data)) : printLog(ev.data);
  });
  await new Promise(() => {});
}

/** `superagent diff W#3 [--patch]`: what a worker changed, so the router can tell the user without reading files. */
async function diff(idArg: string | undefined, patch: boolean): Promise<void> {
  await ensureRunning();
  const id = workerRef(idArg);
  const { worker: w } = await api('GET', `/api/workers/${id.slice(2)}`);
  if (!w.cwd || !fs.existsSync(w.cwd)) die(`${id}'s workspace is gone (archived).${w.pr_url ? ` Its PR: ${w.pr_url}` : ''}`);
  if (!w.branch) {
    // A scratch folder: list what is in it.
    const files: string[] = [];
    const walk = (dir: string, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (files.length >= 200 || e.name === 'node_modules' || e.name === '.git') continue;
        if (e.isDirectory()) walk(path.join(dir, e.name), path.join(rel, e.name));
        else files.push(path.join(rel, e.name));
      }
    };
    walk(w.cwd);
    return out({ worker: id, folder: w.cwd, files }, () => {
      console.log(`${bold(id)} works in a scratch folder: ${w.cwd}`);
      for (const f of files) console.log(`  ${f}`);
    });
  }
  let cut = false;
  const git = async (...a: string[]) => {
    const r = await run('git', ['-C', w.cwd, ...a], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`git ${a[0]} failed in ${w.cwd}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    if (r.stdout.length >= 256 * 1024 - 1) cut = true; // run() keeps the last 256 KB
    return r.stdout.trimEnd();
  };
  const range = `${w.base}...HEAD`;
  const [commits, stat, status] = await Promise.all([git('log', '--oneline', `${w.base}..HEAD`), git('diff', '--stat', range), git('status', '--short')]);
  let text = '';
  if (patch) {
    const parts = [await git('diff', range), await git('diff', 'HEAD')]; // committed, then staged + unstaged
    // New files git doesn't track yet: show small ones in full.
    for (const f of (await git('ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)) {
      const file = path.join(w.cwd, f);
      const size = fs.statSync(file).size;
      parts.push(size <= 64 * 1024 ? `--- new file: ${f}\n${fs.readFileSync(file, 'utf8')}` : `--- new file: ${f} (${size} bytes, not shown)`);
    }
    text = parts.filter(Boolean).join('\n');
    if (cut) text = `(This patch is longer than 256 KB and its start is cut off; open ${w.cwd} to see all of it.)\n${text}`;
  }
  out({ worker: id, branch: w.branch, base: w.base, folder: w.cwd, pr: w.pr_url, commits: commits.split('\n').filter(Boolean), stat, uncommitted: status, patch: patch ? text : undefined }, () => {
    console.log(`${bold(id)} on ${cyan(w.branch)} (from ${w.base})${w.pr_url ? ` · PR ${blue(w.pr_url)}` : ''}`);
    console.log(dim(`  ${w.cwd}`));
    console.log(commits ? `\nCommits:\n${commits.replace(/^/gm, '  ')}` : '\nNo commits yet.');
    if (stat) console.log(`\n${stat}`);
    if (status) console.log(`\nNot committed:\n${status.replace(/^/gm, '  ')}`);
    if (patch && text) console.log(`\n${text}`);
  });
}

/** Files in a scratch folder (no git there). */
function listFiles(dir: string, max = 200): string[] {
  const files: string[] = [];
  const walk = (d: string, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (files.length >= max || e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), path.join(rel, e.name));
      else files.push(path.join(rel, e.name));
    }
  };
  walk(dir);
  return files;
}

/** `superagent result W#3`: the worker's whole final answer, its report and what it changed, in one call. */
async function result(idArg: string | undefined): Promise<void> {
  await ensureRunning();
  const id = workerRef(idArg);
  const d = await api('GET', `/api/workers/${id.slice(2)}`);
  const w = d.worker;
  const runs: any[] = d.runs;
  const last = [...runs].reverse().find((r) => r.result || r.report);
  const report = tryJson<Record<string, any>>(last?.report ?? '') ?? {};
  const answer = String(last?.result ?? '')
    .replace(/<superagent-report>[\s\S]*?<\/superagent-report>/g, '')
    .trim();
  const ms = runs.reduce((s, r) => s + ((r.ended_at ?? Date.now()) - r.started_at), 0);
  let files = '';
  if (w.cwd && fs.existsSync(w.cwd)) {
    if (w.branch) {
      const stat = await run('git', ['-C', w.cwd, 'diff', '--stat', `${w.base}...HEAD`]);
      const status = await run('git', ['-C', w.cwd, 'status', '--short']);
      files = [stat.stdout.trimEnd(), status.stdout.trim() ? `not committed:\n${status.stdout.trimEnd()}` : ''].filter(Boolean).join('\n');
    } else files = listFiles(w.cwd).join('\n');
  }
  const where = w.pr_url ? `PR ${w.pr_url}` : w.branch ? `branch ${w.branch} (from ${w.base})` : w.cwd ? `folder ${w.cwd}` : 'workspace archived';
  out(
    {
      worker: id,
      title: w.title,
      status: w.status,
      agent: w.agent,
      elapsed_ms: ms,
      runs: runs.length,
      where,
      folder: w.cwd,
      report,
      answer,
      files: files ? files.split('\n') : [],
      error: w.error,
    },
    () => {
      console.log(`${bold(id)} "${w.title}" · ${(STATUS_COLOR[w.status] ?? String)(w.status)} · ${w.agent} · ${duration(ms)} over ${runs.length} run${runs.length === 1 ? '' : 's'}`);
      console.log(dim(`  ${where}`));
      if (report.summary) console.log(`\nReport: ${report.summary}`);
      if (report.verified) console.log(`Verified: ${report.verified}`);
      if (report.question) console.log(yellow(`Question: ${report.question}`));
      if (w.error) console.log(red(`Error: ${w.error}`));
      console.log(answer ? `\nFinal answer:\n${answer.replace(/^/gm, '  ')}` : dim('\nNo final answer yet.'));
      if (files) console.log(`\nFiles:\n${files.replace(/^/gm, '  ')}`);
    },
  );
}

const SETTLED = ['done', 'failed', 'stopped', 'waiting'];

/** `superagent wait W#3 [W#4 …]`: block until they finish (or need input), up to --timeout seconds. */
async function waitFor(refs: string[], v: Record<string, any>): Promise<void> {
  if (!refs.length) die('Usage: superagent wait <W#3> [W#4 …] [--timeout 280]');
  const ids = refs.map(workerRef).map((r) => Number(r.slice(2)));
  const timeout = v.timeout === undefined ? 280 : Number(v.timeout);
  if (!Number.isFinite(timeout) || timeout < 0) die('--timeout is in seconds (0 or more)');
  await ensureRunning();
  const deadline = Date.now() + timeout * 1000;
  let rows: any[] = [];
  for (;;) {
    const found: any[] = await api('GET', `/api/workers?ids=${ids.join(',')}`);
    rows = ids.map((n) => found.find((w) => w.id === n) ?? die(`No worker W#${n}`));
    if (rows.every((w) => SETTLED.includes(w.status)) || Date.now() >= deadline) break;
    await sleep(2000);
  }
  const pending = rows.filter((w) => !SETTLED.includes(w.status));
  out({ settled: !pending.length, workers: rows.map((w) => ({ worker: `W#${w.id}`, status: w.status, elapsed_ms: w.elapsed_ms, summary: w.summary, pr_url: w.pr_url, error: w.error })) }, () => {
    for (const w of rows) {
      const what = w.status === 'waiting' ? 'needs input' : w.status;
      const text = w.error && w.status !== 'done' ? w.error : w.summary;
      console.log(`${bold('W#' + w.id)} ${(STATUS_COLOR[w.status] ?? String)(what)} ${dim(`(${duration(w.elapsed_ms ?? 0)})`)}${text ? `: ${snippet(text, 300)}` : ''}`);
    }
    if (pending.length) console.log(dim(`Still going after ${timeout} s: ${pending.map((w) => 'W#' + w.id).join(', ')}. Run wait again, or keep working: results also arrive in \`superagent events\`.`));
    else console.log(dim('`superagent result W#n` shows a full answer. Their REPORT events still arrive in `superagent events`.'));
  });
  // 0: all finished well · 1: one failed or was stopped · 2: still running at the timeout
  if (pending.length) process.exitCode = 2;
  else if (rows.some((w) => w.status === 'failed' || w.status === 'stopped')) process.exitCode = 1;
}

/**
 * `superagent merge W#3 W#4 [--into main]`: merge workers' branches, in order, into a branch of the
 * user's own repository folder. It never pushes, needs a clean tree, and stops (with the merge undone)
 * at the first conflict.
 */
async function merge(refs: string[], into: string | undefined): Promise<void> {
  if (!refs.length) die('Usage: superagent merge <W#3> [W#4 …] [--into <branch>]');
  await ensureRunning();
  const ids = refs.map(workerRef);
  const details: any[] = [];
  for (const id of ids) details.push(await api('GET', `/api/workers/${id.slice(2)}`));
  for (const [i, d] of details.entries()) {
    const w = d.worker;
    if (!w.branch || !w.repo) die(`${ids[i]} worked in a scratch folder (${w.cwd}); there is no branch to merge.`);
    if (d.active || ['queued', 'running'].includes(w.status)) die(`${ids[i]} is still ${w.status}; wait for it first (\`superagent wait ${ids[i]}\`).`);
    if (w.pr_url) die(`${ids[i]} has a pull request (${w.pr_url}); merge that on GitHub instead.`);
    if (w.cwd && fs.existsSync(w.cwd)) {
      const s = await run('git', ['-C', w.cwd, 'status', '--porcelain']);
      if (s.stdout.trim()) die(`${ids[i]} has uncommitted changes in ${w.cwd}, which a merge would leave out. Run \`superagent tell ${ids[i]} "Commit your work"\` first.`);
    }
  }
  const repoNames = [...new Set(details.map((d) => d.worker.repo))];
  if (repoNames.length > 1) die(`These workers are in different repositories (${repoNames.join(', ')}); merge each repository's workers separately.`);
  const cfg = await api<{ repos: { name: string; path?: string }[] }>('GET', '/api/config');
  const repo = cfg.repos.find((r) => r.name === repoNames[0]);
  if (!repo?.path) die(`${repoNames[0]} is a GitHub clone that SuperAgent manages, not a folder of yours; have the workers open pull requests instead.`);
  const dir = repo.path;
  const git = (...a: string[]) => run('git', ['-C', dir, ...a], { timeoutMs: 120_000 });
  if ((await git('status', '--porcelain', '--untracked-files=no')).stdout.trim()) die(`${dir} has uncommitted changes; commit or stash them first.`);
  // A merge commit needs an author; without one every merge fails, which is not a conflict.
  if ((await git('var', 'GIT_COMMITTER_IDENT')).code !== 0) {
    die(`git doesn't know who you are in ${dir}: run \`git config --global user.name "Your Name"\` and \`git config --global user.email you@example.com\`, then merge again.`);
  }
  const current = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  if (!into && current === 'HEAD') die(`${dir} is not on a branch (detached HEAD); name one with --into <branch>.`);
  const target = into || current;
  if (target !== current) {
    const co = await git('checkout', target);
    if (co.code !== 0) die(`Could not switch ${dir} to ${target}: ${(co.stderr || co.stdout).trim().slice(0, 300)}`);
  }
  const merged: string[] = [];
  const skipped: string[] = [];
  for (const [i, d] of details.entries()) {
    const w = d.worker;
    if ((await git('rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`)).code !== 0) die(`${ids[i]}'s branch ${w.branch} is not in ${dir}.`);
    if ((await git('rev-list', '--count', `${target}..${w.branch}`)).stdout.trim() === '0') {
      skipped.push(ids[i]);
      continue;
    }
    const m = await git('merge', '--no-ff', '--no-edit', '-m', `Merge ${ids[i]}: ${w.title}`, w.branch);
    if (m.code !== 0) {
      const conflicts = (await git('diff', '--name-only', '--diff-filter=U')).stdout.trim().split('\n').filter(Boolean);
      await git('merge', '--abort');
      const before = merged.length ? `${merged.join(', ')} ${merged.length === 1 ? 'was' : 'were'} merged before it` : 'nothing was merged';
      if (!conflicts.length) die(`git could not merge ${ids[i]} (${w.branch}) into ${target}: ${(m.stderr || m.stdout).trim().split('\n').slice(0, 4).join(' ')}. ${before[0].toUpperCase()}${before.slice(1)}.`);
      die(
        `${ids[i]} (${w.branch}) conflicts with ${target}${conflicts.length ? ` in ${conflicts.join(', ')}` : ''}: ${(m.stderr || m.stdout).trim().split('\n')[0]}. ` +
          `That merge was undone; ${before}. To resolve it, dispatch a worker: superagent dispatch "Merge branch ${w.branch} into this branch and resolve the conflicts" --repo ${repo.name} --base ${target}`,
      );
    }
    merged.push(ids[i]);
  }
  const head = (await git('log', '-1', '--format=%h %s')).stdout.trim();
  out({ ok: true, into: target, folder: dir, merged, skipped, head }, () => {
    console.log(merged.length ? `${green('✓')} Merged ${merged.join(', ')} into ${bold(target)} in ${dir} ${dim(`(now at ${head}; not pushed)`)}` : dim(`Nothing to merge into ${target}.`));
    if (skipped.length) console.log(dim(`  Already in ${target}: ${skipped.join(', ')}`));
  });
}

/** The folder (and page) a preview or serve is about: a worker's workspace, or a path. */
async function targetFolder(target: string | undefined, usage: string): Promise<{ root: string; label: string }> {
  if (!target) die(`Usage: ${usage}`);
  if (/^w\s*#?\s*\d+$/i.test(target)) {
    await ensureRunning();
    const id = workerRef(target);
    const { worker: w } = await api('GET', `/api/workers/${id.slice(2)}`);
    if (!w.cwd || !fs.existsSync(w.cwd)) die(`${id}'s workspace is gone (archived).`);
    return { root: w.cwd, label: `w${id.slice(2)}` };
  }
  const root = path.resolve(target);
  if (!fs.existsSync(root)) die(`${root} does not exist`);
  return { root, label: '' };
}

const PREVIEW_USAGE = 'superagent preview <W#3|path> [file] [--width 375,1280] [--height 800] [--full] [--dark] [--out shot.png]';

/** `superagent preview`: what a web result really looks like at a phone or desktop width. */
async function previewCmd(target: string | undefined, file: string | undefined, v: Record<string, any>): Promise<void> {
  const { root, label } = await targetFolder(target, PREVIEW_USAGE);
  const page = pageIn(root, file);
  const widths = list(v.width ?? '375').map(Number);
  if (!widths.length || widths.some((w) => !Number.isInteger(w) || w < 200 || w > 4000)) die('--width is in pixels, 200 to 4000 (several: --width 375,1280)');
  if (v.out && widths.length > 1) die('--out names one file; leave it out to screenshot several widths');
  const heightArg = v.height === undefined ? 0 : Number(v.height);
  if (!Number.isInteger(heightArg) || heightArg < 0 || heightArg > 8000) die('--height is in pixels, up to 8000');
  // Pages load over http, as on a real site: modules, fetch() and service workers don't work from file://.
  const base = fs.statSync(root).isDirectory() ? root : path.dirname(page);
  let server: Awaited<ReturnType<typeof serve>> | null = null;
  let url = fileUrl(page);
  try {
    server = await serve(base, 0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${path.relative(base, page).split(path.sep).map(encodeURIComponent).join('/')}`;
  } catch {
    /* no local port here (a sandbox): fall back to file:// */
  }
  let dir = path.join(paths.home, 'previews');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    dir = path.join(os.tmpdir(), 'superagent-previews'); // a worker's sandbox may not reach the data folder
  }
  const name = [label, slugify(path.basename(path.dirname(page)), 30), slugify(path.basename(page, path.extname(page)), 30)].filter(Boolean).join('-');
  const shots: PreviewResult[] = [];
  try {
    for (const width of widths) {
      const height = heightArg || (width < 600 ? 812 : 900);
      const outFile = v.out ? path.resolve(String(v.out)) : path.join(dir, `${name}-${width}${v.dark ? '-dark' : ''}.png`);
      shots.push(await preview({ url, file: page, out: outFile, width, height, full: !!v.full, dark: !!v.dark }));
    }
  } finally {
    server?.close();
  }
  const errors = [...new Set(shots.flatMap((s) => s.errors))];
  out({ page, url, screenshots: shots.map((s) => ({ file: s.screenshot, width: s.width, height: s.height, dark: s.dark })), errors }, () => {
    console.log(`${bold(page)}`);
    for (const s of shots) console.log(`  ${s.width}×${s.height}${s.dark ? ' dark' : ''}: ${s.screenshot}`);
    console.log(errors.length ? red(`Page errors (${errors.length}):\n${errors.map((e) => `  ${e}`).join('\n')}`) : green('No page errors.'));
    console.log(dim('Open the PNG files to look at them.'));
  });
}

/** `superagent serve`: a local web server for a worker's folder, for checking a result by hand. */
/**
 * `superagent serve`: the service serves the folder, so the command returns at once with the URL (an
 * agent's shell would otherwise block on it). `--stop` stops one folder, or all of them.
 */
async function serveCmd(target: string | undefined, v: Record<string, any>): Promise<void> {
  await ensureRunning();
  if (v.stop) {
    const only = target ? (await targetFolder(target, 'superagent serve --stop [W#3|path]')).root : null;
    const r = await api('DELETE', `/api/serve${only ? `?root=${encodeURIComponent(only)}` : ''}`);
    return out(r, () => console.log(r.stopped.length ? `${green('✓')} Stopped serving ${r.stopped.join(', ')}` : dim('Nothing was being served.')));
  }
  if (!target) {
    const list: any[] = await api('GET', '/api/serve');
    return out(list, () => (list.length ? list.forEach((s) => console.log(`${s.url}  ${dim(s.folder)}`)) : console.log(dim('Nothing is being served. Usage: superagent serve <W#3|path> [--port 8080]'))));
  }
  const { root } = await targetFolder(target, 'superagent serve <W#3|path> [--port 8080]');
  const port = v.port === undefined ? 0 : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) die('--port is a number from 1 to 65535');
  const base = fs.statSync(root).isDirectory() ? root : path.dirname(root);
  let page = '';
  try {
    page = path.relative(base, pageIn(root)).split(path.sep).map(encodeURIComponent).join('/');
  } catch {
    /* no HTML file: serve the folder anyway */
  }
  const r = await api('POST', '/api/serve', { root: base, page, port });
  out(r, () => console.log(`${r.reused ? 'Already serving' : 'Serving'} ${base}\n  ${bold(r.url)}\n${dim('The SuperAgent service keeps serving it until `superagent serve --stop` or a restart.')}`));
}

async function graph(v: Record<string, any>): Promise<void> {
  await ensureRunning();
  const g = await api('GET', `/api/graph${v.all ? '?all=1' : ''}`);
  if (asJson) return console.log(JSON.stringify({ router: g.router, workers: g.workers, threads: g.threads }, null, 2));
  console.log(v.mermaid ? g.mermaid : g.tree);
}

async function activity(): Promise<void> {
  await ensureRunning();
  const r = await api('GET', '/api/triggers?limit=40');
  out(r.triggers, () => {
    if (!r.triggers.length) return console.log(dim('No events yet.'));
    for (const t of [...r.triggers].reverse()) {
      const th = t.thread_id ? r.threads[t.thread_id] : null;
      const what =
        t.decision === 'dropped'
          ? dim(`filtered: ${t.reason}`)
          : t.decision === 'pass_through'
            ? cyan(`sent to ${t.routed_to}`)
            : t.status === 'pending'
              ? yellow('waiting for the router')
              : t.status === 'ignored'
                ? dim(`ignored: ${t.reason ?? ''}`)
                : green(t.decision === 'fyi' ? 'recorded' : 'handled by the router');
      const who = t.author ? `@${t.author}` : t.source;
      console.log(`${dim(new Date(t.created_at).toTimeString().slice(0, 5))} ${bold(fit('T#' + t.id, 6))} ${fit(`${who} ${t.kind.replace(/_/g, ' ')}${th ? ' · TH#' + th.id : ''}`, 40)} ${what}`);
      console.log(dim(`        ${fit(t.text, 100)}`));
    }
  });
}

// ---------- setup ----------

async function repo(sub: string | undefined, rest: string[], v: Record<string, any>): Promise<void> {
  const running = !!(await health());
  if (sub === 'add') {
    const input = rest[0];
    if (!input) die('Usage: superagent repo add <path|owner/repo> [--mode mentions|all|off]');
    const allowUsers = v.allow ? list(v.allow) : undefined;
    const r = running
      ? await api('POST', '/api/repos', { input, mode: v.mode, name: v.name, agent: v.agent, allowUsers })
      : await (async () => {
          const repoCfg = await resolveRepoInput(input, { mode: v.mode as SourceMode, name: v.name, agent: v.agent, allowUsers });
          const cfg = loadConfig();
          const added = addRepo(cfg.repos, repoCfg, { mode: v.mode, name: v.name, agent: v.agent, allowUsers });
          cfg.repos = added.repos;
          saveConfig(cfg);
          return added.repo;
        })();
    return out(r, () => {
      console.log(`${green('✓')} Added ${bold(r.name)}${r.slug ? ` (${r.slug})` : ''}${r.path ? dim(' · ' + r.path) : ''}`);
      if (r.slug) {
        console.log(
          dim(
            `  GitHub events: ${r.mode}${r.mode === 'mentions' ? ` (write "${loadConfig().mention}" in an issue or comment)` : ''} · allowed users: ${r.allowUsers.length ? r.allowUsers.join(', ') : 'anyone'}`,
          ),
        );
      }
    });
  }
  if (sub === 'rm' || sub === 'remove') {
    const name = rest[0];
    if (!name) die('Usage: superagent repo rm <name>');
    if (running) await api('DELETE', `/api/repos/${encodeURIComponent(name)}`);
    else {
      const cfg = loadConfig();
      cfg.repos = cfg.repos.filter((r) => r.name.toLowerCase() !== name.toLowerCase());
      saveConfig(cfg);
    }
    return out({ ok: true, removed: name }, () => console.log(`${green('✓')} Removed ${name}`));
  }
  const cfg = loadConfig();
  out(cfg.repos, () => {
    if (!cfg.repos.length) return console.log(dim('No repos yet. Add one with: superagent repo add <path|owner/repo>'));
    for (const r of cfg.repos) {
      console.log(`${bold(fit(r.name, 18))} ${fit(r.slug ?? 'local only', 30)} ${dim(fit(r.mode, 9))} ${dim(r.path ?? '(cloned on first use)')}`);
    }
  });
}

async function agents(): Promise<void> {
  const rows: any[] = (await health()) ? await api('POST', '/api/agents/refresh') : await detectAgents();
  const cfg = loadConfig();
  const signIns = await Promise.all(rows.map((a) => (a.installed ? checkSignIn(a.id) : Promise.resolve(null))));
  out(rows.map((a, i) => ({ ...a, signedIn: signIns[i]?.signedIn ?? null })), () => {
    for (const [i, a] of rows.entries()) {
      const s = signIns[i];
      const auth = s?.signedIn === false ? red(` · not signed in (\`${s.login}\`)`) : s?.signedIn ? dim(' · signed in') : '';
      const def = a.id === cfg.workers.defaultAgent ? dim(' (default worker)') : '';
      const router = a.id === cfg.router.agent ? dim(' (background router)') : '';
      console.log(`${a.installed && s?.signedIn !== false ? green('✓') : red('✗')} ${bold(fit(a.label, 13))} ${a.installed ? a.version : dim(a.error ?? 'not found')}${auth}${def}${router}`);
    }
  });
}

function getPath(obj: any, key: string): any {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function patchFor(key: string, value: unknown): Record<string, unknown> {
  return key
    .split('.')
    .reverse()
    .reduce<any>((acc, k) => ({ [k]: acc }), value);
}

async function config(sub: string | undefined, rest: string[]): Promise<void> {
  if (!sub) {
    if (!asJson) console.log(dim(paths.config));
    console.log(JSON.stringify(publicConfig(loadConfig()), null, 2));
    return;
  }
  if (sub === 'get') {
    console.log(JSON.stringify(getPath(publicConfig(loadConfig()), rest[0] ?? ''), null, 2));
    return;
  }
  if (sub === 'set') {
    const [key, ...val] = rest;
    if (!key || !val.length) die('Usage: superagent config set <key> <value>');
    let value: unknown = val.join(' ');
    try {
      value = JSON.parse(String(value));
    } catch {
      /* plain string */
    }
    const patch = patchFor(key, value);
    const running = !!(await health());
    if (running) await api('PUT', '/api/config', patch);
    else saveConfig(applyConfigPatch(loadConfig(), patch));
    const applied = getPath(publicConfig(loadConfig()), key);
    const later = running && key === 'port' ? ' (the running service keeps its port until `superagent restart`)' : '';
    return out({ ok: true, key, value: applied, ...(later ? { restart: true } : {}) }, () => console.log(`${green('✓')} ${key} = ${JSON.stringify(applied)}${dim(later)}`));
  }
  die('Usage: superagent config [get <key> | set <key> <value>]');
}

function printIntegrations(): void {
  for (const i of integrationStatus()) {
    if (!i.detected) console.log(`${dim('-')} ${fit(i.label, 12)} ${dim('not found on this computer')}`);
    else if (!i.path) console.log(`${yellow('!')} ${fit(i.label, 12)} ${dim('skill not installed - run `superagent install`')}`);
    else console.log(`${green('✓')} ${fit(i.label, 12)} ${dim(i.path)}${i.current ? '' : yellow(' (outdated - run `superagent install`)')}`);
  }
}

async function doctor(deep = false): Promise<void> {
  const checks: { level: 'ok' | 'warn' | 'bad'; message: string; hint?: string }[] = [];
  const add = (level: 'ok' | 'warn' | 'bad') => (message: string, hint?: string) => {
    checks.push({ level, message, ...(hint ? { hint } : {}) });
    if (asJson) return;
    const mark = level === 'ok' ? green('✓') : level === 'warn' ? yellow('!') : red('✗');
    console.log(`${mark} ${message}${hint ? dim(' - ' + hint) : ''}`);
  };
  const ok = add('ok');
  const warn = add('warn');
  const bad = add('bad');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.version}`);
  else bad(`Node ${process.version}`, 'SuperAgent needs Node 22.13 or newer');
  const git = await run('git', ['--version']);
  if (git.code === 0) ok(git.stdout.trim());
  else bad('git not found', 'install Git');
  const gh = await run('gh', ['auth', 'status'], { timeoutMs: 20_000 });
  if (gh.code === 0) ok(`GitHub CLI logged in ${(gh.stdout + gh.stderr).match(/account (\S+)/)?.[1] ?? ''}`.trim());
  else warn('GitHub CLI not logged in', 'run `gh auth login` to enable GitHub triggers and PRs');
  const found = await detectAgents();
  const signIns = await Promise.all(found.map((a) => (a.installed ? checkSignIn(a.id) : Promise.resolve(null))));
  found.forEach((a, i) => {
    const s = signIns[i];
    if (!a.installed) warn(`${a.label} not available`, a.error ?? '');
    else if (s?.signedIn === false) warn(`${a.label} ${a.version} is installed but not signed in`, `run \`${s.login}\`; its workers fail until then`);
    else ok(`${a.label} ${a.version}${s?.signedIn ? ', signed in' : ''}`);
  });
  if (!found.some((a) => a.installed)) bad('No coding agent installed', `install one of: ${AGENT_IDS.join(', ')}`);
  if (deep) {
    // A saved login can be stale while the agent's own status still says "logged in": ask each one for a word.
    const cfg = loadConfig();
    for (const [i, a] of found.entries()) {
      const adapter = ADAPTERS[a.id];
      if (!a.installed || !adapter || signIns[i]?.signedIn === false) continue;
      if (!asJson) process.stdout.write(dim(`  asking ${a.label} for a test reply…\r`));
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-doctor-'));
      const started = Date.now();
      try {
        const res = await startWorkerRun(
          adapter,
          { cwd, prompt: 'Reply with the single word OK.', session: null, model: cfg.agents[a.id as keyof typeof cfg.agents]?.model ?? '', system: '', autonomy: 'safe', writableDirs: [] },
          () => {},
          120_000,
        ).done;
        if (res.error) bad(`${a.label} failed a test call`, snippet(res.error, 200));
        else ok(`${a.label} answered a test call in ${duration(Date.now() - started)}`);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
  const skill = integrationStatus();
  if (!asJson) {
    console.log(bold('Skill'));
    printIntegrations();
  }
  const h = await health();
  if (h) ok(`Service running (pid ${h.pid}) at ${baseUrl()}`);
  else warn('Service not running', 'router commands start it automatically');
  const cfg = loadConfig();
  if (!cfg.repos.length) warn('No repos configured', 'superagent repo add <path|owner/repo>');
  for (const r of cfg.repos) {
    if (r.path && !fs.existsSync(r.path)) bad(`Repo ${r.name}: ${r.path} does not exist`);
    else ok(`Repo ${r.name}${r.slug ? ` (${r.slug}, GitHub events: ${r.mode})` : ''}`);
  }
  if (process.env.SUPERAGENT_HOME) ok(`Custom data folder (${paths.home}): it doesn't start at login by itself`);
  else if (await autostartStatus()) ok('Starts automatically at login');
  else warn('Not starting at login', 'superagent autostart on');
  if (asJson) console.log(JSON.stringify({ ok: !checks.some((c) => c.level === 'bad'), checks, skill }, null, 2));
}

/** The router's role, given to Claude Code by `superagent claude`. One line: it travels as an argument. */
const ROUTER_ROLE =
  'You are running as the router of SuperAgent. Use the superagent skill. You talk to the user and hand every piece of real work to workers with the superagent CLI; never edit files or run project commands yourself. Only superagent commands are pre-approved here.';

/** Arguments for an interactive Claude Code session that is the router (exported for tests). */
export function claudeRouterArgs(request: string): string[] {
  const first = request
    ? `Attach as SuperAgent's router, then handle this: ${request}`
    : "Attach as SuperAgent's router and give me a short status: what is running, what needs me, and what happened while I was away.";
  return [
    // Only the shell (for the superagent CLI) and skills: no editing tools, so it can't drift into
    // doing the work itself. That was the main failure of single sessions in the article's experiment.
    // Deny rules win over allow rules in the user's own settings, and no MCP server can add tools back.
    '--tools', 'Bash,Skill',
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
    '--strict-mcp-config',
    '--allowedTools', 'Bash(superagent *)', 'Bash(superagent)',
    '--append-system-prompt', ROUTER_ROLE,
    first,
  ];
}

/** `superagent claude [request]`: open Claude Code in this terminal, already acting as the router. */
async function launchClaude(request: string): Promise<void> {
  const resolved = resolveCommand('claude');
  if (!resolved) die('Claude Code is not installed (`claude` was not found on PATH).');
  // A wrapper we can't see through would run the request through cmd.exe or PowerShell, which rewrite
  // characters such as % and $ in it.
  if (resolved.via === 'cmd' || resolved.via === 'powershell') die(`Can't start Claude Code safely through ${resolved.path}; run \`claude\` yourself and say "use superagent".`);
  await ensureRunning();
  const code = await runInteractive(resolved, claudeRouterArgs(request), process.cwd());
  if (code) process.exitCode = code;
}

/**
 * `superagent hook prompt`: the skill registers this as a Claude Code UserPromptSubmit hook, so it runs
 * on every user message once the session has used the skill. When this session is the router and
 * events are waiting, it prints a short notice that becomes part of the model's context: results show
 * up without asking (the article's full-duplex delivery). It hands nothing out, never starts the
 * service, and never fails or slows the agent down.
 */
async function hook(): Promise<void> {
  let input: { session_id?: string } = {};
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let raw = '';
    const read = (async () => {
      for await (const chunk of process.stdin) raw += chunk;
    })();
    await Promise.race([read, sleep(1000)]);
    try {
      input = JSON.parse(raw || '{}');
    } catch {
      /* not JSON: use the environment */
    }
  }
  // SUPERAGENT_SESSION, when set, is also what the router commands send (see sessionId()).
  const session = String(process.env.SUPERAGENT_SESSION || input.session_id || sessionId());
  let r: { attached: boolean; pending: string[]; away_pending: boolean } = { attached: false, pending: [], away_pending: false };
  if (session) {
    try {
      const res = await fetch(`${baseUrl()}/api/router/peek`, {
        headers: { authorization: `Bearer ${token()}`, 'x-superagent-session': session },
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) r = (await res.json()) as typeof r;
    } catch {
      /* service not running or slow: say nothing */
    }
  }
  const n = r.pending.length;
  let notice: string | null = null;
  if (r.attached && (n || r.away_pending)) {
    const head = n ? `${n} event${n === 1 ? ' is' : 's are'} waiting` : 'things happened while no agent was the router';
    const lines = [`[SuperAgent] You are the router and ${head}. Run \`superagent events\` and handle ${n === 1 ? 'it' : 'them'} along with this message.`];
    for (const p of r.pending.slice(0, 8)) lines.push(`- ${p}`);
    if (n > 8) lines.push(`- … and ${n - 8} more`);
    notice = lines.join('\n');
  }
  out({ notice, pending: r.pending, away_pending: r.away_pending }, () => notice && console.log(notice));
}

async function uninstall(): Promise<void> {
  await stop(true);
  const removed = uninstallIntegrations();
  let autostart = false;
  // The Windows Run key is per user, not per data folder; tests must never remove the real one.
  if (process.env.SUPERAGENT_SKIP_AUTOSTART !== '1') {
    try {
      autostart = await chooseAutostart(false);
    } catch {
      /* nothing to undo */
    }
  }
  out({ ok: true, removed, autostart }, () => {
    for (const r of removed) console.log(`${green('✓')} Removed ${dim(r)}`);
    console.log(`${green('✓')} SuperAgent stopped and will not start at login.`);
    console.log(dim(`  Your data is still in ${paths.home}. Remove the CLI with: npm uninstall -g @phigon/superagent`));
  });
}

// ---------- entry ----------

/** Parse the command line. Unknown options are errors (a typo must not be ignored silently). */
function parseCli(argv: string[]) {
  // A quoted argument with spaces is text even when it starts with "-" ("--json output is nice").
  const text: string[] = [];
  const args = argv.map((a) => (a.startsWith('-') && /\s/.test(a) ? `\u0000${text.push(a) - 1}` : a));
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: CLI_OPTIONS,
  });
  const restore = (p: unknown) => (typeof p === 'string' && p.startsWith('\u0000') ? text[Number(p.slice(1))] : p);
  const values = Object.fromEntries(Object.entries(parsed.values).map(([k, val]) => [k, restore(val)]));
  return { values: values as Record<string, any>, positionals: parsed.positionals.map((p) => restore(p) as string) };
}

const CLI_OPTIONS = {
      agent: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      follow: { type: 'string' },
      reply: { type: 'string' },
      silent: { type: 'boolean' },
      reason: { type: 'string' },
      wait: { type: 'string' },
      take: { type: 'boolean' },
      now: { type: 'boolean' },
      base: { type: 'string' },
      days: { type: 'string' },
      mermaid: { type: 'boolean' },
      patch: { type: 'boolean' },
      mode: { type: 'string' },
      name: { type: 'string' },
      allow: { type: 'string' },
      all: { type: 'boolean' },
      after: { type: 'string' },
      verify: { type: 'string' },
      timeout: { type: 'string' },
      into: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      dark: { type: 'boolean' },
      full: { type: 'boolean' },
      out: { type: 'string' },
      port: { type: 'string' },
      force: { type: 'boolean' },
      'when-idle': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      peek: { type: 'boolean' },
      again: { type: 'boolean' },
      deep: { type: 'boolean' },
      stop: { type: 'boolean' },
      live: { type: 'boolean', short: 'f' },
      json: { type: 'boolean' },
      foreground: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
} as const;

export async function main(argv: string[]): Promise<void> {
  let v: Record<string, any>;
  let positionals: string[];
  try {
    ({ values: v, positionals } = parseCli(argv));
  } catch (e) {
    asJson = argv.includes('--json');
    const msg = (e as Error).message.replace(/\. To specify a positional argument.*$/s, '');
    try {
      die(`${msg}. Quote text that contains options, or put it after --. See \`superagent help\`.`);
    } catch {
      process.exitCode = 1;
      return;
    }
  }
  asJson = !!v.json;
  const [cmd, ...rest] = positionals;
  if (v.version || cmd === 'version') return out({ version: pkgVersion() }, () => console.log(pkgVersion()));
  if (v.help || cmd === 'help') return out({ help: HELP.replace(/\x1b\[\d+m/g, '') }, () => console.log(HELP));
  // Installing the package is the only step a person takes; every command keeps the skill in place
  // for agents installed later. It must never get in the way of the command itself.
  if (cmd !== '__daemon' && cmd !== '__watchdog' && cmd !== 'uninstall' && cmd !== 'hook') {
    try {
      ensureIntegrations();
    } catch {
      /* best effort */
    }
  }

  // The cases `return someCommand()`; awaiting the whole switch makes their rejections reach the catch.
  const dispatch = async (): Promise<void> => {
    refuseInWorker(cmd, rest[0]);
    switch (cmd) {
      case undefined:
        await status();
        if (!asJson) console.log(`\n${dim('Run `superagent help` for all commands.')}`);
        return;
      case '__daemon':
      case '__watchdog':
        try {
          if (cmd === '__daemon') await (await import('../daemon/main.js')).runDaemon();
          else await (await import('../daemon/watchdog.js')).runWatchdog();
        } catch (e) {
          // Half-started (say, the server listens but init failed): exit so the watchdog restarts it.
          console.error(`${cmd.slice(2)} failed:`, e);
          process.exit(1);
        }
        return;
      case 'start':
        return start(!!v.foreground);
      case 'stop':
        return stop();
      case 'restart':
        await restartGuard(v);
        await stop(true);
        return start(false);
      case 'status':
        return status();

      // ---- router ----
      case 'router':
        return router(rest[0], v);
      case 'events':
        return eventsCmd(v);
      case 'dispatch': {
        const task = await textArg(rest, 'superagent dispatch "<task>" [--agent codex] [--repo name] [--follow TH#8] [--reply TH#8] [--silent]');
        return act(
          {
            type: 'dispatch',
            task,
            title: v.title,
            agent: v.agent,
            repo: await repoArg(v.repo as string | undefined),
            threads: list(v.follow).map(threadRef),
            reply_thread: v.reply ? threadRef(String(v.reply)) : undefined,
            silent: !!v.silent,
            base: v.base,
            after: v.after ? workerRef(String(v.after)) : undefined,
            verify: v.verify,
          },
          (r) => {
            const place = r.repo ? dim(` · repo ${r.repo}`) : dim(' · scratch folder');
            const why =
              r.waiting_for === 'after'
                ? `${r.waiting_detail}; it starts when that is done`
                : r.waiting_for === 'memory'
                  ? `waiting for memory: ${r.waiting_detail}`
                  : `${r.running}/${r.max} slots busy; it starts when one frees up`;
            if (r.status === 'queued') console.log(`${yellow('⏸')} Queued ${bold(r.worker)} ${dim(`(${r.agent})`)} ${r.title}${place} ${dim(`(${why})`)}`);
            else console.log(`${green('▶')} Started ${bold(r.worker)} ${dim(`(${r.agent})`)} ${r.title}${place}`);
            if (r.follows.length) console.log(dim(`  follows ${r.follows.join(', ')}: new events there go straight to it`));
            const where = r.reports_to_user ? '' : ` (its reply thread is ${r.reply_thread})`;
            console.log(dim(`  Its result arrives in \`superagent events\`${where}${r.silent ? '; silent: only if it succeeds' : ''}. Keep going meanwhile.`));
          },
        );
      }
      case 'tell':
        return act(
          { type: 'message_worker', worker: workerRef(rest[0]), text: await textArg(rest.slice(1), 'superagent tell <W#3> "<text>" [--now]'), now: !!v.now },
          (r) =>
            console.log(
              r.interrupted
                ? `${green('✓')} Interrupted ${r.worker}: the step it was on${r.discarded_ms ? ` (running ${duration(r.discarded_ms)})` : ''} is redone, now with this message.`
                : r.was_running
                  ? `${green('✓')} Sent to ${r.worker}. It reads it when its current run ends (--now interrupts it, and the step in progress is redone).`
                  : r.status === 'queued'
                    ? `${green('✓')} Sent to ${r.worker}, which is queued; it starts with this message when it can.`
                    : `${green('✓')} ${r.worker} resumes now with this message.`,
            ),
        );
      case 'cancel':
        return act({ type: 'stop_worker', worker: workerRef(rest[0]), reason: v.reason ?? 'stopped by the router' }, (r) => console.log(`${green('✓')} Stopped ${r.worker}`));
      case 'reply':
        return act({ type: 'reply', thread: threadRef(rest[0]), text: await textArg(rest.slice(1), 'superagent reply <TH#8> "<text>"') }, (r) =>
          console.log(`${green('✓')} Posted on ${r.thread}`),
        );
      case 'ignore':
        if (!rest.length) die('Usage: superagent ignore <T#41> [T#42 …] [--reason r]');
        return act({ type: 'ignore', triggers: rest, reason: v.reason }, (r) => console.log(`${green('✓')} Ignored ${r.triggers.join(', ') || 'nothing (unknown ids)'}`));
      case 'follow':
      case 'unfollow':
        return act({ type: cmd === 'follow' ? 'subscribe' : 'unsubscribe', worker: workerRef(rest[0]), thread: threadRef(rest[1]) }, (r) =>
          console.log(`${green('✓')} ${r.worker} ${cmd === 'follow' ? 'now follows' : 'no longer follows'} ${r.thread}`),
        );
      case 'remember':
        return act({ type: 'remember', text: await textArg(rest, 'superagent remember "<fact>"') }, (r) => console.log(`${green('✓')} Remembered (#${r.memory})`));
      case 'memory': {
        await ensureRunning();
        const rows: any[] = await api('GET', '/api/memory');
        return out(rows, () => {
          if (!rows.length) return console.log(dim('Nothing remembered yet.'));
          for (const m of rows) console.log(`${dim(fit('#' + m.id, 5))} ${m.text} ${dim(ago(m.created_at))}`);
        });
      }
      case 'forget': {
        const n = Number(String(rest[0] ?? '').replace(/^#/, ''));
        if (!Number.isInteger(n) || n <= 0) die('Usage: superagent forget <memory id>');
        await ensureRunning();
        await api('DELETE', `/api/memory/${n}`);
        return out({ ok: true }, () => console.log(`${green('✓')} Forgot #${n}`));
      }
      case 'recall': {
        if (!rest.length) die('Usage: superagent recall <T#42|TH#8|W#3> […]');
        await ensureRunning();
        const r = await api('GET', `/api/recall?ids=${encodeURIComponent(rest.join(','))}`);
        out(r, () => console.log(r.text));
        if (r.missing?.length) {
          if (!asJson) console.error(red(`✗ Not found: ${r.missing.join(', ')} (use T#n, TH#n or W#n)`));
          process.exitCode = 1;
        }
        return;
      }

      // ---- workers ----
      case 'workers':
      case 'ls':
        return workers(!!v.all);
      case 'logs':
        return logs(rest[0], !!v.live);
      case 'retry': {
        const w = workerRef(rest[0]);
        await ensureRunning();
        await api('POST', `/api/workers/${w.slice(2)}/retry`);
        return out({ ok: true, worker: w }, () => console.log(`${green('✓')} Retrying ${w}`));
      }
      case 'archive': {
        const w = workerRef(rest[0]);
        await ensureRunning();
        await api('POST', `/api/workers/${w.slice(2)}/archive`);
        return out({ ok: true, worker: w }, () => console.log(`${green('✓')} Archived ${w}`));
      }
      case 'graph':
        return graph(v);
      case 'cleanup': {
        await ensureRunning();
        const days = v.days === undefined ? 7 : Number(v.days);
        if (!Number.isFinite(days) || days < 0) die('Usage: superagent cleanup [--days N] (N is 0 or more)');
        const dryRun = !!v['dry-run'];
        const r = await api('POST', '/api/workers/cleanup', { days, dryRun });
        return out(r, () =>
          console.log(
            !r.archived.length
              ? dim(`Nothing to clean up: no finished worker is older than ${days} days.`)
              : dryRun
                ? `Would archive ${r.archived.join(', ')} (finished more than ${days} days ago). Nothing was changed.`
                : `${green('✓')} Archived ${r.archived.join(', ')} (finished more than ${days} days ago; branches and PRs stay)`,
          ),
        );
      }
      case 'diff':
        return diff(rest[0], !!v.patch);
      case 'result':
        return result(rest[0]);
      case 'wait':
        return waitFor(rest, v);
      case 'merge':
        return merge(rest, v.into);
      case 'preview':
        return previewCmd(rest[0], rest[1], v);
      case 'serve':
        return serveCmd(rest[0], v);
      case 'activity':
        return activity();

      // ---- setup ----
      case 'repo':
      case 'repos':
        return repo(rest[0], rest.slice(1), v);
      case 'agents':
        return agents();
      case 'config':
        return config(rest[0], rest.slice(1));
      case 'install': {
        const r = installIntegrations();
        return out(r, () => {
          printIntegrations();
          if (!r.some((i) => i.path)) console.log(yellow('No coding agent found. Install Claude Code, Codex, OpenCode or Cursor, then run `superagent install`.'));
          else console.log(dim('Open any of these agents and say "use superagent".'));
        });
      }
      case 'uninstall':
        return uninstall();
      case 'autostart': {
        if (rest[0] === 'on' || rest[0] === 'off') {
          const on = await chooseAutostart(rest[0] === 'on');
          return out({ ok: true, autostart: on }, () => console.log(`${green('✓')} Autostart ${on ? 'on' : 'off'}`));
        }
        const on = await autostartStatus();
        return out({ autostart: on }, () => console.log(`Autostart is ${on ? 'on' : 'off'}`));
      }
      case 'doctor':
        return doctor(!!v.deep);
      case 'claude':
        return launchClaude(rest.join(' ').trim());
      case 'hook':
        if (rest[0] !== 'prompt') die('Usage: superagent hook prompt   (run by an agent harness on each user message)');
        return hook();
      default:
        if (!asJson) console.log(HELP);
        die(`Unknown command "${cmd}"`);
    }
  };
  try {
    await dispatch();
  } catch (e) {
    if (!(e instanceof CliExit)) {
      try {
        die((e as Error).message);
      } catch {
        /* printed */
      }
    }
    process.exitCode = 1;
  }
}
