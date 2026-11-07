import { DatabaseSync, type StatementSync } from 'node:sqlite';

type Param = string | number | bigint | null | Uint8Array | undefined;

export type Decision = 'explicit' | 'candidate' | 'pass_through' | 'dropped' | 'fyi';
export type TriggerStatus = 'pending' | 'handled' | 'ignored' | 'dropped' | 'delivered';
export type WorkerStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface ThreadRow {
  id: number;
  key: string;
  source: string;
  title: string | null;
  url: string | null;
  subscribable: number;
  created_at: number;
  updated_at: number;
  meta: string | null;
}

export interface TriggerRow {
  id: number;
  external_id: string | null;
  source: string;
  kind: string;
  thread_id: number | null;
  author: string | null;
  text: string;
  url: string | null;
  meta: string | null;
  created_at: number;
  decision: Decision;
  reason: string | null;
  routed_to: string | null;
  status: TriggerStatus;
  router_turn_id: number | null;
}

export interface WorkerRow {
  id: number;
  title: string;
  task: string;
  agent: string;
  model: string | null;
  repo: string | null;
  cwd: string | null;
  branch: string | null;
  base: string | null;
  git_dir: string | null;
  status: WorkerStatus;
  agent_session: string | null;
  reply_thread_id: number | null;
  origin_trigger_id: number | null;
  silent: number;
  pr_url: string | null;
  summary: string | null;
  error: string | null;
  pid: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  run_count: number;
  archived: number;
}

export interface RunRow {
  id: number;
  worker_id: number;
  started_at: number;
  ended_at: number | null;
  status: string;
  exit_code: number | null;
  prompt: string;
  result: string | null;
  report: string | null;
}

export interface LogRow {
  id: number;
  worker_id: number;
  run_id: number | null;
  ts: number;
  kind: string;
  text: string;
}

export interface InboxRow {
  id: number;
  worker_id: number;
  trigger_id: number | null;
  sender: string;
  text: string;
  created_at: number;
  run_id: number | null;
}

export interface MessageRow {
  id: number;
  thread_id: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  meta: string | null;
  created_at: number;
}

export interface RouterTurnRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  batch_size: number;
  hop: number;
  input: string;
  output: string | null;
  actions: string | null;
  error: string | null;
  session: string | null;
}

export interface OutboxRow {
  id: number;
  thread_id: number;
  text: string;
  status: string;
  error: string | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, source TEXT NOT NULL, title TEXT, url TEXT,
  subscribable INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, meta TEXT);
CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY, external_id TEXT UNIQUE, source TEXT NOT NULL, kind TEXT NOT NULL,
  thread_id INTEGER, author TEXT, text TEXT NOT NULL DEFAULT '', url TEXT, meta TEXT,
  created_at INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT, routed_to TEXT,
  status TEXT NOT NULL, router_turn_id INTEGER);
CREATE INDEX IF NOT EXISTS triggers_status ON triggers(status);
CREATE INDEX IF NOT EXISTS triggers_thread ON triggers(thread_id);
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, task TEXT NOT NULL, agent TEXT NOT NULL, model TEXT,
  repo TEXT, cwd TEXT, branch TEXT, base TEXT, git_dir TEXT, status TEXT NOT NULL, agent_session TEXT,
  reply_thread_id INTEGER, origin_trigger_id INTEGER, silent INTEGER NOT NULL DEFAULT 0, pr_url TEXT,
  summary TEXT, error TEXT, pid INTEGER, created_by TEXT NOT NULL DEFAULT 'router',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
  run_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS worker_runs (
  id INTEGER PRIMARY KEY, worker_id INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL, exit_code INTEGER, prompt TEXT NOT NULL, result TEXT, report TEXT);
CREATE TABLE IF NOT EXISTS worker_logs (
  id INTEGER PRIMARY KEY, worker_id INTEGER NOT NULL, run_id INTEGER, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS worker_logs_worker ON worker_logs(worker_id, id);
CREATE TABLE IF NOT EXISTS subscriptions (
  worker_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (worker_id, thread_id));
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY, worker_id INTEGER NOT NULL, trigger_id INTEGER, sender TEXT NOT NULL, text TEXT NOT NULL,
  created_at INTEGER NOT NULL, run_id INTEGER);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS router_turns (
  id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, batch_size INTEGER NOT NULL, hop INTEGER NOT NULL,
  input TEXT NOT NULL, output TEXT, actions TEXT, error TEXT, session TEXT);
CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS watchdog_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL, worker_id INTEGER);
`;

export const LOCAL_THREAD_KEY = 'local:chat';

export class Store {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.upsertThread({ key: LOCAL_THREAD_KEY, source: 'local', title: 'Local chat', subscribable: false });
  }

  close(): void {
    this.db.close();
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private norm(p: Param[]): Exclude<Param, undefined>[] {
    return p.map((v) => (v === undefined ? null : v));
  }

  all<T>(sql: string, ...p: Param[]): T[] {
    return this.q(sql).all(...this.norm(p)) as T[];
  }

  get<T>(sql: string, ...p: Param[]): T | undefined {
    return this.q(sql).get(...this.norm(p)) as T | undefined;
  }

  run(sql: string, ...p: Param[]): { changes: number; id: number } {
    const r = this.q(sql).run(...this.norm(p));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  private update(table: string, id: number, fields: Record<string, Param>): void {
    const keys = Object.keys(fields).filter((k) => /^[a-z_]+$/.test(k));
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  }

  // ---- kv ----
  getKv(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  }
  setKv(key: string, value: string | null): void {
    if (value === null) this.run('DELETE FROM kv WHERE key = ?', key);
    else this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // ---- threads ----
  upsertThread(t: { key: string; source: string; title?: string | null; url?: string | null; subscribable: boolean }): ThreadRow {
    const now = Date.now();
    const existing = this.threadByKey(t.key);
    if (existing) {
      if ((t.title && t.title !== existing.title) || (t.url && t.url !== existing.url)) {
        this.update('threads', existing.id, { title: t.title ?? existing.title, url: t.url ?? existing.url, updated_at: now });
      }
      return this.threadById(existing.id)!;
    }
    const { id } = this.run(
      'INSERT INTO threads (key, source, title, url, subscribable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      t.key, t.source, t.title ?? null, t.url ?? null, t.subscribable ? 1 : 0, now, now,
    );
    return this.threadById(id)!;
  }
  threadById(id: number): ThreadRow | undefined {
    return this.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id);
  }
  threadByKey(key: string): ThreadRow | undefined {
    return this.get<ThreadRow>('SELECT * FROM threads WHERE key = ?', key);
  }
  localThread(): ThreadRow {
    return this.threadByKey(LOCAL_THREAD_KEY)!;
  }
  touchThread(id: number): void {
    this.run('UPDATE threads SET updated_at = ? WHERE id = ?', Date.now(), id);
  }
  recentThreads(limit = 20): ThreadRow[] {
    return this.all<ThreadRow>('SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?', limit);
  }
  threadEventCount(id: number): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM triggers WHERE thread_id = ?', id)?.n ?? 0;
  }

  // ---- triggers ----
  insertTrigger(t: {
    external_id?: string | null;
    source: string;
    kind: string;
    thread_id?: number | null;
    author?: string | null;
    text: string;
    url?: string | null;
    meta?: unknown;
    created_at?: number;
    decision: Decision;
    reason?: string | null;
    routed_to?: string | null;
    status: TriggerStatus;
  }): TriggerRow | null {
    if (t.external_id && this.get('SELECT id FROM triggers WHERE external_id = ?', t.external_id)) return null;
    const { id } = this.run(
      `INSERT INTO triggers (external_id, source, kind, thread_id, author, text, url, meta, created_at, decision, reason, routed_to, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.external_id ?? null, t.source, t.kind, t.thread_id ?? null, t.author ?? null, t.text, t.url ?? null,
      t.meta === undefined ? null : JSON.stringify(t.meta), t.created_at ?? Date.now(), t.decision, t.reason ?? null,
      t.routed_to ?? null, t.status,
    );
    if (t.thread_id) this.touchThread(t.thread_id);
    return this.triggerById(id)!;
  }
  triggerById(id: number): TriggerRow | undefined {
    return this.get<TriggerRow>('SELECT * FROM triggers WHERE id = ?', id);
  }
  updateTrigger(id: number, fields: Partial<Record<keyof TriggerRow, Param>>): void {
    this.update('triggers', id, fields);
  }
  pendingRouterTriggers(limit: number): TriggerRow[] {
    return this.all<TriggerRow>("SELECT * FROM triggers WHERE status = 'pending' ORDER BY id ASC LIMIT ?", limit);
  }
  /** Triggers that went straight to workers (or FYI) and that the router has not seen yet. */
  unseenFyi(limit = 30): TriggerRow[] {
    return this.all<TriggerRow>(
      "SELECT * FROM triggers WHERE decision IN ('pass_through', 'fyi') AND router_turn_id IS NULL ORDER BY id ASC LIMIT ?",
      limit,
    );
  }
  triggersInThread(threadId: number, limit = 15): TriggerRow[] {
    return this.all<TriggerRow>('SELECT * FROM triggers WHERE thread_id = ? ORDER BY id DESC LIMIT ?', threadId, limit).reverse();
  }
  listTriggers(limit = 100, beforeId?: number): TriggerRow[] {
    return beforeId
      ? this.all<TriggerRow>('SELECT * FROM triggers WHERE id < ? ORDER BY id DESC LIMIT ?', beforeId, limit)
      : this.all<TriggerRow>('SELECT * FROM triggers ORDER BY id DESC LIMIT ?', limit);
  }

  // ---- workers ----
  insertWorker(w: {
    title: string;
    task: string;
    agent: string;
    model?: string | null;
    repo?: string | null;
    reply_thread_id?: number | null;
    origin_trigger_id?: number | null;
    silent?: boolean;
    created_by: string;
  }): WorkerRow {
    const now = Date.now();
    const { id } = this.run(
      `INSERT INTO workers (title, task, agent, model, repo, status, reply_thread_id, origin_trigger_id, silent, created_by, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      w.title, w.task, w.agent, w.model ?? null, w.repo ?? null, w.reply_thread_id ?? null, w.origin_trigger_id ?? null,
      w.silent ? 1 : 0, w.created_by, now, now, now,
    );
    return this.workerById(id)!;
  }
  workerById(id: number): WorkerRow | undefined {
    return this.get<WorkerRow>('SELECT * FROM workers WHERE id = ?', id);
  }
  updateWorker(id: number, fields: Partial<Record<keyof WorkerRow, Param>>): void {
    this.update('workers', id, { ...fields, updated_at: Date.now() });
  }
  listWorkers(includeArchived = false, limit = 200): WorkerRow[] {
    return includeArchived
      ? this.all<WorkerRow>('SELECT * FROM workers ORDER BY id DESC LIMIT ?', limit)
      : this.all<WorkerRow>('SELECT * FROM workers WHERE archived = 0 ORDER BY id DESC LIMIT ?', limit);
  }
  workersWithStatus(...statuses: WorkerStatus[]): WorkerRow[] {
    return this.all<WorkerRow>(
      `SELECT * FROM workers WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id ASC`,
      ...statuses,
    );
  }

  // ---- runs & logs ----
  insertRun(workerId: number, prompt: string): RunRow {
    const { id } = this.run(
      "INSERT INTO worker_runs (worker_id, started_at, status, prompt) VALUES (?, ?, 'running', ?)",
      workerId, Date.now(), prompt,
    );
    return this.get<RunRow>('SELECT * FROM worker_runs WHERE id = ?', id)!;
  }
  updateRun(id: number, fields: Partial<Record<keyof RunRow, Param>>): void {
    this.update('worker_runs', id, fields);
  }
  runsForWorker(workerId: number): RunRow[] {
    return this.all<RunRow>('SELECT * FROM worker_runs WHERE worker_id = ? ORDER BY id ASC', workerId);
  }
  addLog(workerId: number, runId: number | null, kind: string, text: string): LogRow {
    const ts = Date.now();
    const { id } = this.run('INSERT INTO worker_logs (worker_id, run_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)', workerId, runId, ts, kind, text);
    return { id, worker_id: workerId, run_id: runId, ts, kind, text };
  }
  logs(workerId: number, afterId = 0, limit = 500): LogRow[] {
    return this.all<LogRow>('SELECT * FROM worker_logs WHERE worker_id = ? AND id > ? ORDER BY id ASC LIMIT ?', workerId, afterId, limit);
  }
  tailLogs(workerId: number, n = 20): LogRow[] {
    return this.all<LogRow>('SELECT * FROM worker_logs WHERE worker_id = ? ORDER BY id DESC LIMIT ?', workerId, n).reverse();
  }

  // ---- subscriptions ----
  subscribe(workerId: number, threadId: number): void {
    this.run('INSERT OR IGNORE INTO subscriptions (worker_id, thread_id, created_at) VALUES (?, ?, ?)', workerId, threadId, Date.now());
  }
  unsubscribe(workerId: number, threadId: number): void {
    this.run('DELETE FROM subscriptions WHERE worker_id = ? AND thread_id = ?', workerId, threadId);
  }
  unsubscribeAll(workerId: number): void {
    this.run('DELETE FROM subscriptions WHERE worker_id = ?', workerId);
  }
  subscribers(threadId: number): WorkerRow[] {
    return this.all<WorkerRow>(
      'SELECT w.* FROM workers w JOIN subscriptions s ON s.worker_id = w.id WHERE s.thread_id = ? ORDER BY w.id',
      threadId,
    );
  }
  threadsOf(workerId: number): ThreadRow[] {
    return this.all<ThreadRow>(
      'SELECT t.* FROM threads t JOIN subscriptions s ON s.thread_id = t.id WHERE s.worker_id = ? ORDER BY t.id',
      workerId,
    );
  }

  // ---- inbox ----
  addInbox(workerId: number, sender: string, text: string, triggerId?: number | null): void {
    this.run(
      'INSERT INTO inbox (worker_id, trigger_id, sender, text, created_at) VALUES (?, ?, ?, ?, ?)',
      workerId, triggerId ?? null, sender, text, Date.now(),
    );
  }
  undelivered(workerId: number): InboxRow[] {
    return this.all<InboxRow>('SELECT * FROM inbox WHERE worker_id = ? AND run_id IS NULL ORDER BY id ASC', workerId);
  }
  markDelivered(ids: number[], runId: number): void {
    for (const id of ids) this.run('UPDATE inbox SET run_id = ? WHERE id = ?', runId, id);
  }
  workersWithMail(): number[] {
    return this.all<{ worker_id: number }>('SELECT DISTINCT worker_id FROM inbox WHERE run_id IS NULL ORDER BY worker_id').map(
      (r) => r.worker_id,
    );
  }

  // ---- local chat messages ----
  addMessage(threadId: number, role: MessageRow['role'], text: string, meta?: unknown): MessageRow {
    const created_at = Date.now();
    const metaStr = meta === undefined ? null : JSON.stringify(meta);
    const { id } = this.run('INSERT INTO messages (thread_id, role, text, meta, created_at) VALUES (?, ?, ?, ?, ?)', threadId, role, text, metaStr, created_at);
    return { id, thread_id: threadId, role, text, meta: metaStr, created_at };
  }
  messages(threadId: number, limit = 200, beforeId?: number): MessageRow[] {
    const rows = beforeId
      ? this.all<MessageRow>('SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?', threadId, beforeId, limit)
      : this.all<MessageRow>('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?', threadId, limit);
    return rows.reverse();
  }

  // ---- outbox ----
  addOutbox(threadId: number, text: string): number {
    return this.run("INSERT INTO outbox (thread_id, text, status, created_at) VALUES (?, ?, 'sending', ?)", threadId, text, Date.now()).id;
  }
  updateOutbox(id: number, status: string, error?: string | null): void {
    this.run('UPDATE outbox SET status = ?, error = ? WHERE id = ?', status, error ?? null, id);
  }
  outboxForThread(threadId: number, limit = 10): OutboxRow[] {
    return this.all<OutboxRow>('SELECT * FROM outbox WHERE thread_id = ? ORDER BY id DESC LIMIT ?', threadId, limit).reverse();
  }

  // ---- router turns ----
  insertTurn(batchSize: number, hop: number, input: string): number {
    return this.run('INSERT INTO router_turns (started_at, batch_size, hop, input) VALUES (?, ?, ?, ?)', Date.now(), batchSize, hop, input).id;
  }
  updateTurn(id: number, fields: Partial<Record<keyof RouterTurnRow, Param>>): void {
    this.update('router_turns', id, fields);
  }
  recentTurns(limit = 50): RouterTurnRow[] {
    return this.all<RouterTurnRow>('SELECT * FROM router_turns ORDER BY id DESC LIMIT ?', limit);
  }

  // ---- memory ----
  addMemory(text: string): void {
    this.run('INSERT INTO memory (text, created_at) VALUES (?, ?)', text, Date.now());
  }
  memory(limit = 40): { id: number; text: string; created_at: number }[] {
    return this.all('SELECT * FROM memory ORDER BY id DESC LIMIT ?', limit);
  }
  deleteMemory(id: number): void {
    this.run('DELETE FROM memory WHERE id = ?', id);
  }

  // ---- watchdog ----
  addWatchdogEvent(level: string, text: string, workerId?: number | null): { id: number; ts: number; level: string; text: string; worker_id: number | null } {
    const ts = Date.now();
    const { id } = this.run('INSERT INTO watchdog_events (ts, level, text, worker_id) VALUES (?, ?, ?, ?)', ts, level, text, workerId ?? null);
    return { id, ts, level, text, worker_id: workerId ?? null };
  }
  watchdogEvents(limit = 50): { id: number; ts: number; level: string; text: string; worker_id: number | null }[] {
    return this.all('SELECT * FROM watchdog_events ORDER BY id DESC LIMIT ?', limit);
  }
}
