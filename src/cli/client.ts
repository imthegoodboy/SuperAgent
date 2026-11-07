import fs from 'node:fs';
import { servicePort } from '../core/instance.js';
import { HOME_ID, paths } from '../core/paths.js';

/** The running service's real port, even if `port` was changed in the config since it started. */
export function baseUrl(): string {
  return `http://127.0.0.1:${servicePort()}`;
}

export function token(): string {
  try {
    return fs.readFileSync(paths.token, 'utf8').trim();
  } catch {
    return '';
  }
}

export async function health(timeoutMs = 2000): Promise<{ ok: boolean; version: string; pid: number; uptime: number } | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j: any = await res.json();
    // Only the daemon serving *this* data folder counts (another SUPERAGENT_HOME may own the port).
    return j?.name === 'superagent' && (!j.home || j.home === HOME_ID) ? j : null;
  } catch {
    return null;
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
        'x-superagent-session': sessionId(),
        'x-superagent-client': clientDescription(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    const code = (e as { cause?: { code?: string } })?.cause?.code;
    if (code === 'ECONNREFUSED') throw new Error('SuperAgent is not running. Start it with `superagent start`.');
    throw new Error(`Request to SuperAgent failed (${code ?? (e as Error).message}). Check \`superagent status\`.`);
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
  return j as T;
}

/**
 * The calling agent session, so the router lease belongs to one session. Claude Code exposes its session
 * id to the shells it runs; any harness can set SUPERAGENT_SESSION. Empty when unknown.
 */
export function sessionId(): string {
  return (process.env.SUPERAGENT_SESSION || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || '').slice(0, 200);
}

/** Which agent and folder this command comes from, so a refused session can find the router's window. */
export function clientDescription(): string {
  const e = process.env;
  const kind = e.CLAUDECODE || e.CLAUDE_CODE_SESSION_ID ? 'Claude Code' : e.CODEX_THREAD_ID || e.CODEX_SANDBOX ? 'Codex' : e.OPENCODE ? 'OpenCode' : e.CURSOR_AGENT ? 'Cursor' : 'a terminal';
  const id = sessionId();
  return `${kind}${id ? ` session ${id.slice(0, 8)}` : ''} in ${process.cwd()}`.slice(0, 300);
}

/** Minimal Server-Sent Events reader over fetch. Returns a function that closes the stream. */
export function events(onEvent: (ev: { type: string; data: any }) => void): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`${baseUrl()}/api/events?token=${token()}`, { signal: ctrl.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.startsWith('event: hello')) {
            onEvent({ type: 'hello', data: null });
            continue;
          }
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (!data) continue;
          try {
            onEvent(JSON.parse(data));
          } catch {
            /* ignore malformed */
          }
        }
      }
    } catch {
      /* closed */
    }
  })();
  return () => ctrl.abort();
}
