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

after(() => {
  daemon?.kill();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
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

test('workers cannot use router commands', () => {
  const r = sa(['dispatch', 'spawn another worker'], { SUPERAGENT_WORKER: 'W#1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /You are SuperAgent worker W#1/);
  assert.equal(sa(['stop'], { SUPERAGENT_WORKER: 'W#1' }).status, 1, 'a worker cannot stop the service');
  assert.equal(sa(['config', 'set', 'workers.maxConcurrent', '9'], { SUPERAGENT_WORKER: 'W#1' }).status, 1);
  assert.equal(sa(['workers'], { SUPERAGENT_WORKER: 'W#1' }).status, 0, 'read-only commands still work');
});
