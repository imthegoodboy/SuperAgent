// First-run CLI behaviour with a brand-new data folder and no daemon running.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-cli-'));
const home = path.join(tmp, 'data'); // deliberately not created
// A port nothing listens on, so commands see "not running".
const env = { ...process.env, SUPERAGENT_HOME: home, SUPERAGENT_SKIP_INTEGRATIONS: '1', NO_COLOR: '1' };
const sa = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

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
  const r = sa('workers');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not running/);
  const unknown = sa('chat');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command "chat"/);
  const json = sa('workers', '--json');
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).ok, false, 'errors are JSON with --json');
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  const bad = sa('repo', 'add', path.join(tmp, 'nope-not-a-folder-or-slug!'));
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stderr, /\n\s+at /);
});

test('status and doctor run on a fresh machine', () => {
  const s = sa('status');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /not running/);
  const d = sa('doctor');
  assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(d.stdout, /ENOENT/);
});
