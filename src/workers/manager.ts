import type { App } from '../daemon/app.js';
import type { AgentId } from '../core/config.js';
import type { WorkerRow, WorkerStatus } from '../core/store.js';
import { emit, log, ref, snippet, tail } from '../core/util.js';
import { adapterFor, type AgentEvent } from '../agents/adapters.js';
import { startWorkerRun } from '../agents/runner.js';
import { findPrUrl, firstPrompt, followupPrompt, parseReport, workerSystem } from './prompts.js';
import { prepareWorkspace, removeWorkspace, type Workspace } from './workspace.js';

interface ActiveRun {
  runId: number;
  kill: () => void;
  /** Why the run is being ended early, if it is. */
  ending: null | 'stopped' | 'restart' | 'shutdown';
}

export interface CreateWorker {
  title: string;
  task: string;
  agent: AgentId;
  repo: string | null;
  threads?: number[];
  replyThreadId?: number | null;
  originTriggerId?: number | null;
  silent?: boolean;
  createdBy: 'router' | 'user';
}

const PR_THREAD_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

export class WorkerManager {
  private active = new Map<number, ActiveRun>();
  private lastTouch = new Map<number, number>();

  constructor(private app: App) {}

  get runningCount(): number {
    return this.active.size;
  }

  isActive(id: number): boolean {
    return this.active.has(id);
  }

  private announce(w: WorkerRow, text: string, event: string): void {
    if (w.reply_thread_id !== this.app.store.localThread().id && w.created_by !== 'user') return;
    const m = this.app.store.addMessage(this.app.store.localThread().id, 'system', text, { worker: w.id, event });
    emit('message', m);
  }

  private changed(id: number): void {
    emit('worker', this.app.store.workerById(id));
  }

  create(spec: CreateWorker): WorkerRow {
    const { store } = this.app;
    const w = store.insertWorker({
      title: spec.title.slice(0, 120),
      task: spec.task,
      agent: spec.agent,
      repo: spec.repo,
      reply_thread_id: spec.replyThreadId ?? store.localThread().id,
      origin_trigger_id: spec.originTriggerId ?? null,
      silent: spec.silent,
      created_by: spec.createdBy,
    });
    const threads = new Set(spec.threads ?? []);
    const origin = spec.originTriggerId ? store.triggerById(spec.originTriggerId) : null;
    if (origin?.thread_id) threads.add(origin.thread_id);
    for (const th of threads) if (store.threadById(th)?.subscribable) store.subscribe(w.id, th);
    log(`worker ${ref.W(w.id)} created (${spec.agent}): ${w.title}`);
    if (!spec.silent) this.announce(w, `Started ${ref.W(w.id)} · ${w.title}`, 'started');
    this.changed(w.id);
    this.schedule();
    return store.workerById(w.id)!;
  }

  /** New mail arrived for a worker (pass-through or message); run it when a slot is free. */
  wake(_id: number): void {
    this.schedule();
  }

  message(id: number, sender: string, text: string): void {
    const w = this.app.store.workerById(id);
    if (!w) throw new Error(`unknown worker ${ref.W(id)}`);
    if (w.archived) throw new Error(`${ref.W(id)} is archived; its workspace was removed`);
    this.app.store.addInbox(id, sender, text);
    if (w.status === 'stopped') this.app.store.updateWorker(id, { status: 'waiting' });
    this.app.store.addLog(id, null, 'inbox', `(${sender}) ${text}`);
    emit('worker_log', this.app.store.tailLogs(id, 1)[0]);
    this.changed(id);
    this.schedule();
  }

  stop(id: number, reason: string): void {
    const { store } = this.app;
    const w = store.workerById(id);
    if (!w) return;
    store.unsubscribeAll(id);
    store.run('UPDATE inbox SET run_id = -1 WHERE worker_id = ? AND run_id IS NULL', id);
    store.updateWorker(id, { status: 'stopped', pid: null });
    store.addLog(id, null, 'system', `Stopped: ${reason}`);
    const a = this.active.get(id);
    if (a) {
      a.ending = 'stopped';
      a.kill();
    }
    this.announce(w, `Stopped ${ref.W(id)} · ${reason}`, 'stopped');
    this.changed(id);
  }

  /** Watchdog: end the current run and resume it with a nudge in the inbox. */
  restartRun(id: number, note: string): boolean {
    const a = this.active.get(id);
    if (!a || !a.runId) return false;
    this.app.store.addInbox(id, 'watchdog', note);
    a.ending = 'restart';
    a.kill();
    return true;
  }

  async archive(id: number): Promise<void> {
    const w = this.app.store.workerById(id);
    if (!w) return;
    if (this.active.has(id) || ['queued', 'running'].includes(w.status)) this.stop(id, 'archived');
    await removeWorkspace(w);
    this.app.store.unsubscribeAll(id);
    this.app.store.updateWorker(id, { archived: 1 });
    this.changed(id);
  }

  retry(id: number): void {
    const w = this.app.store.workerById(id);
    if (!w || w.archived) throw new Error(`cannot retry ${ref.W(id)}`);
    if (this.active.has(id)) return;
    this.app.store.updateWorker(id, { status: 'queued', error: null });
    if (w.agent_session) this.app.store.addInbox(id, 'user', 'Please try again: continue the task from where you left off.');
    this.changed(id);
    this.schedule();
  }

  private needsRun(w: WorkerRow): boolean {
    if (w.archived || this.active.has(w.id)) return false;
    if (w.status === 'queued') return true;
    return this.app.store.undelivered(w.id).length > 0;
  }

  schedule(): void {
    const { store } = this.app;
    const max = this.app.config.workers.maxConcurrent;
    if (this.active.size >= max) return;
    const ids = new Set<number>([...store.workersWithStatus('queued').map((w) => w.id), ...store.workersWithMail()]);
    for (const id of [...ids].sort((a, b) => a - b)) {
      if (this.active.size >= max) break;
      const w = store.workerById(id);
      if (w && this.needsRun(w)) void this.startRun(w);
    }
  }

  private async startRun(w0: WorkerRow): Promise<void> {
    const { store, config } = this.app;
    const id = w0.id;
    const entry: ActiveRun = { runId: 0, kill: () => {}, ending: null };
    this.active.set(id, entry);
    try {
      let w = store.workerById(id)!;
      const repo = this.app.findRepo(w.repo ?? undefined);
      const adapter = adapterFor(w.agent);
      if (!adapter) throw new Error(`Unknown agent "${w.agent}"`);
      let ws: Workspace;
      if (!w.cwd) {
        store.updateWorker(id, { status: 'running' });
        this.changed(id);
        ws = await prepareWorkspace(w, repo);
        store.updateWorker(id, { cwd: ws.cwd, branch: ws.branch, base: ws.base, git_dir: ws.gitDir });
      } else ws = { cwd: w.cwd, branch: w.branch, base: w.base, gitDir: w.git_dir };
      if (entry.ending) return;

      w = store.workerById(id)!;
      const inbox = store.undelivered(id);
      const fresh = !w.agent_session;
      const prompt = fresh ? firstPrompt(this.app, w, ws, inbox) : followupPrompt(w, inbox);
      const run = store.insertRun(id, prompt);
      entry.runId = run.id;
      store.markDelivered(inbox.map((m) => m.id), run.id);
      store.updateWorker(id, { status: 'running', run_count: w.run_count + 1, last_activity_at: Date.now(), error: null });
      const startLog = store.addLog(
        id,
        run.id,
        'system',
        fresh ? `${adapter.label} started in ${ws.cwd}` : `${adapter.label} resumed with ${inbox.length} new message${inbox.length === 1 ? '' : 's'}`,
      );
      emit('worker_log', startLog);
      this.changed(id);

      const handle = startWorkerRun(
        adapter,
        {
          cwd: ws.cwd,
          prompt,
          session: w.agent_session,
          model: w.model || config.agents[w.agent as AgentId]?.model || '',
          system: workerSystem(this.app, w, ws),
          autonomy: config.workers.autonomy,
          writableDirs: ws.gitDir ? [ws.gitDir] : [],
        },
        (ev) => this.onEvent(id, run.id, ev),
        config.workers.maxRunMinutes * 60_000,
      );
      entry.kill = handle.kill;
      if (entry.ending) handle.kill();
      store.updateWorker(id, { pid: handle.pid ?? null });
      const res = await handle.done;
      this.finish(id, run.id, res, entry, fresh);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log(`worker ${ref.W(id)} failed to start:`, msg);
      store.updateWorker(id, { status: 'failed', error: msg, pid: null });
      store.addLog(id, entry.runId || null, 'error', msg);
      this.report(id, 'failed', '', null, null, msg);
      this.changed(id);
    } finally {
      this.active.delete(id);
      this.schedule();
    }
  }

  private onEvent(id: number, runId: number, ev: AgentEvent): void {
    const { store } = this.app;
    if (ev.kind === 'session') {
      if (store.workerById(id)?.agent_session !== ev.id) store.updateWorker(id, { agent_session: ev.id });
      return;
    }
    if (ev.kind === 'final') return;
    const row = store.addLog(id, runId, ev.kind, ev.text.slice(0, 20_000));
    emit('worker_log', row);
    const now = Date.now();
    if (now - (this.lastTouch.get(id) ?? 0) > 2000) {
      this.lastTouch.set(id, now);
      store.run('UPDATE workers SET last_activity_at = ? WHERE id = ?', now, id);
    }
  }

  private finish(
    id: number,
    runId: number,
    res: { code: number | null; session: string | null; finalText: string; error: string | null },
    entry: ActiveRun,
    fresh: boolean,
  ): void {
    const { store } = this.app;
    const w = store.workerById(id)!;
    const ended = Date.now();
    if (entry.ending === 'stopped' || entry.ending === 'shutdown') {
      store.updateRun(runId, { status: entry.ending, ended_at: ended, exit_code: res.code });
      return;
    }
    if (entry.ending === 'restart') {
      store.updateRun(runId, { status: 'restarted', ended_at: ended, exit_code: res.code });
      store.updateWorker(id, { status: 'queued', pid: null });
      store.addLog(id, runId, 'system', 'Run restarted by the watchdog');
      this.changed(id);
      return;
    }

    // A resumed session that no longer exists: start over with the original task.
    if (!fresh && res.error && /no (conversation|session|thread)|not found|could not find|unknown session/i.test(res.error)) {
      store.run('UPDATE inbox SET run_id = NULL WHERE run_id = ?', runId);
      store.updateRun(runId, { status: 'failed', ended_at: ended, exit_code: res.code, result: res.error });
      store.updateWorker(id, { agent_session: null, status: 'queued', pid: null });
      store.addLog(id, runId, 'system', 'Previous agent session is gone; starting the task again in the same workspace.');
      this.changed(id);
      return;
    }

    const report = parseReport(res.finalText);
    let status: WorkerStatus;
    let error: string | null = null;
    let summary: string;
    if (report) {
      status = report.status === 'needs_input' ? 'waiting' : report.status;
      summary = report.summary || snippet(res.finalText, 600);
    } else if (res.error) {
      status = 'failed';
      error = res.error;
      summary = '';
    } else {
      status = 'done';
      summary = snippet(res.finalText, 600) || 'Finished without a report.';
    }
    const pr = report?.pr_url ?? findPrUrl(res.finalText);
    store.updateRun(runId, {
      status,
      ended_at: ended,
      exit_code: res.code,
      result: tail(res.finalText, 20_000),
      report: report ? JSON.stringify(report) : null,
    });
    store.updateWorker(id, {
      status,
      summary: summary || w.summary,
      error,
      pr_url: pr ?? w.pr_url,
      pid: null,
      last_activity_at: ended,
    });
    if (pr && pr !== w.pr_url) this.followPr(id, pr);
    const endLog = store.addLog(id, runId, status === 'failed' ? 'error' : 'system', `Run finished: ${status}${error ? ` · ${snippet(error, 300)}` : ''}`);
    emit('worker_log', endLog);
    this.report(id, report?.status ?? (error ? 'failed' : 'done'), summary, pr, report?.question ?? null, error);
    const verb = status === 'done' ? 'Finished' : status === 'waiting' ? 'Needs input' : 'Failed';
    if (!w.silent || status === 'done') this.announce(w, `${verb} ${ref.W(id)} · ${w.title}`, status);
    this.changed(id);
  }

  private followPr(id: number, url: string): void {
    const m = url.match(PR_THREAD_RE);
    if (!m) return;
    const th = this.app.store.upsertThread({
      key: `github:${m[1]}#${m[2]}`,
      source: 'github',
      title: `PR #${m[2]} (${m[1]})`,
      url,
      subscribable: true,
    });
    this.app.store.subscribe(id, th.id);
  }

  private report(id: number, status: string, summary: string, pr: string | null, question: string | null, error: string | null): void {
    this.app.ingest.ingest({
      source: 'worker',
      kind: 'report',
      text: summary || error || '(no summary)',
      meta: { worker: id, status, pr_url: pr, question, error },
    });
  }

  /** After a crash or reboot: runs that were in flight resume from their saved agent session. */
  recover(): void {
    const { store } = this.app;
    store.run("UPDATE worker_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'", Date.now());
    for (const w of store.workersWithStatus('running')) {
      store.addInbox(
        w.id,
        'system',
        'SuperAgent restarted while you were working. Check the current state of your workspace (git status, files) and continue the task.',
      );
      store.updateWorker(w.id, { status: 'queued', pid: null });
      log(`worker ${ref.W(w.id)} will resume after restart`);
    }
    this.schedule();
  }

  /** Daemon is exiting: stop agent processes; they resume from their sessions on next start. */
  shutdown(): void {
    for (const [id, a] of this.active) {
      a.ending = 'shutdown';
      a.kill();
      this.app.store.updateWorker(id, { status: 'running' });
    }
  }
}
