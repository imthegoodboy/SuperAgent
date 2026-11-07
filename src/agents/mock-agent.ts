/**
 * A fake coding agent that speaks Claude Code's stream-json format.
 * Used by the test-suite and `SUPERAGENT_MOCK=1` demos so the whole pipeline runs without real LLM calls.
 *
 *   node mock-agent.js worker [--resume id]   -> does a fake task, writes a file, prints a report
 *   node mock-agent.js router [--resume id]   -> answers router turns with simple deterministic actions
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const mode = process.argv[2] ?? 'worker';
const resumeIdx = process.argv.indexOf('--resume');
const session = resumeIdx > 0 ? process.argv[resumeIdx + 1] : crypto.randomUUID();
const delay = Number((mode === 'router' ? process.env.MOCK_ROUTER_DELAY_MS : undefined) ?? process.env.MOCK_DELAY_MS ?? 50);
// A task containing "SLOW:" keeps the mock worker busy for a while (tests that interrupt a run).
const slow = (text: string) => (/\bSLOW:/.test(text) ? 8000 : 0);

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

interface Ev {
  id: string;
  label: string;
  thread: string | null;
  worker: string | null;
  text: string;
}

/** Parse the router turn format rendered by src/router/render.ts. */
function parseEvents(input: string): Ev[] {
  const lines = input.split(/\r?\n/);
  const events: Ev[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(T#\d+) (EXPLICIT|CANDIDATE|REPORT)\b(.*)$/);
    if (!m) continue;
    const thread = m[3].match(/\b(TH#\d+)/)?.[1] ?? null;
    const worker = m[3].match(/\b(W#\d+)/)?.[1] ?? null;
    const body = (lines[i + 1] ?? '').trim().replace(/^"|"$/g, '');
    events.push({ id: m[1], label: m[2], thread, worker, text: body });
  }
  return events;
}

async function main(): Promise<void> {
  const input = await readStdin();
  out({ type: 'system', subtype: 'init', session_id: session });

  if (mode === 'router') {
    await new Promise((r) => setTimeout(r, delay));
    const actions: any[] = [];
    for (const ev of parseEvents(input)) {
      if (ev.label === 'REPORT') {
        const reply = input.match(/reply thread (TH#\d+)/)?.[1] ?? 'TH#1';
        actions.push({ type: 'reply', thread: reply, text: `${ev.worker} finished: ${ev.text}` });
      } else if (/^(task|do):/i.test(ev.text)) {
        const task = ev.text.replace(/^(task|do):\s*/i, '');
        actions.push({ type: 'dispatch', title: task.slice(0, 40), task, threads: ev.thread ? [ev.thread] : [], reply_thread: ev.thread ?? 'TH#1' });
        actions.push({ type: 'reply', thread: ev.thread ?? 'TH#1', text: `On it: ${task.slice(0, 40)}` });
      } else if (ev.label === 'EXPLICIT') {
        actions.push({ type: 'reply', thread: ev.thread ?? 'TH#1', text: `Echo: ${ev.text}` });
      } else {
        actions.push({ type: 'ignore', triggers: [ev.id], reason: 'mock: not actionable' });
      }
    }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: '', structured_output: { actions } });
    return;
  }

  // Activity first, then stay busy for `delay` ms, so a running mock worker looks like a real one.
  const title = input.match(/^# SuperAgent task W#\d+: (.*)$/m)?.[1] ?? input.split('\n')[0].slice(0, 60);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `Working on: ${title}` }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status --short' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'clean' }] } });
  // "FILE:name" picks the file it writes; "COMMIT:" commits it (tests that merge workers' branches).
  const file = input.match(/\bFILE:(\S+)/)?.[1] ?? 'mock-output.txt';
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: file } }] } });
  fs.writeFileSync(file, `mock agent was here\n${title}\n`);
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'File written' }] } });
  if (/\bCOMMIT:/.test(input)) {
    execFileSync('git', ['add', file]);
    execFileSync('git', ['-c', 'user.name=mock', '-c', 'user.email=mock@example.com', 'commit', '-q', '-m', `mock: ${title}`]);
  }
  await new Promise((r) => setTimeout(r, delay + slow(input)));
  // MOCK_FAIL=1 fails every task; "FAIL:" in a task fails just that one.
  if (process.env.MOCK_FAIL === '1' || /\bFAIL:/.test(input)) {
    out({ type: 'result', subtype: 'error', is_error: true, session_id: session, result: 'mock failure' });
    process.exit(1);
  }
  // A task containing "ASK:" makes the mock stop and ask the human a question.
  const report = /\bASK:/.test(input)
    ? { status: 'needs_input', summary: 'Need a decision before going on.', question: 'Which database should I use?' }
    : { status: 'done', summary: `Mock finished: ${title}`, ...(/\nVerification: /.test(input) ? { verified: 'mock verification' } : {}) };
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: session,
    result: `Done.\n<superagent-report>${JSON.stringify(report)}</superagent-report>`,
  });
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
