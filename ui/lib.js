// Small helpers shared by every view: API, live events, DOM building, markdown, formatting.

// The desktop app and `superagent open` pass the API token once as ?t=…; we keep it in this
// browser's storage and drop it from the address bar. The served page itself contains no secret.
function readToken() {
  const fromUrl = new URLSearchParams(location.search).get('t');
  if (fromUrl) {
    try {
      localStorage.setItem('sa-token', fromUrl);
    } catch {
      /* storage blocked: keep it for this page only */
    }
    history.replaceState(null, '', location.pathname + location.hash);
    return fromUrl;
  }
  try {
    return localStorage.getItem('sa-token') ?? '';
  } catch {
    return '';
  }
}

export const token = readToken();

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---------- tiny reactive store ----------

const listeners = new Set();
export function listen(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function publish(type, data) {
  for (const fn of [...listeners]) {
    try {
      fn(type, data);
    } catch (e) {
      console.error(e);
    }
  }
}

export function connect() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener('hello', (e) => publish('hello', JSON.parse(e.data)));
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      publish(ev.type, ev.data);
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => publish('disconnected', null);
  return es;
}

// ---------- DOM ----------

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const ICONS = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  tasks: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="M13 3.5 10.5 6 13 8.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  github: '<path d="M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  telegram: '<path d="M21 4 3 11l6 2 2 6 3-4 5 4z"/><path d="m9 13 8-6"/>',
  you: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  worker: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  router: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8.5 12H16M12 12l4-5M12 12l4 5"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return span;
}

// ---------- markdown (safe subset) ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
}

export function md(text) {
  const blocks = [];
  const src = esc(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of src.split('\n')) {
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const hd = line.match(/^(#{1,4})\s+(.*)$/);
    const blk = line.match(/^\u0000(\d+)\u0000$/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)[1]);
      continue;
    }
    flush();
    if (blk) out.push(blocks[Number(blk[1])]);
    else if (hd) out.push(`<p class="md-h">${inline(hd[2])}</p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

// ---------- formatting ----------

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function dur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const AGENTS = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  mock: 'Mock',
};

export const STATUS_TEXT = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs input',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

export function agentDot(agent) {
  return h('span', { class: `dot agent-${agent}`, title: AGENTS[agent] ?? agent });
}

export function toast(text, kind = 'ok') {
  let host = document.getElementById('toasts');
  if (!host) host = document.body.appendChild(h('div', { id: 'toasts', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast toast-${kind}` }, text);
  host.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

/** Activity track: one tick per worker event, coloured by kind. The live pulse of parallel work. */
const tracks = new Map();
export function trackTicks(workerId) {
  return tracks.get(workerId) ?? [];
}
export function seedTicks(workerId, kinds) {
  tracks.set(workerId, kinds.slice(-48));
}
export function pushTick(workerId, kind) {
  const list = tracks.get(workerId) ?? [];
  list.push(kind);
  if (list.length > 48) list.splice(0, list.length - 48);
  tracks.set(workerId, list);
}
export function track(workerId, live = false) {
  const el = h('span', { class: `track${live ? ' live' : ''}`, 'data-track': workerId, 'aria-hidden': 'true' });
  for (const k of trackTicks(workerId)) el.append(h('i', { class: `t-${k}` }));
  return el;
}
export function refreshTracks(workerId, kind) {
  for (const el of document.querySelectorAll(`[data-track="${workerId}"]`)) {
    el.append(h('i', { class: `t-${kind} new` }));
    while (el.children.length > 48) el.firstChild.remove();
  }
}
