/**
 * A fake coding agent that speaks Claude Code's stream-json format.
 * Used by the test-suite and `SUPERAGENT_MOCK=1` demos so the whole pipeline runs without real LLM calls.
 *
 *   node mock-agent.js worker [--resume id]   -> does a fake task, writes a file, prints a report
 *   node mock-agent.js router [--resume id]   -> answers router turns with simple deterministic actions
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const mode = process.argv[2] ?? 'worker';
const resumeIdx = process.argv.indexOf('--resume');
const session = resumeIdx > 0 ? process.argv[resumeIdx + 1] : crypto.randomUUID();
const delay = Number((mode === 'router' ? process.env.MOCK_ROUTER_DELAY_MS : undefined) ?? process.env.MOCK_DELAY_MS ?? 50);

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
  await new Promise((r) => setTimeout(r, delay));

  if (mode === 'router') {
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
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'mock-output.txt' } }] } });
  fs.writeFileSync('mock-output.txt', `mock agent was here\n${title}\n`);
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'File written' }] } });
  await new Promise((r) => setTimeout(r, delay));
  if (process.env.MOCK_FAIL === '1') {
    out({ type: 'result', subtype: 'error', is_error: true, session_id: session, result: 'mock failure' });
    process.exit(1);
  }
  // A task containing "ASK:" makes the mock stop and ask the human a question.
  const report = /\bASK:/.test(input)
    ? { status: 'needs_input', summary: 'Need a decision before going on.', question: 'Which database should I use?' }
    : { status: 'done', summary: `Mock finished: ${title}` };
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
