// First-run CLI behaviour with a brand-new data folder and no daemon running.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-cli-'));
const home = path.join(tmp, 'data'); // deliberately not created
// A port nothing listens on, so commands see "not running".
const env = { ...process.env, SUPERAGENT_HOME: home, SUPERAGENT_SKIP_INTEGRATIONS: '1', NO_COLOR: '1' };
const sa = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

test('the CLI asks again after a dropped connection only for pure reads', async () => {
  const dir = path.join(tmp, 'retry');
  fs.mkdirSync(dir, { recursive: true });
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    // The first time each request arrives, drop the connection as a closed keep-alive socket would.
    if (seen.filter((s) => s === `${req.method} ${req.url}`).length === 1) return req.socket.resetAndDestroy();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: server.address().port }));
  const client = pathToFileURL(path.join(root, 'dist', 'cli', 'client.js')).href;
  const call = (method, p) =>
    new Promise((resolve) => {
      const script = `import(${JSON.stringify(client)}).then((m) => m.api(${JSON.stringify(method)}, ${JSON.stringify(p)}, ${method === 'GET' ? 'undefined' : '{}'})).then((r) => console.log(JSON.stringify(r)), (e) => console.log('ERR ' + e.message))`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, SUPERAGENT_HOME: dir } });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.on('close', () => resolve(out.trim()));
    });
  try {
    assert.equal(await call('GET', '/api/workers'), '{"ok":true}', 'a read is asked again');
    assert.match(await call('POST', '/api/router/actions'), /^ERR Request to SuperAgent failed/, 'a change is not repeated');
    assert.match(await call('GET', '/api/router/events?wait=0'), /^ERR /, '`events` hands a batch out, so it is not repeated');
    assert.equal(await call('GET', '/api/router/events?again=1'), '{"ok":true}');
    assert.equal(seen.filter((s) => s.startsWith('POST')).length, 1);
    assert.equal(seen.filter((s) => s === 'GET /api/router/events?wait=0').length, 1);
  } finally {
    server.close();
  }
});

test('config and repo commands work before the daemon ever ran', () => {
  const set = sa('config', 'set', 'port', '17999');
  assert.equal(set.status, 0, set.stderr);
  const repoDir = path.join(tmp, 'proj');
  fs.mkdirSync(repoDir);
  execFileSync('git', ['-C', repoDir, 'init', '-b', 'main'], { stdio: 'pipe' });
  const add = sa('repo', 'add', repoDir, '--name', 'proj');
  assert.equal(add.status, 0, add.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.port, 17999);
  assert.equal(cfg.repos[0].name, 'proj');
  // git reports canonical paths (/private/var on macOS, long names instead of RUNNER~1 on Windows).
  assert.equal(fs.realpathSync.native(cfg.repos[0].path), fs.realpathSync.native(repoDir));
});

test('errors are short messages, not stack traces', () => {
  const r = sa('router', 'status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not running/);
  const unknown = sa('chat');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command "chat"/);
  const json = sa('router', 'status', '--json');
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).ok, false, 'errors are JSON with --json');
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  const bad = sa('repo', 'add', path.join(tmp, 'nope-not-a-folder-or-slug!'));
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stderr, /\n\s+at /);
});

test('the prompt hook is silent and harmless when the service is not running', () => {
  const r = spawnSync(process.execPath, [cli, 'hook', 'prompt'], { env, input: '{"session_id":"x"}', encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('status and doctor run on a fresh machine', () => {
  const s = sa('status');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /not running/);
  const d = sa('doctor');
  assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(d.stdout, /ENOENT/);
  const dj = JSON.parse(sa('doctor', '--json').stdout);
  assert.ok(Array.isArray(dj.checks) && dj.checks.some((c) => /^Node /.test(c.message)), 'doctor --json is structured');
  assert.equal(JSON.parse(sa('--version', '--json').stdout).version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
});
