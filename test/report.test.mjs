// Regression tests for the issues found in the v0.1.1 end-to-end test report (B1–B13, 4c).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-report-'));
process.env.SUPERAGENT_HOME = path.join(tmp, 'data'); // before the modules read it

const { applyConfigPatch, defaultConfig, unknownKeys } = await import('../dist/core/config.js');
const { telegramSender } = await import('../dist/channels/telegram.js');
const { isReviewBot } = await import('../dist/channels/github.js');
const { decide } = await import('../dist/triggers/policy.js');
const { SESSION_GONE } = await import('../dist/workers/manager.js');
const { parseReport } = await import('../dist/workers/prompts.js');
const { promptArg } = await import('../dist/agents/runner.js');
const { startProcess } = await import('../dist/agents/process.js');

test('B5: config changes are validated, not guessed', () => {
  const cfg = defaultConfig();
  assert.throws(() => applyConfigPatch(cfg, { workers: { maxConcurrent: 0 } }), /workers.maxConcurrent must be a whole number from 1 to 16/);
  assert.throws(() => applyConfigPatch(cfg, { workers: { maxConcurent: 2 } }), /Unknown setting: workers.maxConcurent/);
  assert.throws(() => applyConfigPatch(cfg, { nonsense: { key: 5 } }), /Unknown setting: nonsense/);
  assert.throws(() => applyConfigPatch(cfg, { router: { maxBatch: 0 } }), /router.maxBatch/);
  assert.throws(() => applyConfigPatch(cfg, { workers: { stallMinutes: 'soon' } }), /workers.stallMinutes/);
  assert.throws(() => applyConfigPatch(cfg, { router: { leaseMinutes: Infinity } }), /router.leaseMinutes/);
  assert.throws(() => applyConfigPatch(cfg, { workers: { autonomy: 'yolo' } }), /must be one of full, safe/);
  assert.equal(applyConfigPatch(cfg, { workers: { maxConcurrent: 4 } }).workers.maxConcurrent, 4);
  assert.equal(applyConfigPatch(cfg, { agents: { codex: { model: 'o4' } } }).agents.codex.model, 'o4');
  assert.deepEqual(unknownKeys({ agents: { nope: { model: 'x' } } }), ['agents.nope.model']);
});

test('B8: Telegram trusts the username or numeric id, never the display name', () => {
  const allow = ['alice', '123456'];
  assert.equal(telegramSender({ id: 999, first_name: 'alice' }, allow).allowed, false, 'a display name set to an allowed username');
  assert.equal(telegramSender({ id: 999, username: 'Alice' }, allow).allowed, true);
  assert.equal(telegramSender({ id: 123456, first_name: 'Bob' }, allow).allowed, true, 'numeric id');
  assert.match(telegramSender({ id: 999, first_name: 'alice' }, allow).author, /^alice \(id 999\)$/);
});

test('B13: review bots reach the worker that follows its own PR, other bots do not', () => {
  const bots = defaultConfig().github.reviewBots;
  assert.ok(isReviewBot('chatgpt-codex-connector[bot]', bots));
  assert.ok(isReviewBot('coderabbitai[bot]', bots));
  assert.ok(!isReviewBot('dependabot[bot]', bots));
  const ev = { source: 'github', kind: 'review_comment', text: 'nit', author: 'coderabbitai[bot]', isBot: true, mode: 'mentions', allowUsers: ['me'] };
  assert.equal(decide({ ...ev, reviewBot: true }, 1).decision, 'pass_through');
  assert.equal(decide({ ...ev, reviewBot: true }, 0).decision, 'dropped', 'bots never start work');
  assert.equal(decide({ ...ev, reviewBot: false }, 1).decision, 'dropped');
});

test('4c: only a missing session restarts a task from scratch', () => {
  assert.ok(SESSION_GONE.test('No conversation found with session ID: 1234'));
  assert.ok(SESSION_GONE.test('Error: thread 0199 not found'));
  assert.ok(!SESSION_GONE.test("Error: Cannot find module 'left-pad'"));
  assert.ok(!SESSION_GONE.test('npm ERR! 404 Not Found - GET https://registry.npmjs.org/x'));
});

test('silent tasks can say there was nothing to do (no_change)', () => {
  const r = parseReport('<superagent-report>{"status":"no_change","summary":"Could not reproduce."}</superagent-report>');
  assert.equal(r.status, 'no_change');
});

test('B3: on Windows an argument prompt goes through a file, so quotes survive', () => {
  const prompt = 'He said "hi" and {"json": true}';
  const arg = promptArg(prompt, 'exe', 'win32');
  const file = arg.match(/Read the file (.+?) and follow/)?.[1];
  assert.ok(file && fs.existsSync(file), arg);
  assert.equal(fs.readFileSync(file, 'utf8'), prompt);
  assert.equal(promptArg(prompt, 'exe', 'linux'), prompt, 'elsewhere argv carries it intact');
  assert.match(promptArg('x'.repeat(200_000), 'plain', 'linux'), /^Read the file /, 'too long for a command line');
});

test('4c: a character split across two output chunks stays whole', async () => {
  const lines = [];
  const script = 'process.stdout.write(Buffer.from([0xe0,0xa4]));setTimeout(()=>process.stdout.write(Buffer.from([0xb9,0x0a])),80)';
  const h = startProcess({ file: process.execPath, prefix: [], via: 'exe', path: process.execPath }, { cwd: tmp, args: ['-e', script], onLine: (l) => lines.push(l) });
  await h.done;
  assert.deepEqual(lines, ['ह']);
});

test('4c: a run ends when its process exits, even if a child still holds the output pipe', async () => {
  // Like a dev server left running: the child outlives its parent and keeps the inherited output pipe.
  const script = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'inherit'}).unref();console.log('bye')";
  const started = Date.now();
  const h = startProcess({ file: process.execPath, prefix: [], via: 'exe', path: process.execPath }, { cwd: tmp, args: ['-e', script] });
  const r = await h.done;
  assert.equal(r.code, 0);
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
});
