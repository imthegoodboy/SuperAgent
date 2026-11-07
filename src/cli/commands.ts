import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { AGENT_IDS, applyConfigPatch, loadConfig, publicConfig, saveConfig, type SourceMode } from '../core/config.js';
import { CLI_PATH, ensureDirs, paths, pkgVersion } from '../core/paths.js';
import { duration, sleep } from '../core/util.js';
import { isAlive, killTree, run } from '../agents/process.js';
import { detectAgents } from '../agents/runner.js';
import { autostartStatus, installSkill, openUrl, resolveRepoInput, setAutostart, skillStatus } from '../daemon/system.js';
import { STOP_FLAG, watchdogPid } from '../daemon/watchdog.js';
import { api, baseUrl, events, health, token } from './client.js';

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

function fit(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n);
}

function die(msg: string): never {
  console.error(red('✗ ') + msg);
  process.exit(1);
}

function workerId(s: string | undefined): number {
  const n = Number(String(s ?? '').replace(/^w?#?/i, ''));
  if (!Number.isInteger(n) || n <= 0) die(`Expected a worker id like W3 or 3, got "${s ?? ''}"`);
  return n;
}

const HELP = `${bold('SuperAgent')} ${dim('v' + pkgVersion())} - one always-on agent that runs your coding agents in parallel.

${bold('Usage')}  superagent <command> [options]

${bold('Run it')}
  start                     Start SuperAgent in the background (with its watchdog)
  stop | restart            Stop or restart it
  status                    What's running right now
  open                      Open the app in your browser (or use the desktop app)

${bold('Talk to it')}
  chat                      Interactive chat with SuperAgent
  say <message>             Send one message and print the reply
  run <task>                Start a worker directly
                              --agent claude|codex|opencode|cursor  --repo <name>  --title <text>  --wait

${bold('Tasks')}
  tasks [--all]             List workers
  logs [W3] [-f]            A worker's activity (or the daemon log); -f follows live
  msg <W3> <text>           Send a message to a worker
  cancel <W3>               Stop a worker
  retry <W3>                Run a failed or stopped worker again
  archive <W3>              Remove a finished worker's workspace

${bold('Setup')}
  repo add <path|owner/repo> [--mode mentions|all|off] [--name n] [--agent a] [--allow u1,u2]
  repo list | repo rm <name>
  agents                    Detected coding agents
  config [get <key> | set <key> <value>]
  skill install [--codex]   Install the /superagent skill for Claude Code (or Codex)
  autostart on|off          Start SuperAgent when you log in
  doctor                    Check your setup

${dim('Data lives in ' + paths.home)}`;

// ---------- daemon lifecycle ----------

async function start(foreground: boolean): Promise<void> {
  const h = await health();
  if (h) {
    console.log(`${green('●')} SuperAgent is already running ${dim(`(pid ${h.pid})`)} · ${baseUrl()}`);
    return;
  }
  if (foreground) {
    const { runDaemon } = await import('../daemon/main.js');
    await runDaemon();
    return;
  }
  ensureDirs();
  fs.rmSync(STOP_FLAG, { force: true });
  const child = spawn(process.execPath, [CLI_PATH, '__watchdog'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: paths.home });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const ok = await health(1000);
    if (ok) {
      console.log(`${green('●')} SuperAgent started · ${bold(baseUrl())}`);
      console.log(dim('  Open the app with `superagent open` or the desktop app. Chat in the terminal with `superagent chat`.'));
      return;
    }
  }
  die(`SuperAgent did not start. See ${path.join(paths.logs, 'daemon.log')}`);
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
  if (h && !quiet) console.log(`${dim('●')} SuperAgent stopped`);
  else if (!quiet) console.log(dim('SuperAgent was not running'));
}

async function status(): Promise<void> {
  const h = await health();
  if (!h) {
    console.log(`${dim('●')} SuperAgent is not running. Start it with ${bold('superagent start')}`);
    return;
  }
  const s = await api('GET', '/api/state');
  const c = s.workers.counts as Record<string, number>;
  console.log(`${green('●')} ${bold('SuperAgent')} v${s.version} · pid ${s.pid} · up ${duration(Date.now() - s.startedAt)} · ${baseUrl()}`);
  const r = s.router;
  console.log(
    `  ${dim('Router ')}  ${r.agent}${r.model ? '/' + r.model : ''} · ${r.busy ? cyan('thinking') : 'idle'} · ${r.turns} turns${r.pending ? ` · ${r.pending} pending` : ''}${
      r.lastError ? red(` · last error: ${String(r.lastError).slice(0, 80)}`) : ''
    }`,
  );
  const parts = ['running', 'queued', 'waiting', 'done', 'failed']
    .filter((k) => c[k])
    .map((k) => STATUS_COLOR[k](`${c[k]} ${k}`));
  console.log(`  ${dim('Workers')}  ${parts.join(' · ') || 'none yet'} ${dim(`(max ${s.workers.max} in parallel)`)}`);
  console.log(
    `  ${dim('Agents ')}  ${s.agents.map((a: any) => (a.installed ? `${green('✓')} ${a.id}` : `${red('✗')} ${dim(a.id)}`)).join('  ')}`,
  );
  const gh = s.github;
  console.log(
    `  ${dim('Inputs ')}  GitHub ${gh.enabled ? `${gh.repos} repo${gh.repos === 1 ? '' : 's'}${gh.login ? ` as @${gh.login}` : ''}` : 'off'}${
      gh.lastError ? red(` (${gh.lastError.slice(0, 60)})`) : ''
    } · Telegram ${s.telegram.enabled ? `@${s.telegram.bot ?? '…'}` : 'off'}`,
  );
}

// ---------- talking ----------

function printMessage(m: { role: string; text: string }): void {
  if (m.role === 'user') console.log(`${bold('you')} ${dim('›')} ${m.text}`);
  else if (m.role === 'agent') console.log(`${cyan(bold('superagent'))} ${dim('›')} ${m.text}`);
  else console.log(dim(`  · ${m.text}`));
}

async function chat(): Promise<void> {
  if (!(await health())) await start(false);
  const history: any[] = await api('GET', '/api/messages?limit=12');
  console.log(dim(`Chatting with SuperAgent. Type a message, /tasks to list workers, /exit to quit.\n`));
  for (const m of history) printMessage(m);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${bold('you')} ${dim('›')} ` });
  const above = (fn: () => void) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    fn();
    rl.prompt(true);
  };
  let thinking = false;
  const close = events((ev) => {
    if (ev.type === 'message' && ev.data.role !== 'user') above(() => printMessage(ev.data));
    if (ev.type === 'router' && ev.data.busy !== thinking) {
      thinking = ev.data.busy;
      if (thinking) above(() => console.log(dim('  · thinking…')));
    }
  });
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === '/exit' || text === '/quit') return rl.close();
    if (text === '/tasks') {
      await tasks(false);
      return rl.prompt();
    }
    try {
      await api('POST', '/api/messages', { text });
    } catch (e) {
      console.log(red((e as Error).message));
    }
    rl.prompt();
  });
  rl.on('close', () => {
    close();
    process.exit(0);
  });
}

async function say(text: string): Promise<void> {
  if (!text) die('Usage: superagent say <message>');
  if (!(await health())) await start(false);
  let connected!: () => void;
  const ready = new Promise<void>((r) => (connected = r));
  let sentId = Infinity;
  let finish!: () => void;
  const replied = new Promise<void>((r) => (finish = r));
  const close = events((ev) => {
    if (ev.type === 'hello') connected();
    if (ev.type !== 'message' || ev.data.id <= sentId) return;
    if (ev.data.role === 'agent') {
      printMessage(ev.data);
      finish();
    } else if (ev.data.role === 'system') printMessage(ev.data);
  });
  await Promise.race([ready, sleep(3000)]);
  const { message } = await api('POST', '/api/messages', { text });
  sentId = message.id;
  const timeout = sleep(240_000).then(() => 'timeout');
  const r = await Promise.race([replied, timeout]);
  close();
  if (r === 'timeout') die('No reply within 4 minutes. Check `superagent status`.');
}

async function runTask(task: string, opts: { agent?: string; repo?: string; title?: string; wait?: boolean }): Promise<void> {
  if (!task) die('Usage: superagent run <task> [--agent codex] [--repo name] [--title text] [--wait]');
  if (!(await health())) await start(false);
  let done!: (w: any) => void;
  const finished = new Promise<any>((r) => (done = r));
  let id = 0;
  const close = opts.wait
    ? events((ev) => {
        if (ev.type === 'worker' && ev.data?.id === id && ['done', 'failed', 'waiting', 'stopped'].includes(ev.data.status)) done(ev.data);
        if (ev.type === 'worker_log' && ev.data?.worker_id === id) printLog(ev.data);
      })
    : () => {};
  const w = await api('POST', '/api/workers', { task, agent: opts.agent, repo: opts.repo, title: opts.title });
  id = w.id;
  console.log(`${green('▶')} Started ${bold('W' + w.id)} ${dim(`(${w.agent})`)} ${w.title}`);
  if (!opts.wait) {
    console.log(dim(`  Follow it with: superagent logs W${w.id} -f`));
    return;
  }
  const end = await finished;
  close();
  console.log(`\n${STATUS_COLOR[end.status]?.(bold(end.status)) ?? end.status} ${end.summary ?? end.error ?? ''}`);
  if (end.pr_url) console.log(`PR: ${end.pr_url}`);
  process.exit(end.status === 'done' ? 0 : 1);
}

// ---------- tasks ----------

async function tasks(all: boolean): Promise<void> {
  const list: any[] = await api('GET', `/api/workers${all ? '?archived=1' : ''}`);
  if (!list.length) {
    console.log(dim('No workers yet. Ask for something with `superagent say ...` or `superagent run ...`.'));
    return;
  }
  for (const w of list) {
    const st = (STATUS_COLOR[w.status] ?? ((s: string) => s))(fit(w.status, 8));
    const age = duration(Date.now() - w.created_at);
    console.log(
      `${bold(fit('W' + w.id, 5))} ${st} ${dim(fit(w.agent, 9))} ${fit(w.title, 44)} ${dim(fit(w.repo ?? '-', 14))} ${dim(fit(age, 7))}${w.pr_url ? ' ' + blue(w.pr_url) : ''}`,
    );
  }
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
    if (!fs.existsSync(file)) die('No daemon log yet.');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    console.log(lines.slice(-80).join('\n'));
    return;
  }
  const id = workerId(idArg);
  const rows: any[] = await api('GET', `/api/workers/${id}/logs`);
  rows.forEach(printLog);
  if (!follow) return;
  events((ev) => {
    if (ev.type === 'worker_log' && ev.data?.worker_id === id) printLog(ev.data);
  });
  await new Promise(() => {});
}

// ---------- setup ----------

async function repo(sub: string | undefined, rest: string[], v: Record<string, any>): Promise<void> {
  const running = !!(await health());
  if (sub === 'add') {
    const input = rest[0];
    if (!input) die('Usage: superagent repo add <path|owner/repo> [--mode mentions|all|off]');
    const allowUsers = v.allow ? String(v.allow).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const r = running
      ? await api('POST', '/api/repos', { input, mode: v.mode, name: v.name, agent: v.agent, allowUsers })
      : await (async () => {
          const repoCfg = await resolveRepoInput(input, { mode: v.mode as SourceMode, name: v.name, agent: v.agent, allowUsers });
          const cfg = loadConfig();
          cfg.repos = [...cfg.repos.filter((x) => x.name.toLowerCase() !== repoCfg.name.toLowerCase()), repoCfg];
          saveConfig(cfg);
          return repoCfg;
        })();
    console.log(`${green('✓')} Added ${bold(r.name)}${r.slug ? ` (${r.slug})` : ''}${r.path ? dim(' · ' + r.path) : ''}`);
    if (r.slug) {
      console.log(
        dim(
          `  GitHub events: ${r.mode}${r.mode === 'mentions' ? ` (write "${loadConfig().mention}" in an issue or comment)` : ''} · allowed users: ${r.allowUsers.length ? r.allowUsers.join(', ') : 'anyone'}`,
        ),
      );
    }
    return;
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
    console.log(`${green('✓')} Removed ${name}`);
    return;
  }
  const cfg = loadConfig();
  if (!cfg.repos.length) return console.log(dim('No repos yet. Add one with: superagent repo add <path|owner/repo>'));
  for (const r of cfg.repos) {
    console.log(`${bold(fit(r.name, 18))} ${fit(r.slug ?? 'local only', 30)} ${dim(fit(r.mode, 9))} ${dim(r.path ?? '(cloned on first use)')}`);
  }
}

async function agents(): Promise<void> {
  const list: any[] = (await health()) ? await api('POST', '/api/agents/refresh') : await detectAgents();
  const cfg = loadConfig();
  for (const a of list) {
    const def = a.id === cfg.workers.defaultAgent ? dim(' (default worker)') : '';
    const router = a.id === cfg.router.agent ? dim(' (router)') : '';
    console.log(`${a.installed ? green('✓') : red('✗')} ${bold(fit(a.label, 13))} ${a.installed ? a.version : dim(a.error ?? 'not found')}${def}${router}`);
  }
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
    console.log(dim(paths.config));
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
    console.log(`${green('✓')} ${key} = ${JSON.stringify(value)}`);
    return;
  }
  die('Usage: superagent config [get <key> | set <key> <value>]');
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
  const list = await detectAgents();
  for (const a of list) {
    if (a.installed) ok(`${a.label} ${a.version}`);
    else warn(`${a.label} not available`, a.error ?? '');
  }
  if (!list.some((a) => a.installed)) bad('No coding agent installed', `install one of: ${AGENT_IDS.join(', ')}`);
  const h = await health();
  if (h) ok(`Daemon running (pid ${h.pid}) at ${baseUrl()}`);
  else warn('Daemon not running', 'superagent start');
  const cfg = loadConfig();
  if (!cfg.repos.length) warn('No repos configured', 'superagent repo add <path|owner/repo>');
  for (const r of cfg.repos) {
    if (r.path && !fs.existsSync(r.path)) bad(`Repo ${r.name}: ${r.path} does not exist`);
    else ok(`Repo ${r.name}${r.slug ? ` (${r.slug}, GitHub events: ${r.mode})` : ''}`);
  }
  const skill = skillStatus();
  if (skill.claude) ok('Claude Code skill installed');
  else warn('Claude Code skill not installed', 'superagent skill install');
  if (await autostartStatus()) ok('Starts automatically at login');
  else warn('Not starting at login', 'superagent autostart on');
}

// ---------- entry ----------

export async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      agent: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      mode: { type: 'string' },
      name: { type: 'string' },
      allow: { type: 'string' },
      wait: { type: 'boolean' },
      all: { type: 'boolean' },
      follow: { type: 'boolean', short: 'f' },
      codex: { type: 'boolean' },
      foreground: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (v.version || cmd === 'version') return console.log(pkgVersion());
  if (v.help || cmd === 'help') return console.log(HELP);

  // The cases `return someCommand()`; awaiting the whole switch makes their rejections reach the catch.
  const dispatch = async (): Promise<void> => {
    switch (cmd) {
      case undefined:
        await status();
        console.log(`\n${dim('Run `superagent help` for all commands.')}`);
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
      case 'open':
      case 'ui':
        if (!(await health())) await start(false);
        // The token rides along once; the page stores it and removes it from the address bar.
        openUrl(`${baseUrl()}/?t=${token()}`);
        return console.log(`Opened ${baseUrl()}`);
      case 'chat':
        return chat();
      case 'say':
      case 'ask':
        return say(rest.join(' ').trim());
      case 'run':
        return runTask(rest.join(' ').trim(), {
          agent: v.agent as string | undefined,
          repo: v.repo as string | undefined,
          title: v.title as string | undefined,
          wait: !!v.wait,
        });
      case 'tasks':
      case 'ls':
        return tasks(!!v.all);
      case 'logs':
        return logs(rest[0], !!v.follow);
      case 'msg':
      case 'message': {
        const text = rest.slice(1).join(' ').trim();
        if (!text) die('Usage: superagent msg <W3> <text>');
        await api('POST', `/api/workers/${workerId(rest[0])}/message`, { text });
        return console.log(`${green('✓')} Sent to W${workerId(rest[0])}`);
      }
      case 'cancel':
      case 'kill':
        await api('POST', `/api/workers/${workerId(rest[0])}/stop`);
        return console.log(`${green('✓')} Stopped W${workerId(rest[0])}`);
      case 'retry':
        await api('POST', `/api/workers/${workerId(rest[0])}/retry`);
        return console.log(`${green('✓')} Retrying W${workerId(rest[0])}`);
      case 'archive':
        await api('POST', `/api/workers/${workerId(rest[0])}/archive`);
        return console.log(`${green('✓')} Archived W${workerId(rest[0])}`);
      case 'repo':
      case 'repos':
        return repo(rest[0], rest.slice(1), v);
      case 'agents':
        return agents();
      case 'config':
        return config(rest[0], rest.slice(1));
      case 'skill': {
        if (rest[0] === 'install') {
          const p = installSkill(v.codex ? 'codex' : 'claude');
          return console.log(`${green('✓')} Installed ${dim(p)}\n  Use it in ${v.codex ? 'Codex' : 'Claude Code'}: "/superagent fix the flaky test with codex"`);
        }
        const s = skillStatus();
        return console.log(`Claude Code: ${s.claude ? green('installed') : dim('not installed')} · Codex: ${s.codex ? green('installed') : dim('not installed')}`);
      }
      case 'autostart': {
        if (rest[0] === 'on' || rest[0] === 'off') {
          const on = await setAutostart(rest[0] === 'on');
          return console.log(`${green('✓')} Autostart ${on ? 'on' : 'off'}`);
        }
        return console.log(`Autostart is ${(await autostartStatus()) ? 'on' : 'off'}`);
      }
      case 'doctor':
        return doctor();
      default:
        console.log(HELP);
        die(`Unknown command "${cmd}"`);
    }
  };
  try {
    await dispatch();
  } catch (e) {
    die((e as Error).message);
  }
}
