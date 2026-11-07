// End-to-end: real daemon process, real HTTP API, real router/worker pipeline,
// with a mock agent standing in for Claude Code so no LLM calls are made.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-e2e-'));
const port = 17000 + Math.floor(Math.random() * 2000);
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

async function call(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  daemon = spawn(process.execPath, [path.join(root, 'dist', 'cli.js'), '__daemon'], {
    env: { ...process.env, SUPERAGENT_HOME: home, SUPERAGENT_MOCK: '1', MOCK_DELAY_MS: '30' },
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

test('rejects calls without the token, and foreign Host / Origin', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  const evil = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('serves the UI with the token injected', async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, new RegExp(token));
});

test('chat message is answered by the router', async () => {
  const { message } = await call('POST', '/api/messages', { text: 'hello there' });
  const reply = await until(async () => (await call('GET', '/api/messages')).find((m) => m.role === 'agent' && m.id > message.id));
  assert.equal(reply.text, 'Echo: hello there');
});

test('router dispatches a worker, worker reports back, router relays the result', async () => {
  const { message } = await call('POST', '/api/messages', { text: 'task: write the mock file' });
  const worker = await until(async () => (await call('GET', '/api/workers')).find((w) => w.title.includes('write the mock file')));
  const done = await until(async () => {
    const w = (await call('GET', `/api/workers/${worker.id}`)).worker;
    return w.status === 'done' ? w : null;
  });
  assert.match(done.summary, /Mock finished/);
  assert.ok(fs.existsSync(path.join(done.cwd, 'mock-output.txt')), 'worker wrote into its own workspace');
  const relayed = await until(async () =>
    (await call('GET', '/api/messages')).find((m) => m.role === 'agent' && m.id > message.id && m.text.startsWith(`W#${worker.id} finished`)),
  );
  assert.ok(relayed);
  const detail = await call('GET', `/api/workers/${worker.id}`);
  assert.ok(detail.logs.some((l) => l.kind === 'tool'), 'tool calls are logged');
});

test('direct task in a git repo runs in its own worktree and branch', async () => {
  const repoDir = path.join(home, 'demo-repo');
  fs.mkdirSync(repoDir);
  const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  await call('PUT', '/api/config', { repos: [{ name: 'demo', path: repoDir, mode: 'off' }] });
  const w = await call('POST', '/api/workers', { task: 'touch a file', repo: 'demo' });
  const done = await until(async () => {
    const x = (await call('GET', `/api/workers/${w.id}`)).worker;
    return x.status === 'done' ? x : null;
  });
  assert.match(done.branch, /^superagent\/w\d+-touch-a-file$/);
  assert.notEqual(path.resolve(done.cwd), path.resolve(repoDir));
  assert.ok(fs.existsSync(path.join(done.cwd, 'mock-output.txt')));
  assert.ok(!fs.existsSync(path.join(repoDir, 'mock-output.txt')), 'main checkout untouched');
  await call('POST', `/api/workers/${w.id}/archive`);
  assert.ok(!fs.existsSync(done.cwd), 'archive removes the worktree');
});

test('messages to a finished worker resume it (pass-through inbox)', async () => {
  const w = await call('POST', '/api/workers', { task: 'first job' });
  await until(async () => (await call('GET', `/api/workers/${w.id}`)).worker.status === 'done');
  await call('POST', `/api/workers/${w.id}/message`, { text: 'one more thing' });
  const detail = await until(async () => {
    const d = await call('GET', `/api/workers/${w.id}`);
    return d.runs.length === 2 && d.worker.status === 'done' ? d : null;
  });
  assert.match(detail.runs[1].prompt, /one more thing/);
  assert.equal(detail.worker.run_count, 2);
});
