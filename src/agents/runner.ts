import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_IDS } from '../core/config.js';
import { paths } from '../core/paths.js';
import { tail } from '../core/util.js';
import { ADAPTERS, type AgentAdapter, type AgentEvent, type RouterSpec, type RunSpec } from './adapters.js';
import { resolveCommand, run, startProcess, type Resolved } from './process.js';

export interface AgentRunResult {
  code: number | null;
  session: string | null;
  finalText: string;
  error: string | null;
  durationMs: number;
}

export interface AgentRun {
  pid: number | undefined;
  done: Promise<AgentRunResult>;
  kill: () => void;
}

function resolveAdapter(adapter: AgentAdapter): Resolved | null {
  return adapter.resolve ? adapter.resolve() : resolveCommand(adapter.command);
}

/** Prompts for agents launched through cmd/powershell go through a file, since those shells mangle newlines. */
function promptArg(prompt: string, via: Resolved['via']): string {
  if (via === 'exe' || via === 'node' || via === 'plain') return prompt;
  const file = path.join(paths.prompts, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.mkdirSync(paths.prompts, { recursive: true });
  fs.writeFileSync(file, prompt);
  return `Read the file ${file} and follow the instructions in it exactly.`;
}

function launch(
  adapter: AgentAdapter,
  cwd: string,
  args: string[],
  prompt: string,
  onEvent: (ev: AgentEvent) => void,
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): AgentRun {
  const started = Date.now();
  const resolved = resolveAdapter(adapter);
  if (!resolved) {
    return {
      pid: undefined,
      kill: () => {},
      done: Promise.resolve({
        code: 127,
        session: null,
        finalText: '',
        error: `${adapter.label} is not installed (\`${adapter.command}\` not found on PATH).`,
        durationMs: 0,
      }),
    };
  }
  const parse = adapter.parser();
  let session: string | null = null;
  let finalText: string | null = null;
  let lastText = '';
  const errors: string[] = [];
  const handle = (ev: AgentEvent) => {
    if (ev.kind === 'session') session = ev.id;
    else if (ev.kind === 'final') finalText = ev.text;
    else if (ev.kind === 'text') lastText = ev.text;
    else if (ev.kind === 'error') errors.push(ev.text);
    onEvent(ev);
  };

  const fullArgs = adapter.promptVia === 'arg' ? [...args, promptArg(prompt, resolved.via)] : args;
  const proc = startProcess(resolved, {
    cwd,
    args: fullArgs,
    stdin: adapter.promptVia === 'stdin' ? prompt : undefined,
    env,
    timeoutMs,
    onLine: (line, stream) => {
      if (stream === 'stdout') {
        for (const ev of parse(line)) handle(ev);
      }
    },
  });

  const done = proc.done.then((r) => {
    let error: string | null = null;
    if (r.spawnError) error = `Could not start ${adapter.label}: ${r.spawnError}`;
    else if (r.timedOut) error = `${adapter.label} timed out.`;
    else if (r.code !== 0 && r.code !== null) {
      error = errors.at(-1) ?? (tail(r.stderr.trim() || r.stdout.trim(), 800) || `${adapter.label} exited with code ${r.code}`);
    } else if (finalText === null && errors.length && !lastText) error = errors.at(-1)!;
    return { code: r.code, session, finalText: finalText ?? lastText, error, durationMs: Date.now() - started };
  });
  return { pid: proc.pid, done, kill: proc.kill };
}

export function startWorkerRun(adapter: AgentAdapter, spec: RunSpec, onEvent: (ev: AgentEvent) => void, timeoutMs?: number): AgentRun {
  const prompt =
    adapter.supportsSystem || !spec.system || spec.session ? spec.prompt : `${spec.system}\n\n---\n\n${spec.prompt}`;
  return launch(adapter, spec.cwd, adapter.workerArgs(spec), prompt, onEvent, timeoutMs, spec.env);
}

export function startRouterRun(adapter: AgentAdapter, spec: RouterSpec, timeoutMs = 180_000): AgentRun {
  const prompt =
    adapter.id === 'claude' || adapter.id === 'mock' || spec.session
      ? spec.prompt
      : `${spec.system}\n\n---\n\n${spec.prompt}\n\nRespond with ONLY the JSON object, no prose.`;
  return launch(adapter, spec.cwd, adapter.routerArgs(spec), prompt, () => {}, timeoutMs);
}

// ---------- detection ----------

export interface AgentInfo {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
}

export async function detectAgents(): Promise<AgentInfo[]> {
  const ids: string[] = [...AGENT_IDS, ...(process.env.SUPERAGENT_MOCK === '1' ? ['mock'] : [])];
  return Promise.all(
    ids.map(async (id) => {
      const a = ADAPTERS[id];
      const resolved = resolveAdapter(a);
      const info: AgentInfo = {
        id,
        label: a.label,
        command: a.command,
        installed: false,
        version: null,
        path: resolved?.path ?? null,
        error: null,
      };
      if (!resolved) {
        info.error = 'Not found on PATH';
        return info;
      }
      if (id === 'mock') return { ...info, installed: true, version: 'test' };
      // Home, not ~/.superagent: `doctor` runs before the data folder exists.
      const r = await run(a.command, ['--version'], { timeoutMs: 20_000, cwd: os.homedir() });
      const out = (r.stdout || r.stderr).trim().split(/\r?\n/).filter(Boolean);
      if (r.code === 0) {
        info.installed = true;
        info.version = (out.at(-1) ?? '').slice(0, 80);
      } else info.error = (out.at(-1) ?? 'Failed to run --version').slice(0, 200);
      return info;
    }),
  );
}
