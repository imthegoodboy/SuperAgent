// End-to-end: real daemon process, real HTTP API and CLI, real router/worker pipeline,
// with a mock agent standing in for Claude Code so no LLM calls are made.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-e2e-'));
const port = 17000 + Math.floor(Math.random() * 2000);
// The CLI identifies its agent session; tests pin one so a real CLAUDE_CODE_SESSION_ID can't leak in.
const env = { ...process.env, SUPERAGENT_HOME: home, SUPERAGENT_SKIP_INTEGRATIONS: '1', SUPERAGENT_SESSION: 'cli-session', NO_COLOR: '1' };
let daemon;
let token;

fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    port,
    router: { agent: 'mock', model: '' },
    workers: { defaultAgent: 'mock', maxConcurrent: 2 },
    github: { enabled: false },
    watchdog: { enabled: false },
  }),
);

/** An API call, optionally as a given agent session (what the CLI sends). */
async function call(method, p, body, session) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(session ? { 'x-superagent-session': session } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: res.status });
  return j;
}

/** One router action, as an attached agent sends it. */
async function act(action, session) {
  const { results } = await call('POST', '/api/router/actions', { actions: [action] }, session);
  return results[0];
}

const sa = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });

// Generous limit: spawning agent processes is slow on loaded CI runners and low-memory machines.
async function until(fn, ms = 60000, describe) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting${describe ? `: ${JSON.stringify(await describe(), null, 1).slice(0, 3000)}` : ''}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const worker = async (ref) => (await call('GET', `/api/workers/${ref.replace('W#', '')}`)).worker;

before(async () => {
  daemon = spawn(process.execPath, [cli, '__daemon'], {
    env: { ...env, SUPERAGENT_MOCK: '1', MOCK_DELAY_MS: '30' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  daemon.stdout.on('data', (c) => (out += c));
  daemon.stderr.on('data', (c) => (out += c));
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      return false;
    }
  }).catch(() => {
    throw new Error('daemon did not start:\n' + out);
  });
  token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
});

after(async () => {
  // Windows keeps the database locked until the daemon has really exited.
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((r) => daemon.once('exit', r));
    daemon.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* a worker process can still hold a file for a moment; it is a temp folder */
  }
});

test('rejects calls without the token, and foreign Host / Origin; serves no pages', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  const evil = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  // DNS rebinding: a page on another domain that resolves to 127.0.0.1 sends its own Host header.
  const status = await new Promise((resolve, reject) =>
    http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode)).on('error', reject),
  );
  assert.equal(status, 421, 'foreign Host header is refused');
  const page = await fetch(`http://127.0.0.1:${port}/?t=x`);
  assert.equal(page.status, 404);
  assert.ok(!(await page.text()).includes(token));
});

test('attached agent: dispatch returns at once, the report arrives as an event, the background router stays out', async () => {
  const attach = await call('POST', '/api/router/attach', { take: true });
  assert.match(attach.text, /You are now the router/);
  assert.match(attach.text, /\[CONTEXT\]/);
  assert.ok((await call('GET', '/api/state')).router.attached, 'state shows the attached session');

  const d = await act({ type: 'dispatch', task: 'write the mock file', title: 'Write the mock file' });
  assert.equal(d.ok, true, d.error);
  assert.match(d.worker, /^W#\d+$/);
  assert.equal(d.reply_thread, 'TH#1', 'reports to the local thread by default');

  let report;
  await until(async () => {
    const ev = await call('GET', '/api/router/events?wait=5');
    report = ev.events.find((e) => e.source === 'worker' && e.worker === d.worker);
    return report;
  });
  assert.match(report.text, /Mock finished/);
  const w = await worker(d.worker);
  assert.equal(w.status, 'done');
  assert.ok(fs.existsSync(path.join(w.cwd, 'mock-output.txt')), 'worker wrote into its own workspace');

  const { turns } = await call('GET', '/api/router');
  assert.ok(turns.length && turns.every((t) => t.session === 'attached agent'), 'no background router turn ran while attached');
  const recorded = turns.find((t) => JSON.parse(t.actions || '[]').some((a) => a.type === 'dispatch'));
  assert.ok(recorded, 'the agent’s actions are recorded on its turn');
});

test('actions validate input and report what they did', async () => {
  await call('POST', '/api/router/attach', { take: true });
  assert.match((await act({ type: 'dispatch', task: 'x', agent: 'nope' })).error, /not available/);
  assert.match((await act({ type: 'dispatch', task: 'x', repo: 'nope' })).error, /unknown repo/);
  assert.match((await act({ type: 'reply', thread: 'TH#999', text: 'hi' })).error, /unknown thread/);
  assert.match((await act({ type: 'message_worker', worker: 'W#999', text: 'hi' })).error, /unknown worker/);
  const mem = await act({ type: 'remember', text: 'The user prefers Postgres' });
  assert.ok(mem.ok && mem.memory > 0);
  const rec = await act({ type: 'recall', ids: ['W#1', 'TH#1'] });
  assert.match(rec.text, /W#1 "Write the mock file"/);
  assert.match((await act({ type: 'dispatch', task: 'x', threads: ['TH#999'] })).error, /unknown thread TH#999/);
  assert.match((await act({ type: 'dispatch', task: 'x', threads: ['TH#1'] })).error, /is a conversation/, 'chats cannot be followed');
  await assert.rejects(call('POST', '/api/router/actions', { actions: [{ type: 'rm -rf' }] }), /unknown action type/);
  const again = await call('POST', '/api/router/attach', {}).catch((e) => e);
  assert.equal(again.status, 409, 'a second session cannot attach without --take');
});

test('without an attached agent the background router handles events, and the next attach hears about it', async () => {
  await call('POST', '/api/router/attach', { take: true });
  await call('GET', '/api/router/events');
  const d = await act({ type: 'dispatch', task: 'background job', title: 'Background job' });
  await call('POST', '/api/router/detach');
  assert.equal((await call('GET', '/api/state')).router.attached, null);
  await until(async () => (await call('GET', '/api/router')).turns.some((t) => t.session !== 'attached agent' && /finished/.test(t.actions ?? '')));
  const attach = await call('POST', '/api/router/attach', {});
  assert.match(attach.text, /WHILE YOU WERE AWAY/);
  assert.match(attach.text, new RegExp(`background router told the user.*${d.worker} finished`));
  // N8: what it saw and did, in numbers, instead of "handled 155 batches".
  assert.match(attach.text, /the background router was in charge: it looked at 1 event \(worker report\) and took reply; \d+ more were filtered in code\)/);
});

test('the lease belongs to one agent session; a replaced session is told so', async () => {
  await call('POST', '/api/router/attach', { take: true }, 'A');
  await call('POST', '/api/router/attach', {}, 'A'); // the same session may attach again without --take
  const other = await call('GET', '/api/router/events', undefined, 'B').catch((e) => e);
  assert.equal(other.status, 409);
  assert.match(other.message, /Another agent session is the router/);
  assert.equal((await call('POST', '/api/router/attach', {}, 'B').catch((e) => e)).status, 409);
  await call('POST', '/api/router/attach', { take: true }, 'B');
  const old = await call('POST', '/api/router/actions', { actions: [{ type: 'remember', text: 'x' }] }, 'A').catch((e) => e);
  assert.equal(old.status, 409, 'the replaced session cannot act');
  await call('POST', '/api/router/detach', {}, 'B');
});

test('detaching ends a waiting `events` call instead of handing out events twice', async () => {
  await call('POST', '/api/router/attach', { take: true }, 'A');
  await call('GET', '/api/router/events', undefined, 'A');
  const started = Date.now();
  const poll = call('GET', '/api/router/events?wait=60', undefined, 'A').catch((e) => e);
  await new Promise((r) => setTimeout(r, 300));
  await call('POST', '/api/router/detach', {}, 'A');
  assert.equal((await poll).status, 409, 'the waiting poll ends right away');
  assert.ok(Date.now() - started < 5_000);
  const d = await act({ type: 'dispatch', task: 'after detach', title: 'After detach' }, 'C');
  await call('POST', '/api/router/detach', {}, 'C');
  await until(async () => (await call('GET', '/api/router')).turns.some((t) => t.session !== 'attached agent' && t.input.includes(`${d.worker} (`)));
  const handled = (await call('GET', '/api/router')).turns.filter((t) => t.input.includes(`REPORT · ${d.worker} (`));
  assert.equal(handled.length, 1, 'the report was handled exactly once');
});

test('an agent whose first command after a lapse is an action still hears what happened', async () => {
  await call('POST', '/api/router/attach', { take: true });
  const d = await act({ type: 'dispatch', task: 'lapse job', title: 'Lapse job' });
  await call('POST', '/api/router/detach');
  await until(async () => (await call('GET', '/api/router')).turns.some((t) => t.session !== 'attached agent' && t.input.includes(`${d.worker} (`)));
  const { away_pending } = await call('POST', '/api/router/actions', { actions: [{ type: 'remember', text: 'back again' }] });
  assert.equal(away_pending, true);
  const ev = await call('GET', '/api/router/events');
  assert.match(ev.away ?? '', new RegExp(`${d.worker} finished`));
  assert.equal((await call('GET', '/api/router/events')).away, null, 'told once');
});

test('the lease runs out and the background router takes over by itself', async () => {
  await call('PUT', '/api/config', { router: { leaseMinutes: 0.02 } });
  try {
    await call('POST', '/api/router/attach', { take: true });
    await act({ type: 'dispatch', task: 'lease job', title: 'Lease job' });
    await until(async () => (await call('GET', '/api/state')).router.attached === null, 20000);
    await until(async () => (await call('GET', '/api/router')).turns.some((t) => t.session !== 'attached agent' && /Lease job|lease job/.test(t.input)));
  } finally {
    await call('PUT', '/api/config', { router: { leaseMinutes: 15 } });
  }
});

test('events a vanished session never acted on go back to the background router', async () => {
  await call('PUT', '/api/config', { router: { leaseMinutes: 0.02 } });
  try {
    await call('POST', '/api/router/attach', { take: true });
    await call('GET', '/api/router/events');
    // An event from outside (here: a watchdog alert) is delivered to the session, which then goes quiet.
    await call('POST', '/api/watchdog/action', { type: 'event', level: 'info', note: 'warm-up' });
    const d = await act({ type: 'dispatch', task: 'victim job', title: 'Victim job' });
    await call('POST', '/api/watchdog/action', { type: 'stop_worker', worker: d.worker.slice(2), note: 'looping on a dev server' });
    const ev = await call('GET', '/api/router/events');
    assert.ok(ev.events.some((e) => e.source === 'watchdog'), 'the alert reached the session');
    await until(async () => (await call('GET', '/api/router')).turns.some((t) => t.session !== 'attached agent' && /looping on a dev server/.test(t.input)), 20000);
  } finally {
    await call('PUT', '/api/config', { router: { leaseMinutes: 15 } });
  }
});

test('a silent task that does not succeed is not announced', async () => {
  await call('POST', '/api/router/attach', { take: true });
  await call('GET', '/api/router/events');
  const d = await act({ type: 'dispatch', task: 'ASK: speculative fix', silent: true });
  await until(async () => (await worker(d.worker)).status === 'waiting');
  const ev = await call('GET', '/api/router/events');
  assert.ok(!ev.events.some((e) => e.worker === d.worker), 'no report for the attached agent');
  const { triggers } = await call('GET', '/api/triggers?limit=20');
  assert.ok(triggers.some((t) => t.source === 'worker' && t.decision === 'dropped' && /silent task ended needs_input/.test(t.reason)), 'kept in the activity log');
});

test('a worker in a git repo runs in its own worktree and branch', async () => {
  const repoDir = path.join(home, 'demo-repo');
  fs.mkdirSync(repoDir);
  const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  await call('PUT', '/api/config', { repos: [{ name: 'demo', path: repoDir, mode: 'off' }] });
  const d = await act({ type: 'dispatch', task: 'touch a file', repo: 'demo' });
  assert.equal(d.repo, 'demo');
  const done = await until(async () => {
    const x = await worker(d.worker);
    return x.status === 'done' ? x : null;
  });
  assert.match(done.branch, /^superagent\/w\d+-touch-a-file$/);
  assert.notEqual(path.resolve(done.cwd), path.resolve(repoDir));
  assert.ok(fs.existsSync(path.join(done.cwd, 'mock-output.txt')));
  assert.ok(!fs.existsSync(path.join(repoDir, 'mock-output.txt')), 'main checkout untouched');
  await call('POST', `/api/workers/${done.id}/archive`);
  assert.ok(!fs.existsSync(done.cwd), 'archive removes the worktree');
});

test('a worker that needs input waits, and its question is on the worker', async () => {
  const d = await act({ type: 'dispatch', task: 'ASK: set up storage' });
  const w = await until(async () => {
    const x = await worker(d.worker);
    return x.status === 'waiting' ? x : null;
  });
  assert.match(w.summary, /Which database should I use\?/);
});

test('`tell` resumes a finished worker with its memory (pass-through inbox)', async () => {
  const d = await act({ type: 'dispatch', task: 'first job' });
  await until(async () => (await worker(d.worker)).status === 'done');
  assert.equal((await act({ type: 'message_worker', worker: d.worker, text: 'one more thing' })).ok, true);
  const detail = await until(async () => {
    const x = await call('GET', `/api/workers/${d.worker.slice(2)}`);
    return x.runs.length === 2 && x.worker.status === 'done' ? x : null;
  });
  assert.match(detail.runs[1].prompt, /one more thing/);
});

test('`tell --now` interrupts a running worker and resumes it with the message', async () => {
  await call('POST', '/api/router/attach', { take: true });
  const d = await act({ type: 'dispatch', task: 'SLOW: a long job', title: 'Long job' });
  const id = d.worker.slice(2);
  await until(async () => (await call('GET', `/api/workers/${id}`)).logs.some((l) => l.kind === 'tool'));
  const r = await act({ type: 'message_worker', worker: d.worker, text: 'change of plan: wrap up now', now: true });
  assert.equal(r.interrupted, true);
  const detail = await until(async () => {
    const x = await call('GET', `/api/workers/${id}`);
    return x.runs.length === 2 && x.worker.status === 'done' ? x : null;
  });
  assert.equal(detail.runs[0].status, 'restarted');
  assert.match(detail.runs[1].prompt, /change of plan: wrap up now/);
  assert.ok(detail.logs.some((l) => l.text === 'Run restarted by the router'));
  const later = await act({ type: 'message_worker', worker: d.worker, text: 'one more detail', now: true });
  assert.equal(later.interrupted, false, 'nothing to interrupt: it is simply queued');
});

test('B1: a worker whose setup fails does not loop when it gets a message', async () => {
  await call('POST', '/api/router/attach', { take: true });
  const cfg = await call('GET', '/api/config');
  await call('PUT', '/api/config', { repos: [...cfg.repos, { name: 'gone', path: path.join(home, 'no-such-folder'), mode: 'off' }] });
  const d = await act({ type: 'dispatch', task: 'work in a repo that moved', repo: 'gone' });
  await until(async () => (await worker(d.worker)).status === 'failed');
  await act({ type: 'message_worker', worker: d.worker, text: 'try again' });
  await new Promise((r) => setTimeout(r, 1500));
  const { logs } = await call('GET', `/api/workers/${d.worker.slice(2)}`);
  const starts = logs.filter((l) => l.kind === 'error').length;
  assert.ok(starts <= 2, `${starts} failed starts: it must not restart in a loop`);
  assert.ok(logs.some((l) => /not delivered because the worker could not start/.test(l.text)));
  assert.ok((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 'the service still answers');
});

test('B7: dispatch says when a worker is only queued; recall fails for unknown ids', async () => {
  await call('POST', '/api/router/attach', { take: true });
  const a = await act({ type: 'dispatch', task: 'SLOW: one', title: 'Slow one' });
  const b = await act({ type: 'dispatch', task: 'SLOW: two', title: 'Slow two' });
  const c = await act({ type: 'dispatch', task: 'third', title: 'Third' });
  assert.equal(c.status, 'queued', 'both slots are busy');
  assert.equal(c.max, 2);
  assert.equal(c.waiting_for, 'slot');
  assert.match(c.waiting_detail, /2\/2 slots busy/);
  for (const w of [a, b, c]) await act({ type: 'stop_worker', worker: w.worker });
  const r = sa(['recall', 'W#999']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not found: W#999/);
});

test('B9: a take-over hands the previous session’s unhandled events on', async () => {
  await call('POST', '/api/router/attach', { take: true }, 'old');
  await call('GET', '/api/router/events', undefined, 'old');
  const ws = (await call('GET', '/api/workers')).find((w) => w.status === 'stopped');
  await call('POST', '/api/watchdog/action', { type: 'stop_worker', worker: ws.id, note: 'handover check' });
  const given = (await call('GET', '/api/router/events', undefined, 'old')).events.find((e) => e.source === 'watchdog');
  assert.ok(given, 'the old session got the alert');
  await call('POST', '/api/router/attach', { take: true }, 'new');
  const ev = await call('GET', '/api/router/events', undefined, 'new');
  assert.ok(ev.events.some((e) => e.id === given.id), 'the new session gets it again');
  await call('POST', '/api/router/detach', {}, 'new');
});

test('B5/B6: the CLI validates settings and never eats text that looks like an option', async () => {
  const bad = sa(['config', 'set', 'workers.maxConcurrent', '0']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /workers.maxConcurrent must be a whole number from 1 to 16/);
  assert.match(sa(['config', 'set', 'nonsense.key', '5']).stderr, /Unknown setting: nonsense/);
  const typo = sa(['workers', '--agnet', 'codex']);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /Unknown option '--agnet'/);
  assert.equal(sa(['remember', '--json output is easier to parse']).status, 0);
  assert.equal(sa(['remember', '--', '-h', 'prints', 'the', 'help']).status, 0);
  const mem = sa(['memory']).stdout;
  assert.match(mem, /--json output is easier to parse/);
  assert.match(mem, /-h prints the help/);
});

test('B2: changing the port while running keeps the CLI connected, and a second service is refused', async () => {
  const moved = sa(['config', 'set', 'port', String(port + 1)]);
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /keeps its port until `superagent restart`/);
  const st = sa(['status']);
  assert.match(st.stdout, /SuperAgent v/, 'the CLI still finds the running service');
  const second = spawnSync(process.execPath, [cli, '__daemon'], { env: { ...env, SUPERAGENT_MOCK: '1' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(second.status, 4, 'a second service for the same data folder exits');
  assert.match(second.stdout + second.stderr, /already runs for this data folder/);
  assert.equal(sa(['config', 'set', 'port', String(port)]).status, 0);
});

test('--base starts a worker from another branch', async () => {
  const repoDir = path.join(home, 'based-repo');
  fs.mkdirSync(repoDir);
  const git = (...a) => execFileSync('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', 'feature');
  git('commit', '-q', '--allow-empty', '-m', 'feature work');
  git('checkout', '-q', 'main');
  const cfg = await call('GET', '/api/config');
  await call('PUT', '/api/config', { repos: [...cfg.repos, { name: 'based', path: repoDir, mode: 'off' }] });
  await call('POST', '/api/router/attach', { take: true });
  const d = await act({ type: 'dispatch', task: 'continue the feature', repo: 'based', base: 'feature' });
  const w = await until(async () => {
    const x = await worker(d.worker);
    return x.status === 'done' ? x : null;
  });
  assert.equal(w.base, 'feature');
  assert.equal(git('rev-parse', w.branch), git('rev-parse', 'feature'), 'the worker branch starts at the feature branch');
  // N3: a wrong branch is refused at dispatch, not minutes later when the worker starts.
  const before = (await call('GET', '/api/workers')).length;
  const wrong = await act({ type: 'dispatch', task: 'x', repo: 'based', base: 'no-such-branch' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /base "no-such-branch" is not a branch in based/);
  assert.equal((await call('GET', '/api/workers')).length, before, 'no worker was created');
});

test('review fixes: --base needs a repo, unicode folders, option values that start with "-"', async () => {
  await call('POST', '/api/router/attach', { take: true });
  const before = (await call('GET', '/api/workers')).length;
  assert.match((await act({ type: 'dispatch', task: 'x', base: 'feature' })).error, /--base needs a repository/);
  assert.equal((await call('GET', '/api/workers')).length, before, 'no worker was created');
  const hindi = path.join(home, 'परियोजना');
  fs.mkdirSync(hindi);
  const r = spawnSync(process.execPath, [cli, 'workers'], { env, cwd: hindi, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sa(['router', 'attach', '--take']).status, 0);
  const t = sa(['dispatch', 'a task', '--title', '-- minus sign first', '--json']);
  assert.equal(JSON.parse(t.stdout).title, '-- minus sign first');
});

test('cleanup archives finished workers', async () => {
  const r = sa(['cleanup', '--days', '0']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Archived W#/);
  assert.ok(!(await call('GET', '/api/workers')).some((w) => ['done', 'failed', 'stopped'].includes(w.status)));
});

test('the CLI drives the router: attach, dispatch, events, graph, recall', async () => {
  const attach = sa(['router', 'attach', '--take']);
  assert.equal(attach.status, 0, attach.stderr);
  assert.match(attach.stdout, /You are now the router/);

  const d = sa(['dispatch', 'Make a CLI file', '--title', 'CLI file', '--json']);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  const started = JSON.parse(d.stdout);
  assert.equal(started.ok, true);

  await until(async () => (await worker(started.worker)).status === 'done');
  const ev = sa(['events', '--json']);
  assert.equal(ev.status, 0, ev.stderr);
  assert.ok(JSON.parse(ev.stdout).events.some((e) => e.worker === started.worker), 'the report is in the CLI events');

  const g = sa(['graph']);
  assert.match(g.stdout, /^Router: attached agent session/m);
  assert.match(g.stdout, new RegExp(`${started.worker} Mock Agent · done · "CLI file"`));
  assert.match(sa(['graph', '--mermaid']).stdout, /^flowchart LR/);
  assert.match(sa(['recall', started.worker]).stdout, /CLI file/);
  assert.match(sa(['workers']).stdout, new RegExp(started.worker));

  const piped = spawnSync(process.execPath, [cli, 'remember', '-'], { env, input: 'Deploys happen on Fridays\n', encoding: 'utf8' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(sa(['memory']).stdout, /Deploys happen on Fridays/);

  const bad = sa(['dispatch', 'x', '--agent', 'nope']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not available/);
});

test('`--repo .` adds the project on first use, and `diff` shows what the worker changed', async () => {
  const dir = path.join(home, 'here-repo');
  fs.mkdirSync(dir);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  const here = (task) => spawnSync(process.execPath, [cli, 'dispatch', task, '--repo', '.', '--json'], { env, cwd: dir, encoding: 'utf8' });
  const first = here('touch a file here');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stderr, /Added repository here-repo/);
  const started = JSON.parse(first.stdout);
  assert.equal(started.repo, 'here-repo');
  const second = here('another job here');
  assert.equal(JSON.parse(second.stdout).repo, 'here-repo');
  assert.doesNotMatch(second.stderr, /Added repository/, 'added once');
  assert.equal((await call('GET', '/api/config')).repos.filter((r) => r.name.startsWith('here-repo')).length, 1);

  await until(async () => (await worker(started.worker)).status === 'done');
  const d = sa(['diff', started.worker]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /on superagent\/w\d+-touch-a-file-here \(from main\)/);
  assert.match(d.stdout, /Not committed:[\s\S]*mock-output\.txt/);
  const patch = sa(['diff', started.worker, '--patch']);
  assert.ok(patch.stdout.includes('--- new file: mock-output.txt\nmock agent was here'), 'new files are part of the patch');
  const ev = JSON.parse(sa(['events', '--json']).stdout);
  const n = started.worker.slice(2);
  assert.ok(ev.text.includes(`branch superagent/w${n}-touch-a-file-here in here-repo (no PR; \`superagent diff ${started.worker}\`)`), ev.text);
});

test('the Claude Code hook tells the router session what is waiting, and nobody else', async () => {
  await call('POST', '/api/router/attach', { take: true }, 'hook-session');
  await call('GET', '/api/router/events', undefined, 'hook-session');
  const d = await act({ type: 'dispatch', task: 'hook job', title: 'Hook job' }, 'hook-session');
  await until(async () => (await worker(d.worker)).status === 'done');
  const hook = (session) => spawnSync(process.execPath, [cli, 'hook', 'prompt'], { env: { ...env, SUPERAGENT_SESSION: '' }, input: JSON.stringify({ session_id: session, prompt: 'hi' }), encoding: 'utf8' });
  const mine = hook('hook-session');
  assert.equal(mine.status, 0, mine.stderr);
  assert.match(mine.stdout, /^\[SuperAgent\] You are the router and 1 event is waiting/);
  assert.ok(mine.stdout.includes(`REPORT · ${d.worker} (Mock Agent) "Hook job"`), mine.stdout);
  assert.equal(hook('another-session').stdout, '', 'other sessions hear nothing');
  const asJson = spawnSync(process.execPath, [cli, 'hook', 'prompt', '--json'], { env: { ...env, SUPERAGENT_SESSION: '' }, input: JSON.stringify({ session_id: 'another-session' }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(asJson.stdout).notice, null, '--json always prints JSON');
  const ev = await call('GET', '/api/router/events', undefined, 'hook-session');
  assert.ok(ev.events.some((e) => e.worker === d.worker), 'the hook only peeks; events still hands it out');
  assert.equal(hook('hook-session').stdout, '', 'nothing left to tell');
  await call('POST', '/api/router/detach', {}, 'hook-session');
});

test('workers cannot use router commands', () => {
  const r = sa(['dispatch', 'spawn another worker'], { SUPERAGENT_WORKER: 'W#1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /You are SuperAgent worker W#1/);
  assert.equal(sa(['stop'], { SUPERAGENT_WORKER: 'W#1' }).status, 1, 'a worker cannot stop the service');
  assert.equal(sa(['config', 'set', 'workers.maxConcurrent', '9'], { SUPERAGENT_WORKER: 'W#1' }).status, 1);
  assert.equal(sa(['merge', 'W#1'], { SUPERAGENT_WORKER: 'W#1' }).status, 1, 'a worker cannot merge branches');
  assert.equal(sa(['workers'], { SUPERAGENT_WORKER: 'W#1' }).status, 0, 'read-only commands still work');
});

test('`superagent claude` opens Claude Code as the router, with no editing tools', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-fake-claude-'));
  const script = 'console.log(JSON.stringify(process.argv.slice(2)));\n';
  if (process.platform === 'win32') {
    // What npm writes for a global CLI: SuperAgent unwraps it and runs the script with node directly.
    fs.writeFileSync(path.join(bin, 'fake-claude.js'), script);
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%dp0%\\fake-claude.js" %*\r\n');
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  }
  const p = `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path}`;
  const r = sa(['claude', 'fix', 'the', 'login', 'bug'], { PATH: p, Path: p });
  fs.rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const args = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(args.slice(0, 2), ['--tools', 'Bash,Skill'], 'only the shell and skills');
  assert.deepEqual(args.slice(2, 6), ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit'], 'editing denied even if settings allow it');
  assert.ok(args.includes('--strict-mcp-config'), 'no MCP server can add tools back');
  const allow = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(allow + 1, allow + 3), ['Bash(superagent *)', 'Bash(superagent)']);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /router of SuperAgent/);
  assert.match(args.at(-1), /then handle this: fix the login bug$/);
});


/** A local repo with one commit on main, configured under `name`. */
async function localRepo(name) {
  const dir = path.join(home, `${name}-repo`);
  fs.mkdirSync(dir);
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const cfg = await call('GET', '/api/config');
  await call('PUT', '/api/config', { repos: [...cfg.repos, { name, path: dir, mode: 'off' }] });
  return { dir, git };
}

const settled = (ref, status = 'done') =>
  until(
    async () => {
      const x = await worker(ref);
      return x.status === status ? x : null;
    },
    90_000,
    () => worker(ref),
  );

test('--after waits for another worker and builds on its branch; --verify reaches the task and the report', async () => {
  const { git } = await localRepo('chain');
  await call('POST', '/api/router/attach', { take: true });
  const first = await act({ type: 'dispatch', task: 'SLOW: COMMIT: FILE:one.txt first part', title: 'First part', repo: 'chain' });
  const second = await act({ type: 'dispatch', task: 'COMMIT: FILE:two.txt second part', title: 'Second part', repo: 'chain', after: first.worker, verify: 'browser' });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.status, 'queued');
  assert.equal(second.waiting_for, 'after');
  assert.match(second.waiting_detail, new RegExp(`waits for ${first.worker}`));
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal((await worker(second.worker)).status, 'queued', 'it does not start before its dependency is done');
  const w1 = await settled(first.worker);
  const w2 = await settled(second.worker);
  assert.equal(w2.base, w1.branch, 'it starts from the first worker’s branch');
  git('merge-base', '--is-ancestor', w1.branch, w2.branch); // throws if not
  assert.match(w2.task, /Verification: Verify in a browser/);
  const detail = await call('GET', `/api/workers/${second.worker.slice(2)}`);
  assert.match(detail.runs[0].prompt, new RegExp(`This task follows ${first.worker} \\("First part"\\), which is done`));
  const ev = await until(async () => {
    const e = await call('GET', '/api/router/events?wait=2');
    return e.text.includes(`REPORT · ${second.worker}`) ? e : null;
  });
  assert.match(ev.text, /verified: mock verification/);

  // A dependency that fails takes its dependents with it, instead of leaving them queued forever.
  const broken = await act({ type: 'dispatch', task: 'SLOW: FAIL: broken part', title: 'Broken part', repo: 'chain' });
  const next = await act({ type: 'dispatch', task: 'after the broken one', title: 'Next part', repo: 'chain', after: broken.worker });
  const failed = await settled(next.worker, 'failed');
  assert.match(failed.error, new RegExp(`${broken.worker} ended failed`));
  assert.match((await act({ type: 'dispatch', task: 'x', after: broken.worker })).error, /ended failed; nothing to wait for/);
  assert.match((await act({ type: 'dispatch', task: 'x', after: 'W#9999' })).error, /unknown worker W#9999/);
});

test('result, wait, events --peek and --again, tell on a finished worker, cleanup --dry-run', async () => {
  assert.equal(sa(['router', 'attach', '--take']).status, 0);
  sa(['events']); // start from an empty inbox
  const d = JSON.parse(sa(['dispatch', 'FILE:answer.txt write the answer', '--title', 'Answer', '--json']).stdout);
  const w = sa(['wait', d.worker, '--timeout', '60']);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, new RegExp(`^${d.worker} done \\(`, 'm'));

  const r = sa(['result', d.worker]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Report: Mock finished: Answer/);
  assert.match(r.stdout, /Final answer:\n {2}Done\./);
  assert.match(r.stdout, /answer\.txt/);
  assert.doesNotMatch(r.stdout, /superagent-report/, 'the report block is not repeated in the answer');

  // --peek shows without handing out; events hands out and says where the batch ends; --again repeats it.
  const report = new RegExp(`REPORT · ${d.worker}`);
  await until(async () => report.test(sa(['events', '--peek']).stdout));
  const ev = sa(['events']);
  assert.match(ev.stdout, report);
  assert.match(ev.stdout, /\[end of \d+ events?; if you did not see them all, run `superagent events --again`\]/);
  assert.doesNotMatch(sa(['events', '--peek']).stdout, report, 'handed out once');
  assert.match(sa(['events', '--again']).stdout, report);

  const t = sa(['tell', d.worker, 'add one more line']);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, new RegExp(`${d.worker} resumes now with this message`));
  await until(async () => (await call('GET', `/api/workers/${d.worker.slice(2)}`)).runs.length === 2);
  await settled(d.worker);

  const slow = JSON.parse(sa(['dispatch', 'SLOW: take a while', '--title', 'Slow', '--json']).stdout);
  const timed = sa(['wait', slow.worker, '--timeout', '1']);
  assert.equal(timed.status, 2, 'still running at the timeout');
  assert.match(timed.stdout, /Still going after 1 s/);
  await settled(slow.worker, 'running');
  const busy = sa(['tell', slow.worker, 'note this']);
  assert.match(busy.stdout, /reads it when its current run ends/);
  sa(['cancel', slow.worker]);

  const dry = sa(['cleanup', '--days', '0', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`Would archive .*${d.worker}`));
  assert.equal((await worker(d.worker)).archived, 0, 'a dry run changes nothing');
  assert.match(sa(['workers']).stdout, new RegExp(`${d.worker} +done .* \\d+s `), 'workers shows the time each took');
});

test('merge combines workers’ branches in order, and stops cleanly at a conflict', async () => {
  const { dir, git } = await localRepo('merges');
  await call('POST', '/api/router/attach', { take: true });
  const a = await act({ type: 'dispatch', task: 'COMMIT: FILE:a.txt add a', title: 'Add a', repo: 'merges' });
  const b = await act({ type: 'dispatch', task: 'COMMIT: FILE:b.txt add b', title: 'Add b', repo: 'merges' });
  await settled(a.worker);
  await settled(b.worker);
  const m = sa(['merge', a.worker, b.worker]);
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.match(m.stdout, new RegExp(`Merged ${a.worker}, ${b.worker} into main`));
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt')));
  assert.equal(git('log', '-1', '--format=%s'), `Merge ${b.worker}: Add b`);
  assert.match(sa(['merge', a.worker]).stdout, /Nothing to merge into main/);

  const c = await act({ type: 'dispatch', task: 'COMMIT: FILE:same.txt one way', title: 'Same one', repo: 'merges' });
  const d = await act({ type: 'dispatch', task: 'COMMIT: FILE:same.txt another way', title: 'Same two', repo: 'merges' });
  await settled(c.worker);
  await settled(d.worker);
  const bad = sa(['merge', c.worker, d.worker]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, new RegExp(`${d.worker} \\(\\S+\\) conflicts with main in same\\.txt`));
  assert.match(bad.stderr, new RegExp(`${c.worker} was merged before it`));
  assert.match(bad.stderr, /superagent dispatch "Merge branch/);
  assert.equal(git('status', '--porcelain'), '', 'the conflicted merge was undone');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'edited by hand\n');
  const dirty = sa(['merge', d.worker]);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /has uncommitted changes; commit or stash them first/);
  git('checkout', '--', 'a.txt');
  const scratch = await act({ type: 'dispatch', task: 'no repo here', title: 'Scratch' });
  await settled(scratch.worker);
  assert.match(sa(['merge', scratch.worker]).stderr, /scratch folder/);
});

test('restart asks before interrupting running workers', async () => {
  await call('POST', '/api/router/attach', { take: true });
  const d = await act({ type: 'dispatch', task: 'SLOW: busy for a bit', title: 'Busy' });
  await settled(d.worker, 'running');
  const r = sa(['restart']);
  assert.equal(r.status, 1, 'it does not restart');
  assert.match(r.stderr, new RegExp(`1 worker is running: ${d.worker} \\(`));
  assert.match(r.stderr, /--when-idle/);
  assert.ok((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 'the service kept running');
  assert.ok(Array.isArray((await call('GET', '/api/state')).workers.queued));
  await act({ type: 'stop_worker', worker: d.worker });
});
