import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { paths } from '../core/paths.js';

export function baseUrl(): string {
  return `http://127.0.0.1:${loadConfig().port}`;
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
    return j?.name === 'superagent' ? j : null;
  } catch {
    return null;
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('SuperAgent is not running. Start it with: superagent start');
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
  return j as T;
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
