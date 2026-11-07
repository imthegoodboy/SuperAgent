import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { CLI_PATH, ensureDirs, paths } from '../core/paths.js';
import { extractJsonObject, sleep } from '../core/util.js';
import { adapterFor } from '../agents/adapters.js';
import { killTree } from '../agents/process.js';
import { startRouterRun } from '../agents/runner.js';
import { servicePort } from '../core/instance.js';
import { EXIT_ALREADY_RUNNING, EXIT_PORT_IN_USE } from './main.js';

/*
 * Section 6 of the design: an independent control loop outside the main system.
 * It supervises the daemon process (crash / hang -> restart) and judges task progress
 * (stalled or looping workers -> restart with a nudge; repeated router failures -> fresh session).
 */

export const STOP_FLAG = path.join(paths.run, 'stop.flag');
const WATCHDOG_PID = path.join(paths.run, 'watchdog.pid');

const JUDGE_SYSTEM = `You are the Watchdog of SuperAgent. You check whether a coding agent working on a task is making substantive progress.
Answer with JSON only: {"verdict":"progress|looping|drifting|unclear","note":"one sentence of guidance for the agent if not progressing"}.
- looping: repeating the same failing commands or edits without new information.
- drifting: working on things unrelated to the task.
- progress: steadily moving toward the goal (installing, editing, testing, fixing) even if slowly.`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['progress', 'looping', 'drifting', 'unclear'] }, note: { type: 'string' } },
  required: ['verdict'],
};

function wlog(...args: unknown[]): void {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [watchdog] ${args.map(String).join(' ')}\n`;
  fs.appendFileSync(path.join(paths.logs, 'watchdog.log'), line);
}

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {
    /* no file yet */
  }
}

function token(): string {
  try {
    return fs.readFileSync(paths.token, 'utf8').trim();
  } catch {
    return '';
  }
}

async function call(method: string, p: string, body?: unknown, timeoutMs = 8000): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${servicePort()}${p}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return res.json();
}

async function judge(worker: { title: string; task: string; logs: string[] }): Promise<{ verdict: string; note: string } | null> {
  const cfg = loadConfig();
  const adapter = adapterFor(cfg.router.agent) ?? adapterFor('claude');
  if (!adapter) return null;
  const dir = path.join(paths.home, 'watchdog');
  fs.mkdirSync(dir, { recursive: true });
  const schemaPath = path.join(dir, 'schema.json');
  fs.writeFileSync(schemaPath, JSON.stringify(JUDGE_SCHEMA));
  const prompt = `Task: ${worker.title}\n${worker.task}\n\nRecent activity (oldest first):\n${worker.logs.join('\n')}`;
  const r = await startRouterRun(
    adapter,
    { cwd: dir, prompt, session: null, model: cfg.router.model, system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA, schemaPath },
    120_000,
  ).done;
  const j = r.error ? null : extractJsonObject(r.finalText);
  return j?.verdict ? { verdict: String(j.verdict), note: String(j.note ?? '') } : null;
}

export async function runWatchdog(): Promise<void> {
  ensureDirs();
  fs.writeFileSync(WATCHDOG_PID, String(process.pid));
  fs.rmSync(STOP_FLAG, { force: true });
  const daemonLog = path.join(paths.logs, 'daemon.log');
  rotate(daemonLog);
  rotate(path.join(paths.logs, 'watchdog.log'));
  wlog(`started (pid ${process.pid})`);

  let child: ChildProcess | null = null;
  let crashes: number[] = [];
  let notice: string | null = null;
  let healthFailures = 0;
  const lastJudged = new Map<number, number>();
  const stalledNudged = new Map<number, number>();

  const finish = () => {
    wlog('stopping');
    fs.rmSync(WATCHDOG_PID, { force: true });
    fs.rmSync(STOP_FLAG, { force: true });
    process.exit(0);
  };

  const spawnDaemon = () => {
    const fd = fs.openSync(daemonLog, 'a');
    child = spawn(process.execPath, [CLI_PATH, '__daemon'], { stdio: ['ignore', fd, fd], windowsHide: true, env: process.env });
    wlog(`daemon started (pid ${child.pid})`);
    child.on('exit', (code) => {
      fs.closeSync(fd);
      child = null;
      if (fs.existsSync(STOP_FLAG)) return finish();
      if (code === EXIT_PORT_IN_USE || code === EXIT_ALREADY_RUNNING) {
        wlog(code === EXIT_ALREADY_RUNNING ? 'SuperAgent already runs for this data folder; this watchdog is not needed' : 'daemon could not bind its port; another instance is probably running');
        return finish();
      }
      const now = Date.now();
      crashes = crashes.filter((t) => now - t < 10 * 60_000);
      crashes.push(now);
      const delay = Math.min(60_000, 1000 * 2 ** (crashes.length - 1));
      wlog(`daemon exited with code ${code}; restarting in ${delay}ms`);
      notice = `The daemon exited unexpectedly (code ${code}) and was restarted automatically.`;
      setTimeout(spawnDaemon, delay);
    });
  };

  process.on('SIGINT', () => {
    fs.writeFileSync(STOP_FLAG, '1');
    if (child) killTree(child.pid);
    else finish();
  });
  process.on('SIGTERM', () => {
    fs.writeFileSync(STOP_FLAG, '1');
    if (child) killTree(child.pid);
    else finish();
  });

  spawnDaemon();

  // Liveness: is the daemon answering?
  void (async () => {
    for (;;) {
      await sleep(15_000);
      if (fs.existsSync(STOP_FLAG) && !child) finish();
      if (!child) continue;
      try {
        await call('GET', '/api/health', undefined, 5000);
        healthFailures = 0;
        if (notice) {
          await call('POST', '/api/watchdog/action', { type: 'event', level: 'error', note: notice }).catch(() => {});
          notice = null;
        }
      } catch {
        healthFailures++;
        if (healthFailures >= 4) {
          wlog('daemon is not responding; killing it so it restarts');
          notice = 'The daemon stopped responding and was restarted automatically.';
          healthFailures = 0;
          killTree((child as ChildProcess | null)?.pid);
        }
      }
    }
  })();

  // Progress: are workers and the router actually getting somewhere?
  for (;;) {
    await sleep(60_000);
    const cfg = loadConfig();
    if (!cfg.watchdog.enabled || !child) continue;
    let snap: any;
    try {
      snap = await call('GET', '/api/watchdog/snapshot');
    } catch {
      continue;
    }
    const now = Date.now();
    for (const w of snap.running ?? []) {
      if (!w.active) continue;
      const idleMin = (now - w.last_activity_at) / 60_000;
      if (idleMin >= cfg.workers.stallMinutes && now - (stalledNudged.get(w.id) ?? 0) > cfg.workers.stallMinutes * 60_000) {
        stalledNudged.set(w.id, now);
        wlog(`W#${w.id} silent for ${Math.round(idleMin)} min; restarting its run`);
        await call('POST', '/api/watchdog/action', {
          type: 'restart_run',
          worker: w.id,
          note: `Watchdog: your previous run produced no output for ${Math.round(idleMin)} minutes and was restarted. If a command was hanging (a dev server, an interactive prompt, a watch mode), do not run it again in the foreground; continue the task another way.`,
        }).catch(() => {});
        continue;
      }
      const runMin = (now - w.run_started_at) / 60_000;
      if (cfg.watchdog.llmChecks && runMin >= cfg.watchdog.checkMinutes && now - (lastJudged.get(w.id) ?? 0) >= cfg.watchdog.checkMinutes * 60_000) {
        lastJudged.set(w.id, now);
        const verdict = await judge(w).catch(() => null);
        if (!verdict) continue;
        await call('POST', '/api/watchdog/action', {
          type: 'event',
          level: verdict.verdict === 'progress' ? 'info' : 'warn',
          worker: w.id,
          note: `Progress check on W#${w.id}: ${verdict.verdict}${verdict.note ? ` · ${verdict.note}` : ''}`,
        }).catch(() => {});
        if (verdict.verdict === 'looping' || verdict.verdict === 'drifting') {
          wlog(`W#${w.id} judged ${verdict.verdict}; restarting with guidance`);
          await call('POST', '/api/watchdog/action', {
            type: 'restart_run',
            worker: w.id,
            note: `Watchdog: you appear to be ${verdict.verdict}. ${verdict.note} Step back, re-read the task, and continue with a different approach.`,
          }).catch(() => {});
        }
      }
    }
    const r = snap.router;
    if (r && r.consecutiveErrors >= 3 && !r.busy) {
      wlog(`router failed ${r.consecutiveErrors} times in a row; resetting its session`);
      await call('POST', '/api/watchdog/action', { type: 'reset_router', note: `${r.consecutiveErrors} consecutive errors: ${String(r.lastError ?? '').slice(0, 200)}` }).catch(
        () => {},
      );
    }
  }
}

export function watchdogPid(): number | null {
  try {
    return Number(fs.readFileSync(WATCHDOG_PID, 'utf8')) || null;
  } catch {
    return null;
  }
}
