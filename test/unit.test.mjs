import assert from 'node:assert/strict';
import { test } from 'node:test';

const { decide } = await import('../dist/triggers/policy.js');
const { parseRef, clip, extractJsonObject, slugify } = await import('../dist/core/util.js');
const { claude, codex, opencode, cursor } = await import('../dist/agents/adapters.js');
const { parseCmdShim } = await import('../dist/agents/process.js');
const { parseReport } = await import('../dist/workers/prompts.js');
const { normalizeActions } = await import('../dist/router/router.js');
const { slugFromRemote } = await import('../dist/daemon/system.js');
const { merge, applyConfigPatch, defaultConfig } = await import('../dist/core/config.js');

test('fast-path policy', () => {
  const gh = { source: 'github', kind: 'comment', author: 'alice', mode: 'mentions', allowUsers: [] };
  assert.equal(decide({ source: 'local', kind: 'message', text: 'hi' }, 0).decision, 'explicit');
  assert.equal(decide({ ...gh, text: 'lunch?' }, 0).decision, 'dropped');
  assert.equal(decide({ ...gh, text: 'hey /superagent fix this', mentioned: true }, 0).decision, 'explicit');
  assert.equal(decide({ ...gh, text: 'any comment', mode: 'all' }, 0).decision, 'candidate');
  assert.equal(decide({ ...gh, text: 'review note' }, 2).decision, 'pass_through');
  assert.equal(decide({ ...gh, text: 'x <!-- superagent -->', mentioned: true }, 1).decision, 'dropped');
  assert.equal(decide({ ...gh, text: 'x', mentioned: true, allowUsers: ['bob'] }, 0).decision, 'dropped');
  assert.equal(decide({ ...gh, text: 'x', mentioned: true, allowUsers: ['ALICE'] }, 0).decision, 'explicit');
  assert.equal(decide({ ...gh, text: 'x', mentioned: true, isBot: true }, 0).decision, 'dropped');
  assert.equal(decide({ ...gh, kind: 'ci', text: 'CI', ci: 'failures', ciConclusion: 'success' }, 1).decision, 'dropped');
  assert.equal(decide({ ...gh, kind: 'ci', text: 'CI', ci: 'failures', ciConclusion: 'failure' }, 1).decision, 'pass_through');
  assert.equal(decide({ ...gh, text: 'Merged', informational: true }, 1).decision, 'fyi');
  assert.equal(decide({ ...gh, text: 'x', mode: 'off', mentioned: true }, 0).decision, 'dropped');
});

test('refs, clipping and json extraction', () => {
  assert.deepEqual(parseRef('TH#8'), { kind: 'TH', id: 8 });
  assert.deepEqual(parseRef('w3'), { kind: 'W', id: 3 });
  assert.equal(parseRef('X#1'), null);
  assert.equal(clip('abcdef', 3, 'recall T#1'), 'abc… [+3 chars: recall T#1]');
  assert.deepEqual(extractJsonObject('Sure! ```json\n{"actions":[]}\n```'), { actions: [] });
  assert.deepEqual(extractJsonObject('prefix {"a":{"b":"}"}} suffix'), { a: { b: '}' } });
  assert.equal(slugify('Fix: the Login bug!!'), 'fix-the-login-bug');
});

test('claude stream parser', () => {
  const p = claude.parser();
  assert.deepEqual(p('{"type":"system","subtype":"init","session_id":"s1"}'), [{ kind: 'session', id: 's1' }]);
  const ev = p(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }));
  assert.deepEqual(ev, [{ kind: 'text', text: 'hi' }, { kind: 'tool', text: '$ npm test' }]);
  const fin = p(JSON.stringify({ type: 'result', is_error: false, session_id: 's1', structured_output: { actions: [] }, result: '' }));
  assert.deepEqual(fin, [{ kind: 'session', id: 's1' }, { kind: 'final', text: '{"actions":[]}' }]);
  assert.deepEqual(p('not json'), []);
});

test('codex jsonl parser', () => {
  const p = codex.parser();
  assert.deepEqual(p('{"type":"thread.started","thread_id":"t1"}'), [{ kind: 'session', id: 't1' }]);
  assert.deepEqual(p('{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}'), [{ kind: 'text', text: 'pong' }]);
  assert.deepEqual(p('{"type":"turn.completed","usage":{}}'), [{ kind: 'final', text: 'pong' }]);
  assert.equal(p('{"type":"item.completed","item":{"type":"command_execution","exit_code":1,"aggregated_output":"boom"}}')[0].kind, 'error');
});

test('opencode and cursor parsers', () => {
  const o = opencode.parser();
  const first = o('{"type":"step_start","sessionID":"ses_1","part":{}}');
  assert.deepEqual(first, [{ kind: 'session', id: 'ses_1' }]);
  assert.deepEqual(o('{"type":"text","sessionID":"ses_1","part":{"text":"hello"}}'), [{ kind: 'text', text: 'hello' }]);
  assert.equal(o('{"type":"error","sessionID":"ses_1","error":{"message":"No endpoints"}}')[0].text, 'No endpoints');
  const c = cursor.parser();
  assert.deepEqual(c('{"type":"system","subtype":"init","session_id":"c1"}'), [{ kind: 'session', id: 'c1' }]);
  assert.deepEqual(c('{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}'), [{ kind: 'tool', text: '$ ls' }]);
  assert.deepEqual(c('{"type":"result","is_error":false,"result":"ok"}'), [{ kind: 'final', text: 'ok' }]);
});

test('windows cmd shim resolution', () => {
  const exe = parseCmdShim('"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', 'C:\\npm\\claude.cmd');
  assert.equal(exe.via, 'exe');
  assert.match(exe.file, /claude\.exe$/);
  const js = parseCmdShim('"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', 'C:\\npm\\codex.cmd');
  assert.equal(js.via, 'node');
  assert.match(js.prefix[0], /codex\.js$/);
  const ps = parseCmdShim('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*', 'C:\\x\\cursor-agent.cmd');
  assert.equal(ps.via, 'powershell');
  assert.equal(parseCmdShim('@echo off\necho hi', 'C:\\x\\y.cmd'), null);
});

test('worker report parsing', () => {
  const r = parseReport('All good.\n<superagent-report>{"status":"done","summary":"Fixed it","pr_url":"https://github.com/a/b/pull/12"}</superagent-report>');
  assert.equal(r.status, 'done');
  assert.equal(r.pr_url, 'https://github.com/a/b/pull/12');
  assert.equal(parseReport('no block here'), null);
  assert.equal(parseReport('<superagent-report>{"status":"needs_input","summary":"?","question":"Which DB?"}</superagent-report>').question, 'Which DB?');
});

test('router action normalisation', () => {
  const a = normalizeActions({ actions: [{ type: 'reply', thread: 'TH#1', text: 'x' }, { type: 'bogus' }, null] });
  assert.equal(a.length, 1);
  assert.deepEqual(normalizeActions([{ type: 'recall', ids: ['T#1'] }]).map((x) => x.type), ['recall']);
});

test('config merge and repo parsing', () => {
  const cfg = merge(defaultConfig(), { workers: { maxConcurrent: 5 } });
  assert.equal(cfg.workers.maxConcurrent, 5);
  assert.equal(cfg.workers.defaultAgent, 'claude');
  const withToken = { ...defaultConfig(), telegram: { ...defaultConfig().telegram, botToken: 'secret1234' } };
  assert.equal(applyConfigPatch(withToken, { telegram: { botToken: '••••1234' } }).telegram.botToken, 'secret1234');
  assert.equal(slugFromRemote('https://github.com/imthegoodboy/SuperAgent.git'), 'imthegoodboy/SuperAgent');
  assert.equal(slugFromRemote('git@github.com:a/b.git'), 'a/b');
  assert.equal(slugFromRemote('https://gitlab.com/a/b'), null);
});
