import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const IS_WIN = process.platform === 'win32';

export interface Resolved {
  file: string;
  prefix: string[];
  /** exe/node/plain take arbitrary argv safely; cmd/powershell need simple args (no newlines). */
  via: 'exe' | 'node' | 'powershell' | 'cmd' | 'plain';
  path: string;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function which(name: string): string | null {
  if (path.isAbsolute(name)) return isFile(name) ? name : null;
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/**
 * npm and other installers put `.cmd` shims on PATH on Windows. Running those through cmd.exe
 * mangles multi-line prompts, so we look inside the shim and launch the real target directly.
 */
export function parseCmdShim(content: string, shimPath: string): Resolved | null {
  const dir = path.dirname(shimPath);
  // JS entry first: npm shims for node CLIs also mention "%dp0%\node.exe" as the interpreter.
  let m = content.match(/"%dp0%\\([^"]+?\.(?:js|cjs|mjs))"/i);
  if (m) return { file: process.execPath, prefix: [path.join(dir, m[1])], via: 'node', path: shimPath };
  const exe = [...content.matchAll(/"%dp0%\\([^"]+?\.exe)"/gi)].map((x) => x[1]).find((p) => !/(^|\\)node\.exe$/i.test(p));
  if (exe) return { file: path.join(dir, exe), prefix: [], via: 'exe', path: shimPath };
  m = content.match(/-File\s+"%SCRIPT_DIR%\\([^"]+?\.ps1)"/i);
  if (m) {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return {
      file: ps,
      prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, m[1])],
      via: 'powershell',
      path: shimPath,
    };
  }
  return null;
}

const cache = new Map<string, Resolved | null>();

export function resolveCommand(name: string, fresh = false): Resolved | null {
  if (!fresh && cache.has(name)) return cache.get(name)!;
  const found = which(name);
  let resolved: Resolved | null = null;
  if (found) {
    if (!IS_WIN) resolved = { file: found, prefix: [], via: 'plain', path: found };
    else if (/\.(exe|com)$/i.test(found)) resolved = { file: found, prefix: [], via: 'exe', path: found };
    else if (/\.(cmd|bat)$/i.test(found)) {
      let content = '';
      try {
        content = fs.readFileSync(found, 'utf8');
      } catch {
        /* fall through */
      }
      resolved = parseCmdShim(content, found) ?? {
        file: process.env.ComSpec || 'cmd.exe',
        prefix: ['/d', '/s', '/c'],
        via: 'cmd',
        path: found,
      };
    } else resolved = { file: found, prefix: [], via: 'plain', path: found };
  }
  cache.set(name, resolved);
  return resolved;
}

function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface ProcOptions {
  cwd: string;
  args: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Called for every chunk of output, even one without a newline yet (a sign of life). */
  onChunk?: () => void;
  /** How much of stdout/stderr to keep for the result (default 256 KB). */
  keepBytes?: number;
}

export interface ProcHandle {
  pid: number | undefined;
  done: Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }>;
  kill: () => void;
}

const KEEP = 256 * 1024;

export function startProcess(resolved: Resolved, opts: ProcOptions): ProcHandle {
  // spawn() reports a missing working directory as "ENOENT" on the program itself, which is misleading.
  if (!fs.existsSync(opts.cwd)) {
    return {
      pid: undefined,
      kill: () => {},
      done: Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: `working directory does not exist: ${opts.cwd}` }),
    };
  }
  let args = [...resolved.prefix, ...opts.args];
  let verbatim = false;
  if (resolved.via === 'cmd') {
    // cmd /d /s /c ""C:\path\tool.cmd" arg1 "arg 2""
    args = [...resolved.prefix, `"${[`"${resolved.path}"`, ...opts.args.map(quoteForCmd)].join(' ')}"`];
    verbatim = true;
  }
  const child = spawn(resolved.file, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    detached: !IS_WIN,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError: string | undefined;
  const bufs = { stdout: '', stderr: '' };
  // One decoder per stream: a character split across two chunks (emoji, Hindi, …) stays whole.
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

  const keep = opts.keepBytes ?? KEEP;
  const feed = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    opts.onChunk?.();
    const s = decoders[stream].write(chunk);
    if (stream === 'stdout') stdout = (stdout + s).slice(-keep);
    else stderr = (stderr + s).slice(-keep);
    bufs[stream] += s;
    let idx: number;
    while ((idx = bufs[stream].indexOf('\n')) !== -1) {
      const line = bufs[stream].slice(0, idx).replace(/\r$/, '');
      bufs[stream] = bufs[stream].slice(idx + 1);
      if (line.trim()) opts.onLine?.(line, stream);
    }
  };
  child.stdout?.on('data', (c: Buffer) => feed('stdout', c));
  child.stderr?.on('data', (c: Buffer) => feed('stderr', c));
  child.stdin?.on('error', () => {});
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();

  const kill = () => killTree(child.pid);
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs)
    : null;

  const done = new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }>((resolve) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const stream of ['stdout', 'stderr'] as const) {
        if (bufs[stream].trim()) opts.onLine?.(bufs[stream].replace(/\r$/, ''), stream);
        bufs[stream] = '';
      }
      resolve({ code, stdout, stderr, timedOut, spawnError });
    };
    // A failed spawn (missing binary, out of memory) may emit 'error' without ever emitting 'close';
    // settle anyway so a worker slot or the router can never hang on it.
    child.on('error', (err) => {
      spawnError = err.message;
      setTimeout(() => settle(null), 1000);
    });
    child.on('close', (code) => settle(code));
    // A run is over when the process exits, even if something it started (a dev server) still holds
    // the output pipe open, which would otherwise keep the run, and its slot, busy forever.
    child.on('exit', (code) => {
      setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code);
      }, 5000).unref();
    });
  });

  return { pid: child.pid, done, kill };
}

export function killTree(pid: number | undefined | null): void {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    /* already gone */
  }
}

/** When a process started (ms), or null if it can't be read: a recycled pid starts at another time. */
export async function processStartTime(pid: number): Promise<number | null> {
  const r =
    process.platform === 'win32'
      ? await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)}).StartTime.ToUniversalTime().ToString('o')`], { timeoutMs: 20_000 })
      : await run('ps', ['-o', 'lstart=', '-p', String(Math.trunc(pid))], { timeoutMs: 10_000 });
  const t = r.code === 0 ? Date.parse(r.stdout.trim()) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** The command line of a running process ('' if it can't be read), to check a pid is still ours. */
export async function commandLine(pid: number): Promise<string> {
  const r =
    process.platform === 'win32'
      ? await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`], { timeoutMs: 20_000 })
      : await run('ps', ['-o', 'args=', '-p', String(Math.trunc(pid))], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : '';
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run a short command (git, gh, --version) and collect output. */
export async function run(
  name: string,
  args: string[],
  opts: { cwd?: string; stdin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; keepBytes?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const resolved = resolveCommand(name);
  if (!resolved) return { code: 127, stdout: '', stderr: `${name}: command not found` };
  const h = startProcess(resolved, {
    cwd: opts.cwd ?? process.cwd(),
    args,
    stdin: opts.stdin,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 60_000,
    keepBytes: opts.keepBytes,
  });
  const r = await h.done;
  if (r.spawnError) return { code: 127, stdout: r.stdout, stderr: r.spawnError };
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

export async function runOk(name: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<string> {
  const r = await run(name, args, opts);
  if (r.code !== 0) throw new Error(`${name} ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout;
}

/**
 * Run a CLI in the foreground, attached to this terminal (for launching an interactive agent).
 * Same argument handling as startProcess, so Windows `.cmd` shims are unwrapped, never a shell.
 */
export function runInteractive(resolved: Resolved, args: string[], cwd: string): Promise<number> {
  let argv = [...resolved.prefix, ...args];
  let verbatim = false;
  if (resolved.via === 'cmd') {
    argv = [...resolved.prefix, `"${[`"${resolved.path}"`, ...args.map(quoteForCmd)].join(' ')}"`];
    verbatim = true;
  }
  return new Promise((resolve) => {
    const child = spawn(resolved.file, argv, { cwd, stdio: 'inherit', windowsVerbatimArguments: verbatim });
    child.on('error', (err) => {
      process.stderr.write(`Could not start ${resolved.path}: ${err.message}\n`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
