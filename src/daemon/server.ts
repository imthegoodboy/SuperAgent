import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { App } from './app.js';
import { publicConfig } from '../core/config.js';
import { UI_DIR, pkgVersion } from '../core/paths.js';
import { bus, emit, ref } from '../core/util.js';
import { autostartStatus, installSkill, openFolder, resolveRepoInput, setAutostart, skillStatus, type SkillTarget } from './system.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (ctx: { app: App; params: string[]; query: URLSearchParams; body: any; req: http.IncomingMessage }) => unknown | Promise<unknown>;

interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
}

function id(params: string[], i = 0): number {
  const n = Number(String(params[i]).replace(/^w#?/i, ''));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'bad id');
  return n;
}

function requireWorker(app: App, n: number) {
  const w = app.store.workerById(n);
  if (!w) throw new HttpError(404, `no worker ${ref.W(n)}`);
  return w;
}

const routes: Route[] = [];
function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), handler });
}

route('GET', '/api/state', ({ app }) => app.state());

route('GET', '/api/messages', ({ app, query }) => {
  const before = Number(query.get('before')) || undefined;
  return app.store.messages(app.store.localThread().id, Number(query.get('limit')) || 200, before);
});
route('POST', '/api/messages', ({ app, body }) => {
  const text = String(body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'text is required');
  return app.sendLocal(text);
});

route('GET', '/api/workers', ({ app, query }) => app.store.listWorkers(query.get('archived') === '1'));
route('POST', '/api/workers', ({ app, body }) => {
  const task = String(body?.task ?? '').trim();
  if (!task) throw new HttpError(400, 'task is required');
  try {
    return app.dispatchDirect({ task, title: body.title, agent: body.agent || undefined, repo: body.repo || undefined });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
route('GET', '/api/workers/:id', ({ app, params }) => {
  const w = requireWorker(app, id(params));
  return {
    worker: w,
    runs: app.store.runsForWorker(w.id).map((r) => ({ ...r, prompt: r.prompt.slice(0, 20_000) })),
    threads: app.store.threadsOf(w.id),
    replyThread: w.reply_thread_id ? app.store.threadById(w.reply_thread_id) : null,
    inbox: app.store.all('SELECT * FROM inbox WHERE worker_id = ? ORDER BY id DESC LIMIT 50', w.id),
    logs: app.store.tailLogs(w.id, 400),
    active: app.workers.isActive(w.id),
  };
});
route('GET', '/api/workers/:id/logs', ({ app, params, query }) => app.store.logs(id(params), Number(query.get('after')) || 0, 1000));
route('POST', '/api/workers/:id/message', ({ app, params, body }) => {
  const text = String(body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'text is required');
  try {
    app.workers.message(requireWorker(app, id(params)).id, 'user', text);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return { ok: true };
});
route('POST', '/api/workers/:id/stop', ({ app, params }) => {
  app.workers.stop(requireWorker(app, id(params)).id, 'stopped by you');
  return { ok: true };
});
route('POST', '/api/workers/:id/retry', ({ app, params }) => {
  try {
    app.workers.retry(requireWorker(app, id(params)).id);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return { ok: true };
});
route('POST', '/api/workers/:id/archive', async ({ app, params }) => {
  await app.workers.archive(requireWorker(app, id(params)).id);
  return { ok: true };
});
route('POST', '/api/workers/:id/open', ({ app, params }) => {
  const w = requireWorker(app, id(params));
  if (!w.cwd || !fs.existsSync(w.cwd)) throw new HttpError(400, 'workspace does not exist');
  openFolder(w.cwd);
  return { ok: true };
});

route('GET', '/api/triggers', ({ app, query }) => {
  const rows = app.store.listTriggers(Number(query.get('limit')) || 150, Number(query.get('before')) || undefined);
  const threads = new Map<number, unknown>();
  for (const t of rows) if (t.thread_id && !threads.has(t.thread_id)) threads.set(t.thread_id, app.store.threadById(t.thread_id));
  return { triggers: rows, threads: Object.fromEntries(threads) };
});

route('GET', '/api/router', ({ app }) => ({ status: app.router.status(), turns: app.store.recentTurns(40) }));
route('POST', '/api/router/reset', ({ app }) => {
  app.router.reset('reset from UI');
  return { ok: true };
});

route('GET', '/api/config', ({ app }) => publicConfig(app.config));
route('PUT', '/api/config', ({ app, body }) => publicConfig(app.updateConfig(body ?? {})));

route('POST', '/api/repos', async ({ app, body }) => {
  try {
    const repo = await resolveRepoInput(String(body?.input ?? ''), {
      mode: body?.mode || undefined,
      name: body?.name || undefined,
      agent: body?.agent || undefined,
      allowUsers: Array.isArray(body?.allowUsers) ? body.allowUsers.map(String) : undefined,
    });
    const repos = app.config.repos.filter((r) => r.name.toLowerCase() !== repo.name.toLowerCase());
    app.updateConfig({ repos: [...repos, repo] });
    return repo;
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
route('DELETE', '/api/repos/:name', ({ app, params }) => {
  const name = decodeURIComponent(params[0]).toLowerCase();
  app.updateConfig({ repos: app.config.repos.filter((r) => r.name.toLowerCase() !== name) });
  return { ok: true };
});

route('GET', '/api/agents', ({ app }) => app.agents);
route('POST', '/api/agents/refresh', async ({ app }) => app.refreshAgents());

route('GET', '/api/memory', ({ app }) => app.store.memory(200));
route('DELETE', '/api/memory/:id', ({ app, params }) => {
  app.store.deleteMemory(id(params));
  return { ok: true };
});

route('GET', '/api/watchdog', ({ app }) => app.store.watchdogEvents(100));
route('GET', '/api/watchdog/snapshot', ({ app }) => ({
  config: { workers: app.config.workers, watchdog: app.config.watchdog, router: app.config.router },
  router: app.router.status(),
  running: app.store.workersWithStatus('running').map((w) => {
    const run = app.store.get<{ started_at: number }>("SELECT started_at FROM worker_runs WHERE worker_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1", w.id);
    return {
      id: w.id,
      title: w.title,
      agent: w.agent,
      task: w.task.slice(0, 1500),
      last_activity_at: w.last_activity_at,
      run_started_at: run?.started_at ?? w.updated_at,
      active: app.workers.isActive(w.id),
      logs: app.store.tailLogs(w.id, 30).map((l) => `[${l.kind}] ${l.text.slice(0, 300)}`),
    };
  }),
}));
route('POST', '/api/watchdog/action', ({ app, body }) => {
  const type = String(body?.type ?? '');
  const workerId = body?.worker ? Number(body.worker) : null;
  const note = String(body?.note ?? body?.text ?? '').slice(0, 2000);
  const record = (level: string, text: string) => emit('watchdog', app.store.addWatchdogEvent(level, text, workerId));
  switch (type) {
    case 'event':
      record(String(body?.level ?? 'info'), note);
      return { ok: true };
    case 'restart_run': {
      const ok = workerId ? app.workers.restartRun(workerId, note) : false;
      if (ok) record('warn', `Restarted ${ref.W(workerId)}: ${note}`);
      return { ok };
    }
    case 'stop_worker': {
      if (!workerId) throw new HttpError(400, 'worker required');
      app.workers.stop(workerId, `watchdog: ${note}`);
      record('error', `Stopped ${ref.W(workerId)}: ${note}`);
      app.ingest.ingest({ source: 'watchdog', kind: 'alert', text: `Watchdog stopped ${ref.W(workerId)}: ${note}` });
      return { ok: true };
    }
    case 'reset_router':
      app.router.reset(`watchdog: ${note}`);
      record('warn', `Router session reset: ${note}`);
      return { ok: true };
    default:
      throw new HttpError(400, `unknown watchdog action ${type}`);
  }
});

route('GET', '/api/system', async ({ app }) => ({
  version: pkgVersion(),
  home: app.state().home,
  platform: process.platform,
  node: process.version,
  autostart: await autostartStatus(),
  skill: skillStatus(),
}));
route('POST', '/api/system/skill', ({ body }) => {
  const target: SkillTarget = body?.target === 'codex' ? 'codex' : 'claude';
  return { path: installSkill(target), skill: skillStatus() };
});
route('POST', '/api/system/autostart', async ({ body }) => ({ autostart: await setAutostart(!!body?.enabled) }));
route('POST', '/api/system/open-home', ({ app }) => {
  openFolder(app.state().home);
  return { ok: true };
});

route('POST', '/api/shutdown', ({ app }) => {
  setTimeout(() => app.onShutdown?.(), 100);
  return { ok: true };
});

// ---------- plumbing ----------

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(app: App, pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(path.resolve(UI_DIR) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Single-page app: unknown paths get the shell.
    if (!path.extname(rel)) return serveStatic(app, '/', res);
    return send(res, 404, 'not found');
  }
  let data: string | Buffer = fs.readFileSync(file);
  if (rel === 'index.html') data = data.toString('utf8').replace('__SA_TOKEN__', app.token);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(rel === 'index.html'
      ? { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" }
      : {}),
  });
  res.end(data);
}

function sse(app: App, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify(app.state())}\n\n`);
  const onEvent = (ev: { type: string; data: unknown }) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
}

export function createServer(app: App): http.Server {
  return http.createServer(async (req, res) => {
    const port = app.config.port;
    const host = String(req.headers.host ?? '');
    // DNS-rebinding guard: only answer to our own loopback names.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, 'misdirected request');
    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';

    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, name: 'superagent', version: pkgVersion(), pid: process.pid, uptime: Date.now() - app.startedAt });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET') return send(res, 405, 'method not allowed');
      return serveStatic(app, url.pathname, res);
    }

    // CSRF guard: browsers attach Origin to cross-site requests; only our own pages may call us.
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: 'forbidden origin' });
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    if (auth !== app.token) return send(res, 401, { error: 'unauthorized' });

    if (url.pathname === '/api/events' && method === 'GET') return sse(app, req, res);

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      try {
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
        const out = await r.handler({ app, params: m.slice(1), query: url.searchParams, body, req });
        return send(res, 200, out ?? { ok: true });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        return send(res, status, { error: (e as Error).message ?? String(e) });
      }
    }
    return send(res, 404, { error: 'not found' });
  });
}
