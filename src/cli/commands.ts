import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_IDS, applyConfigPatch, loadConfig, publicConfig, saveConfig, type SourceMode } from '../core/config.js';
import { CLI_PATH, ensureDirs, paths, pkgVersion } from '../core/paths.js';
import { ago, duration, sleep } from '../core/util.js';
import { isAlive, killTree, run } from '../agents/process.js';
import { detectAgents } from '../agents/runner.js';
import {
  autostartStatus,
  ensureAutostartOnce,
  ensureIntegrations,
  installIntegrations,
  integrationStatus,
  resolveRepoInput,
  setAutostart,
  uninstallIntegrations,
} from '../daemon/system.js';
import { STOP_FLAG, watchdogPid } from '../daemon/watchdog.js';
import { api, baseUrl, events, health } from './client.js';

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
  router attach [--take]      Become the router: context, memory, and what happened while you were away
  router detach               Hand the router role back to the background router
  router status               Who is the router right now, and its recent turns
  events [--wait <seconds>]   New events that need a decision (waits up to 280 s for one with --wait)
  dispatch <task|->           Start a worker and return at once
                                --agent claude|codex|opencode|cursor  --repo <name>  --title <text>
                                --follow TH#8,TH#9  --reply TH#8  --silent
  tell <W#3> <text|->         New instructions or information for a worker (it resumes with its memory)
  cancel <W#3> [--reason r]   Stop a worker
  reply <TH#8> <text|->       Post on a thread: a GitHub issue or PR, a Telegram chat
  ignore <T#41> [T#42 …]      Mark events as needing nothing  [--reason r]
  recall <id> [id …]          Read T#n, TH#n or W#n in full, with the IDs it links to
  follow <W#3> <TH#9>         Send a thread's new events straight to a worker (unfollow to stop)
  remember <fact|->           Keep a long-term fact; memory lists them, forget <id> removes one

${bold('Workers')}
  workers [--all]             List workers (alias: ls)
  logs <W#3> [-f]             What a worker did; -f follows live. Without an id: the service log
  retry <W#3>                 Run a failed or stopped worker again
  archive <W#3>               Remove a finished worker's workspace (its branch and PR stay)
  graph [--mermaid]           Router → workers → threads they follow

${bold('Service and setup')}
  start | stop | restart | status
  repo add <path|owner/repo> [--mode mentions|all|off] [--name n] [--agent a] [--allow u1,u2]
  repo list | repo rm <name>
  activity                    Recent events and what happened to each (why something was ignored)
  agents | doctor
  config [get <key> | set <key> <value>]
  install | uninstall         Add or remove the skill for every coding agent on this computer
  autostart on|off

Text arguments given as "-" are read from stdin. Every command accepts --json.
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
    const { runDaemon } = await import('../daemon/main.js');
    await runDaemon();
    return;
  }
  ensureDirs();
  fs.rmSync(STOP_FLAG, { force: true });
  if (quiet) say(dim('Starting SuperAgent…'));
  const child = spawn(process.execPath, [CLI_PATH, '__watchdog'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: paths.home });
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

/** Commands that need the service start it on demand, so an agent never has to. */
async function ensureRunning(): Promise<void> {
  if (!(await health())) await start(false, true);
}

async function stop(quiet = false): Promise<void> {
  const h = await health();
  ensureDirs();
  fs.writeFileSync(STOP_FLAG, '1');
  if (h) await api('POST', '/api/shutdown').catch(() => {});
  for (let i = 0; i < 20 && (await health(500)); i++) await sleep(500);
  const wd = watchdogPid();
  for (let i = 0; i < 10 && isAlive(wd); i++) await sleep(500);
  if (isAlive(wd)) killTree(wd);
  if (quiet) return;
  out({ ok: true, running: false }, () => console.log(h ? `${dim('●')} SuperAgent stopped` : dim('SuperAgent was not running')));
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
    console.log(`  ${dim('Agents ')}  ${s.agents.map((a: any) => (a.installed ? `${green('✓')} ${a.id}` : `${red('✗')} ${dim(a.id)}`)).join('  ')}`);
    const gh = s.github;
    console.log(
      `  ${dim('Inputs ')}  GitHub ${gh.enabled ? `${gh.repos} repo${gh.repos === 1 ? '' : 's'}${gh.login ? ` as @${gh.login}` : ''}` : 'off'}${
        gh.lastError ? red(` (${gh.lastError.slice(0, 60)})`) : ''
      } · Telegram ${s.telegram.enabled ? `@${s.telegram.bot ?? '…'}` : 'off'}`,
    );
  });
}

// ---------- the router: an attached agent session ----------

/** The router commands change shared state, so workers (which also see the skill) may not use them. */
function refuseInWorker(cmd: string): void {
  const w = process.env.SUPERAGENT_WORKER;
  if (w) die(`You are SuperAgent worker ${w}; \`superagent ${cmd}\` is for the router. Finish your own task and end with your report.`);
}

async function act(action: Record<string, unknown>, print: (r: any) => void): Promise<void> {
  await ensureRunning();
  const [r] = await api<any[]>('POST', '/api/router/actions', { actions: [action] });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (!r.ok) die(r.error);
  print(r);
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
  const wait = Math.max(0, Math.min(280, Number(v.wait ?? 0) || 0));
  const r = await api('GET', `/api/router/events?wait=${wait}`);
  out(r, () => console.log(r.text));
}

// ---------- workers ----------

async function workers(all: boolean): Promise<void> {
  const rows: any[] = await api('GET', `/api/workers${all ? '?archived=1' : ''}`);
  out(rows, () => {
    if (!rows.length) return console.log(dim('No workers yet. Start one with `superagent dispatch "<task>"`.'));
    for (const w of rows) {
      const st = (STATUS_COLOR[w.status] ?? ((s: string) => s))(fit(w.status, 8));
      console.log(
        `${bold(fit('W#' + w.id, 6))} ${st} ${dim(fit(w.agent, 9))} ${fit(w.title, 44)} ${dim(fit(w.repo ?? '-', 14))} ${dim(fit(ago(w.created_at), 8))}${w.pr_url ? ' ' + blue(w.pr_url) : ''}`,
      );
      if (w.status === 'waiting' && w.summary) console.log(yellow(`        ${String(w.summary).split('\n').pop()}`));
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
    console.log(fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-80).join('\n'));
    return;
  }
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

async function graph(v: Record<string, any>): Promise<void> {
  const g = await api('GET', '/api/graph');
  if (asJson) return console.log(JSON.stringify({ router: g.router, workers: g.workers, threads: g.threads }, null, 2));
  console.log(v.mermaid ? g.mermaid : g.tree);
}

async function activity(): Promise<void> {
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
          cfg.repos = [...cfg.repos.filter((x) => x.name.toLowerCase() !== repoCfg.name.toLowerCase()), repoCfg];
          saveConfig(cfg);
          return repoCfg;
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
  out(rows, () => {
    for (const a of rows) {
      const def = a.id === cfg.workers.defaultAgent ? dim(' (default worker)') : '';
      const router = a.id === cfg.router.agent ? dim(' (background router)') : '';
      console.log(`${a.installed ? green('✓') : red('✗')} ${bold(fit(a.label, 13))} ${a.installed ? a.version : dim(a.error ?? 'not found')}${def}${router}`);
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
    if (await health()) await api('PUT', '/api/config', patch);
    else saveConfig(applyConfigPatch(loadConfig(), patch));
    return out({ ok: true, key, value }, () => console.log(`${green('✓')} ${key} = ${JSON.stringify(value)}`));
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

async function doctor(): Promise<void> {
  const ok = (m: string) => console.log(`${green('✓')} ${m}`);
  const bad = (m: string, hint?: string) => console.log(`${red('✗')} ${m}${hint ? dim(' - ' + hint) : ''}`);
  const warn = (m: string, hint?: string) => console.log(`${yellow('!')} ${m}${hint ? dim(' - ' + hint) : ''}`);
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.version}`);
  else bad(`Node ${process.version}`, 'SuperAgent needs Node 22.13 or newer');
  const git = await run('git', ['--version']);
  if (git.code === 0) ok(git.stdout.trim());
  else bad('git not found', 'install Git');
  const gh = await run('gh', ['auth', 'status'], { timeoutMs: 20_000 });
  if (gh.code === 0) ok(`GitHub CLI logged in ${dim((gh.stdout + gh.stderr).match(/account (\S+)/)?.[1] ?? '')}`);
  else warn('GitHub CLI not logged in', 'run `gh auth login` to enable GitHub triggers and PRs');
  const found = await detectAgents();
  for (const a of found) {
    if (a.installed) ok(`${a.label} ${a.version}`);
    else warn(`${a.label} not available`, a.error ?? '');
  }
  if (!found.some((a) => a.installed)) bad('No coding agent installed', `install one of: ${AGENT_IDS.join(', ')}`);
  console.log(bold('Skill'));
  printIntegrations();
  const h = await health();
  if (h) ok(`Service running (pid ${h.pid}) at ${baseUrl()}`);
  else warn('Service not running', 'router commands start it automatically');
  const cfg = loadConfig();
  if (!cfg.repos.length) warn('No repos configured', 'superagent repo add <path|owner/repo>');
  for (const r of cfg.repos) {
    if (r.path && !fs.existsSync(r.path)) bad(`Repo ${r.name}: ${r.path} does not exist`);
    else ok(`Repo ${r.name}${r.slug ? ` (${r.slug}, GitHub events: ${r.mode})` : ''}`);
  }
  if (await autostartStatus()) ok('Starts automatically at login');
  else warn('Not starting at login', 'superagent autostart on');
}

async function uninstall(): Promise<void> {
  await stop(true);
  const removed = uninstallIntegrations();
  let autostart = false;
  // The Windows Run key is per user, not per data folder; tests must never remove the real one.
  if (process.env.SUPERAGENT_SKIP_AUTOSTART !== '1') {
    try {
      autostart = await setAutostart(false);
    } catch {
      /* nothing to undo */
    }
  }
  out({ ok: true, removed, autostart }, () => {
    for (const r of removed) console.log(`${green('✓')} Removed ${dim(r)}`);
    console.log(`${green('✓')} SuperAgent stopped and will not start at login.`);
    console.log(dim(`  Your data is still in ${paths.home}. Remove the CLI with: npm uninstall -g @imthegoodboy/superagent`));
  });
}

// ---------- entry ----------

const ROUTER_COMMANDS = new Set(['router', 'events', 'dispatch', 'tell', 'cancel', 'reply', 'ignore', 'follow', 'unfollow', 'remember', 'forget', 'retry', 'archive']);

export async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      agent: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      follow: { type: 'string' },
      reply: { type: 'string' },
      silent: { type: 'boolean' },
      reason: { type: 'string' },
      wait: { type: 'string' },
      take: { type: 'boolean' },
      mermaid: { type: 'boolean' },
      mode: { type: 'string' },
      name: { type: 'string' },
      allow: { type: 'string' },
      all: { type: 'boolean' },
      live: { type: 'boolean', short: 'f' },
      json: { type: 'boolean' },
      foreground: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  asJson = !!v.json;
  const [cmd, ...rest] = positionals;
  if (v.version || cmd === 'version') return console.log(pkgVersion());
  if (v.help || cmd === 'help') return console.log(HELP);
  // Installing the package is the only step a person takes; every command keeps the skill in place
  // for agents installed later. It must never get in the way of the command itself.
  if (cmd !== '__daemon' && cmd !== '__watchdog' && cmd !== 'uninstall') {
    try {
      ensureIntegrations();
    } catch {
      /* best effort */
    }
  }

  // The cases `return someCommand()`; awaiting the whole switch makes their rejections reach the catch.
  const dispatch = async (): Promise<void> => {
    if (cmd && ROUTER_COMMANDS.has(cmd)) refuseInWorker(cmd);
    switch (cmd) {
      case undefined:
        await status();
        if (!asJson) console.log(`\n${dim('Run `superagent help` for all commands.')}`);
        return;
      case '__daemon': {
        const { runDaemon } = await import('../daemon/main.js');
        return runDaemon();
      }
      case '__watchdog': {
        const { runWatchdog } = await import('../daemon/watchdog.js');
        return runWatchdog();
      }
      case 'start':
        return start(!!v.foreground);
      case 'stop':
        return stop();
      case 'restart':
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
            repo: v.repo,
            threads: list(v.follow).map(threadRef),
            reply_thread: v.reply ? threadRef(String(v.reply)) : undefined,
            silent: !!v.silent,
          },
          (r) => {
            console.log(`${green('▶')} Started ${bold(r.worker)} ${dim(`(${r.agent})`)} ${r.title}${r.repo ? dim(` · repo ${r.repo}`) : dim(' · scratch folder')}`);
            if (r.follows.length) console.log(dim(`  follows ${r.follows.join(', ')}: new events there go straight to it`));
            const where = r.reports_to_user ? '' : ` (its reply thread is ${r.reply_thread})`;
            console.log(dim(`  Its result arrives in \`superagent events\`${where}${r.silent ? '; silent: only if it succeeds' : ''}. Keep going meanwhile.`));
          },
        );
      }
      case 'tell':
        return act({ type: 'message_worker', worker: workerRef(rest[0]), text: await textArg(rest.slice(1), 'superagent tell <W#3> "<text>"') }, (r) =>
          console.log(`${green('✓')} Sent to ${r.worker}. It resumes with this message.`),
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
        const rows: any[] = await api('GET', '/api/memory');
        return out(rows, () => {
          if (!rows.length) return console.log(dim('Nothing remembered yet.'));
          for (const m of rows) console.log(`${dim(fit('#' + m.id, 5))} ${m.text} ${dim(ago(m.created_at))}`);
        });
      }
      case 'forget': {
        const n = Number(String(rest[0] ?? '').replace(/^#/, ''));
        if (!Number.isInteger(n) || n <= 0) die('Usage: superagent forget <memory id>');
        await api('DELETE', `/api/memory/${n}`);
        return out({ ok: true }, () => console.log(`${green('✓')} Forgot #${n}`));
      }
      case 'recall': {
        if (!rest.length) die('Usage: superagent recall <T#42|TH#8|W#3> […]');
        const r = await api('GET', `/api/recall?ids=${encodeURIComponent(rest.join(','))}`);
        return out(r, () => console.log(r.text));
      }

      // ---- workers ----
      case 'workers':
      case 'ls':
        return workers(!!v.all);
      case 'logs':
        return logs(rest[0], !!v.live);
      case 'retry': {
        const w = workerRef(rest[0]);
        await api('POST', `/api/workers/${w.slice(2)}/retry`);
        return out({ ok: true, worker: w }, () => console.log(`${green('✓')} Retrying ${w}`));
      }
      case 'archive': {
        const w = workerRef(rest[0]);
        await api('POST', `/api/workers/${w.slice(2)}/archive`);
        return out({ ok: true, worker: w }, () => console.log(`${green('✓')} Archived ${w}`));
      }
      case 'graph':
        return graph(v);
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
          const on = await setAutostart(rest[0] === 'on');
          return out({ ok: true, autostart: on }, () => console.log(`${green('✓')} Autostart ${on ? 'on' : 'off'}`));
        }
        const on = await autostartStatus();
        return out({ autostart: on }, () => console.log(`Autostart is ${on ? 'on' : 'off'}`));
      }
      case 'doctor':
        return doctor();
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
