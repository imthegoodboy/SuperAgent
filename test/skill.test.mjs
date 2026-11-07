import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillFile = path.join(root, 'skill', 'superagent', 'SKILL.md');
const cli = path.join(root, 'dist', 'cli.js');

/** A throwaway home folder, so nothing touches the real agent folders on this machine. */
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-skill-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SUPERAGENT_HOME: path.join(home, '.superagent'),
    SUPERAGENT_SKIP_AUTOSTART: '1',
    NO_COLOR: '1',
    // No agent CLIs on PATH: only the folders created below count as installed agents.
    PATH: path.dirname(process.execPath),
    Path: path.dirname(process.execPath),
  };
  delete env.SUPERAGENT_SKIP_INTEGRATIONS;
  const sa = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { home, env, sa };
}

const skillAt = (...p) => path.join(...p, 'skills', 'superagent', 'SKILL.md');

test('skill has valid frontmatter', () => {
  const text = fs.readFileSync(skillFile, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, 'frontmatter block');
  assert.match(fm[1], /^name: superagent$/m);
  const desc = fm[1].match(/^description: (.+)$/m)?.[1] ?? '';
  assert.ok(desc.length > 50 && desc.length <= 1024, 'description is present and within limits');
});

test('every CLI command the skill uses exists', () => {
  const text = fs.readFileSync(skillFile, 'utf8');
  const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).stdout;
  const used = new Set([...text.matchAll(/(?<![/\w])superagent ([a-z]+)/g)].map((m) => m[1]));
  for (const cmd of used) assert.match(help, new RegExp(`\\b${cmd}\\b`), `"superagent ${cmd}" is in the help`);
});

test('the first command installs the skill for every agent found, and uninstall removes it', () => {
  const { home, sa } = fakeHome();
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    const own = fs.readFileSync(skillFile, 'utf8');

    assert.equal(sa('version').status, 0);
    assert.ok(!fs.existsSync(skillAt(home, '.claude')), '`version` does nothing else');
    assert.equal(sa('config').status, 0, 'any real command installs the skill');
    for (const dir of [path.join(home, '.codex'), path.join(home, '.cursor'), path.join(home, '.config', 'opencode')]) {
      assert.equal(fs.readFileSync(skillAt(dir), 'utf8'), own, `the plain skill is installed in ${dir}`);
    }
    // Claude Code's copy also declares the hook that shows waiting events on every user message.
    const claude = fs.readFileSync(skillAt(home, '.claude'), 'utf8');
    assert.match(claude.match(/^---\n([\s\S]*?)\n---/)[1], /UserPromptSubmit:[\s\S]*command: superagent hook prompt/);
    assert.equal(claude.replace(/^hooks:\n( {2}.*\n)+/m, ''), own, 'otherwise the same skill');

    // Someone removes it on purpose: it stays removed until they ask for it again.
    fs.rmSync(path.dirname(skillAt(home, '.codex')), { recursive: true });
    assert.equal(sa('config').status, 0);
    assert.ok(!fs.existsSync(skillAt(home, '.codex')));
    const install = sa('install');
    assert.equal(install.status, 0, install.stderr);
    assert.ok(fs.existsSync(skillAt(home, '.codex')));
    assert.match(install.stdout, /Claude Code/);

    const notes = path.join(path.dirname(skillAt(home, '.cursor')), 'my-notes.md');
    fs.writeFileSync(notes, 'mine');
    const un = sa('uninstall');
    assert.equal(un.status, 0, un.stderr);
    for (const dir of ['.claude', '.codex', '.cursor', path.join('.config', 'opencode')]) assert.ok(!fs.existsSync(skillAt(home, dir)), `removed from ${dir}`);
    assert.ok(fs.existsSync(path.join(home, '.claude')), "the agent's own folder stays");
    assert.equal(fs.readFileSync(notes, 'utf8'), 'mine', 'files that are not ours stay');
    assert.equal(sa('config').status, 0);
    assert.ok(!fs.existsSync(skillAt(home, '.claude')), 'after uninstall, commands no longer reinstall the skill');
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('postinstall only installs for global npm installs, and upgrades respect a removed skill', () => {
  const { home, env, sa } = fakeHome();
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.codex'));
    const post = (extra) => spawnSync(process.execPath, [path.join(root, 'scripts', 'postinstall.mjs')], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(post({ npm_config_global: '' }).status, 0);
    assert.ok(!fs.existsSync(skillAt(home, '.claude')), 'local installs (development, CI) are left alone');
    const r = post({ npm_config_global: 'true' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(skillAt(home, '.claude')));
    // The person removes it from Codex; an upgrade (same stamp, new install) leaves it removed.
    fs.rmSync(path.dirname(skillAt(home, '.codex')), { recursive: true });
    post({ npm_config_global: 'true' });
    assert.ok(!fs.existsSync(skillAt(home, '.codex')), 'a skill removed on purpose stays removed');
    // After `superagent uninstall`, installing the package again installs everywhere.
    sa('uninstall');
    post({ npm_config_global: 'true' });
    assert.ok(fs.existsSync(skillAt(home, '.claude')) && fs.existsSync(skillAt(home, '.codex')), 'a fresh install after uninstall');
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
