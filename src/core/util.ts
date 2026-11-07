import { EventEmitter } from 'node:events';

/** Process-wide event bus; the HTTP server fans these out to the UI over SSE. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type: string, data: unknown): void {
  bus.emit('event', { type, data });
}

// ---- object references (Chain of Recall IDs) ----

export type RefKind = 'T' | 'TH' | 'W';

export const ref = {
  T: (n: number | null | undefined) => (n ? `T#${n}` : ''),
  TH: (n: number | null | undefined) => (n ? `TH#${n}` : ''),
  W: (n: number | null | undefined) => (n ? `W#${n}` : ''),
};

export function parseRef(s: unknown): { kind: RefKind; id: number } | null {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const m = String(s).trim().match(/^(TH|T|W)\s*#?\s*(\d+)$/i);
  if (!m) return null;
  return { kind: m[1].toUpperCase() as RefKind, id: Number(m[2]) };
}

export function parseRefOf(kind: RefKind, s: unknown): number | null {
  const r = parseRef(s);
  if (r && r.kind === kind) return r.id;
  if (typeof s === 'number' || (typeof s === 'string' && /^\d+$/.test(s.trim()))) return Number(s);
  return null;
}

// ---- text (Inline & Spill helpers) ----

export function oneLine(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Keep the first `max` chars; say how much was spilled so the model knows it can recall the rest. */
export function clip(s: string | null | undefined, max: number, hint?: string): string {
  const text = s ?? '';
  if (text.length <= max) return text;
  const more = text.length - max;
  return `${text.slice(0, max).trimEnd()}… [+${more} chars${hint ? `: ${hint}` : ''}]`;
}

export function snippet(s: string | null | undefined, max: number, hint?: string): string {
  return clip(oneLine(s), max, hint);
}

export function tail(s: string | null | undefined, max: number): string {
  const text = s ?? '';
  return text.length <= max ? text : '…' + text.slice(text.length - max);
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'task'
  );
}

export function tryJson<T = any>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Pull the first balanced JSON object out of free text (models sometimes wrap JSON in prose or fences). */
export function extractJsonObject(text: string): any | null {
  const direct = tryJson(text.trim());
  if (direct && typeof direct === 'object') return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const v = tryJson(fence[1].trim());
    if (v && typeof v === 'object') return v;
  }
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        const v = tryJson(text.slice(start, i + 1));
        if (v && typeof v === 'object') return v;
        break;
      }
    }
  }
  return null;
}

export function log(...args: unknown[]): void {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  console.log(`[${ts}]`, ...args);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
