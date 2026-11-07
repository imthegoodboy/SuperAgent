import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillFile = path.join(root, 'skill', 'superagent', 'SKILL.md');

test('skill has valid frontmatter', () => {
  const text = fs.readFileSync(skillFile, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, 'frontmatter block');
  assert.match(fm[1], /^name: superagent$/m);
  const desc = fm[1].match(/^description: (.+)$/m)?.[1] ?? '';
  assert.ok(desc.length > 50 && desc.length <= 1024, 'description is present and within limits');
});

test('`superagent skill install` copies the skill for Claude Code and Codex', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-skill-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), SUPERAGENT_HOME: path.join(home, '.superagent') };
  const cli = path.join(root, 'dist', 'cli.js');
  execFileSync(process.execPath, [cli, 'skill', 'install'], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'skill', 'install', '--codex'], { env, stdio: 'pipe' });
  for (const p of [path.join(home, '.claude', 'skills', 'superagent', 'SKILL.md'), path.join(home, '.codex', 'skills', 'superagent', 'SKILL.md')]) {
    assert.equal(fs.readFileSync(p, 'utf8'), fs.readFileSync(skillFile, 'utf8'));
  }
  fs.rmSync(home, { recursive: true, force: true });
});
