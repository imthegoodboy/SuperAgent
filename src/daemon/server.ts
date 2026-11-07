import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { App } from './app.js';
import { publicConfig } from '../core/config.js';
import { HOME_ID, paths, pkgVersion } from '../core/paths.js';
import { bus, emit, parseRef, ref } from '../core/util.js';
import { graphData, renderGraphMermaid, renderGraphTree, renderRecall } from '../router/render.js';
import { LeaseConflict, normalizeActions } from '../router/router.js';
import { addRepo, resolveRepoInput } from './system.js';
import type { AddressInfo } from 'node:net';
import { run } from '../agents/process.js';
import { serve } from '../cli/preview.js';

// The API is for the `superagent` CLI, which agents (Claude Code, Codex, …) drive. There is no web UI.

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (ctx: {
  app: App;
  params: string[];
  query: URLSearchParams;
  body: any;
  req: http.IncomingMessage;
  /** Aborted when the client goes away (long polls stop waiting). */
  signal: AbortSignal;
}) => unknown | Promise<unknown>;

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

/** Time each worker's agent has spent on its runs so far. */
function elapsedByWorker(app: App): Map<number, number> {
  const rows = app.store.all<{ worker_id: number; ms: number }>('SELECT worker_id, SUM(COALESCE(ended_at, ?) - started_at) AS ms FROM worker_runs GROUP BY worker_id', Date.now());
  return new Map(rows.map((r) => [r.worker_id, r.ms]));
}

/** Folders `superagent serve` asked the service to serve, by folder. They live as long as the service. */
const served = new Map<string, { server: http.Server; url: string }>();

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

// ---------- the router, for an attached agent session ----------

/** The calling agent session's identity, when its harness exposes one (sent by the CLI). */
const sessionOf = (req: http.IncomingMessage): string | null => String(req.headers['x-superagent-session'] ?? '').slice(0, 200) || null;
/** Where the calling session runs, shown to anyone the lease turns away. */
const whoOf = (req: http.IncomingMessage): string | null => {
  const raw = String(req.headers['x-superagent-client'] ?? '');
  try {
    return decodeURIComponent(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) || null;
  } catch {
    return null;
  }
};

/** Router commands from a session that does not hold the lease get 409 with the reason. */
async function asRouter<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LeaseConflict) throw new HttpError(409, e.message);
    throw e;
  }
}

route('POST', '/api/router/attach', ({ app, body, req }) => asRouter(() => app.router.attach(!!body?.take, sessionOf(req), whoOf(req))));
route('POST', '/api/router/detach', ({ app, req }) =>
  asRouter(() => {
    app.router.detach(sessionOf(req));
    return { ok: true };
  }),
);
route('GET', '/api/router/events', ({ app, query, signal, req }) => {
  if (query.get('peek')) return asRouter(() => ({ text: app.router.pendingText(sessionOf(req)) }));
  if (query.get('again')) return asRouter(() => ({ text: app.router.lastBatch(sessionOf(req)) }));
  // fetch() gives up on a response after 300 s, so long polls stay below that.
  const wait = Math.min(280, Math.max(0, Number(query.get('wait')) || 0));
  return asRouter(() => app.router.events(wait * 1000, signal, sessionOf(req), whoOf(req)));
});
route('POST', '/api/router/actions', ({ app, body, req }) => {
  const raw = Array.isArray(body?.actions) ? body.actions : body ? [body] : [];
  const actions = normalizeActions(raw);
  if (actions.length !== raw.length) throw new HttpError(400, `unknown action type in ${JSON.stringify(raw.map((a: any) => a?.type))}`);
  if (!actions.length) throw new HttpError(400, 'no actions');
  return asRouter(() => app.router.act(actions, sessionOf(req), whoOf(req)));
});
route('GET', '/api/router/peek', ({ app, req }) => app.router.peek(sessionOf(req)));
route('GET', '/api/recall', ({ app, query }) => {
  const ids = String(query.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'ids is required, e.g. ids=W#3,TH#8');
  const text = renderRecall(app, ids);
  const missing = ids.filter((id) => {
    const r = parseRef(id);
    if (!r) return true;
    return !(r.kind === 'T' ? app.store.triggerById(r.id) : r.kind === 'TH' ? app.store.threadById(r.id) : app.store.workerById(r.id));
  });
  return { text, missing };
});
route('GET', '/api/graph', ({ app, query }) => {
  const g = graphData(app, !!query.get('all'));
  return { ...g, tree: renderGraphTree(g), mermaid: renderGraphMermaid(g) };
});

route('GET', '/api/workers', ({ app, query }) => {
  // ?ids=3,4: just those (any age; the list itself is capped).
  const ids = String(query.get('ids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const rows = ids.length
    ? ids.map((n) => app.store.workerById(n)).filter((w): w is NonNullable<typeof w> => !!w)
    : app.store.listWorkers(query.get('archived') === 'only' ? 'archived' : query.get('archived') === '1' ? 'all' : 'current');
  const ms = elapsedByWorker(app);
  return rows.map((w) =>
    // Active workers carry their last step and why they wait.
    ['queued', 'running', 'waiting'].includes(w.status)
      ? {
          ...w,
          elapsed_ms: ms.get(w.id) ?? 0,
          ticks: app.store.tailLogs(w.id, 48).map((l) => l.kind),
          last: app.store.tailLogs(w.id, 1)[0]?.text.split('\n')[0].slice(0, 200) ?? null,
          waiting: app.workers.queueReason(w)?.detail ?? null,
        }
      : { ...w, elapsed_ms: ms.get(w.id) ?? 0 },
  );
});

// `superagent serve`: the service keeps the folder served, so the command returns at once.
route('POST', '/api/serve', async ({ body }) => {
  const root = path.resolve(String(body?.root ?? ''));
  if (!body?.root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new HttpError(400, `not a folder: ${root}`);
  const page = String(body?.page ?? '').replace(/^\/+/, '');
  const known = served.get(root);
  if (known && (!body?.port || new URL(known.url).port === String(body.port))) return { url: known.url + page, folder: root, reused: true };
  if (known) {
    known.server.close();
    served.delete(root);
  }
  if (served.size >= 20) throw new HttpError(400, 'already serving 20 folders; stop some with `superagent serve --stop`');
  let server: http.Server;
  try {
    server = await serve(root, Number(body?.port) || 0);
  } catch (e) {
    throw new HttpError(400, `could not serve on port ${body?.port}: ${(e as Error).message}`);
  }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  served.set(root, { server, url });
  return { url: url + page, folder: root, reused: false };
});
route('GET', '/api/serve', () => [...served.entries()].map(([folder, s]) => ({ folder, url: s.url })));
route('DELETE', '/api/serve', ({ query }) => {
  const only = query.get('root') ? path.resolve(String(query.get('root'))) : null;
  const stopped: string[] = [];
  for (const [folder, s] of served) {
    if (only && folder !== only) continue;
    s.server.close();
    served.delete(folder);
    stopped.push(folder);
  }
  return { stopped };
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
route('POST', '/api/workers/cleanup', async ({ app, body }) => {
  const days = Number(body?.days ?? 7);
  if (!Number.isFinite(days) || days < 0) throw new HttpError(400, 'days must be 0 or more');
  const archived = await app.workers.cleanup(days, !!body?.dryRun);
  if (body?.dryRun) return { archived: archived.map((id) => ref.W(id)), dryRun: true };
  // Worktrees whose folders are gone (deleted by hand, say) are forgotten by git too.
  for (const repo of app.config.repos) {
    const dir = repo.path ?? (repo.slug ? path.join(paths.repos, ...repo.slug.split('/')) : null);
    if (dir && fs.existsSync(path.join(dir, '.git'))) await run('git', ['-C', dir, 'worktree', 'prune']); // never clone just to prune
  }
  return { archived: archived.map((id) => ref.W(id)) };
});
route('POST', '/api/workers/:id/archive', async ({ app, params }) => {
  await app.workers.archive(requireWorker(app, id(params)).id);
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
route('PUT', '/api/config', ({ app, body }) => {
  try {
    return publicConfig(app.updateConfig(body ?? {}));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

route('POST', '/api/repos', async ({ app, body }) => {
  try {
    const repo = await resolveRepoInput(String(body?.input ?? ''), {
      mode: body?.mode || undefined,
      name: body?.name || undefined,
      agent: body?.agent || undefined,
      allowUsers: Array.isArray(body?.allowUsers) ? body.allowUsers.map(String) : undefined,
    });
    const added = addRepo(app.config.repos, repo, {
      mode: body?.mode || undefined,
      name: body?.name || undefined,
      agent: body?.agent || undefined,
      allowUsers: Array.isArray(body?.allowUsers) ? body.allowUsers.map(String) : undefined,
    });
    app.updateConfig({ repos: added.repos });
    return added.repo;
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
    const port = app.listenPort || app.config.port;
    const host = String(req.headers.host ?? '');
    // DNS-rebinding guard: only answer to our own loopback names.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, 'misdirected request');
    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';

    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, name: 'superagent', home: HOME_ID, version: pkgVersion(), pid: process.pid, uptime: Date.now() - app.startedAt });
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'SuperAgent has no web pages. Use the `superagent` CLI.');

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
      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      try {
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
        const out = await r.handler({ app, params: m.slice(1), query: url.searchParams, body, req, signal: ctrl.signal });
        if (res.destroyed) return;
        return send(res, 200, out ?? { ok: true });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        return send(res, status, { error: (e as Error).message ?? String(e) });
      }
    }
    return send(res, 404, { error: 'not found' });
  });
}
