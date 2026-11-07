import os from 'node:os';
import type { App } from '../daemon/app.js';
import type { AgentId } from '../core/config.js';
import type { WorkerRow, WorkerStatus } from '../core/store.js';
import { emit, log, ref, snippet, tail } from '../core/util.js';
import { adapterFor, type AgentEvent } from '../agents/adapters.js';
import { isAlive, killTree, processStartTime } from '../agents/process.js';
import { startWorkerRun } from '../agents/runner.js';
import { findPrUrl, firstPrompt, followupPrompt, parseReport, workerSystem } from './prompts.js';
import { prepareWorkspace, removeWorkspace, syncBranch, type Workspace } from './workspace.js';

interface ActiveRun {
  runId: number;
  kill: () => void;
  /** Why the run is being ended early, if it is. */
  ending: null | 'stopped' | 'restart' | 'shutdown';
  /** Who restarted it: the watchdog, or the router redirecting it. */
  restartBy?: string;
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
  /** Branch or ref to start from instead of the repo's default branch. */
  base?: string | null;
  /** Start only after this worker is done. */
  after?: number | null;
  createdBy: 'router' | 'user';
}

const PR_THREAD_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** The agent's saved session no longer exists (and only that: "module not found" must not reset a task). */
export const SESSION_GONE =
  /\b(no|unknown|could not find|cannot find|couldn't find|invalid)\b[^\n]{0,30}\b(conversation|session|thread)\b|\b(conversation|session|thread)\b[^\n]{0,30}\b(not found|does not exist|doesn't exist|expired)\b/i;

export class WorkerManager {
  private active = new Map<number, ActiveRun>();
  private memoryTimer: NodeJS.Timeout | null = null;
  private memoryNoted = 0;
  /** Branches still being copied from a worker's own clone into the repo (a dependent waits for them). */
  private syncing = new Map<number, Promise<void>>();

  /** Less free memory than workers.minFreeMemoryMB (logged at most every 10 minutes). */
  private lowMemory(): boolean {
    const freeMB = Math.round(os.freemem() / 1048576);
    const low = freeMB < this.app.config.workers.minFreeMemoryMB;
    if (low && Date.now() - this.memoryNoted > 10 * 60_000) {
      this.memoryNoted = Date.now();
      log(`only ${freeMB} MB of memory free (workers.minFreeMemoryMB is ${this.app.config.workers.minFreeMemoryMB}); queued workers wait`);
    }
    return low;
  }
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
      base: spec.base ?? null,
      after_worker: spec.after ?? null,
      created_by: spec.createdBy,
    });
    const threads = new Set(spec.threads ?? []);
    const origin = spec.originTriggerId ? store.triggerById(spec.originTriggerId) : null;
    if (origin?.thread_id) threads.add(origin.thread_id);
    for (const th of threads) if (store.threadById(th)?.subscribable) store.subscribe(w.id, th);
    log(`worker ${ref.W(w.id)} created (${spec.agent}): ${w.title}`);
    if (!spec.silent) this.announce(w, `Started ${ref.W(w.id)}: ${w.title}`, 'started');
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
    this.announce(w, `Stopped ${ref.W(id)}: ${reason}`, 'stopped');
    this.changed(id);
    // A queued worker has no run to end; workers waiting --after it must hear now that it won't be done.
    if (!a) setImmediate(() => this.schedule());
  }

  /** End the current run and resume it at once with a message (the watchdog's nudge, or the router redirecting it). */
  restartRun(id: number, note: string, sender = 'watchdog'): boolean {
    const a = this.active.get(id);
    if (!a || !a.runId) return false;
    this.app.store.addInbox(id, sender, note);
    this.app.store.addLog(id, a.runId, 'inbox', `(${sender}, now) ${note}`);
    emit('worker_log', this.app.store.tailLogs(id, 1)[0]);
    a.ending = 'restart';
    a.restartBy = sender;
    a.kill();
    return true;
  }

  async archive(id: number): Promise<void> {
    const w = this.app.store.workerById(id);
    if (!w) return;
    if (this.active.has(id) || ['queued', 'running'].includes(w.status)) this.stop(id, 'archived');
    // On Windows a process that still has files open makes the delete fail halfway (EBUSY).
    for (let i = 0; i < 50 && this.active.has(id); i++) await new Promise((r) => setTimeout(r, 200));
    if (this.active.has(id)) throw new Error(`${ref.W(id)} is still stopping; archive it again in a moment`);
    await removeWorkspace(w);
    this.app.store.unsubscribeAll(id);
    this.app.store.updateWorker(id, { archived: 1 });
    this.changed(id);
  }

  /** Archive finished workers last touched more than `days` ago; returns their ids. */
  async cleanup(days: number, dryRun = false): Promise<number[]> {
    const before = Date.now() - days * 86_400_000;
    const old = this.app.store
      .all<WorkerRow>("SELECT * FROM workers WHERE archived = 0 AND status IN ('done', 'failed', 'stopped') AND updated_at < ? ORDER BY id", before)
      .filter((w) => !this.active.has(w.id));
    if (!dryRun) for (const w of old) await this.archive(w.id);
    return old.map((w) => w.id);
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

  /** Why a queued worker isn't running yet: its dependency, all slots busy, or too little memory. */
  queueReason(w: WorkerRow): { reason: 'after' | 'slot' | 'memory'; detail: string } | null {
    if (w.status !== 'queued') return null;
    const dep = w.after_worker ? this.app.store.workerById(w.after_worker) : null;
    if (dep && (dep.status !== 'done' || this.syncing.has(dep.id))) return { reason: 'after', detail: `waits for ${ref.W(dep.id)} (${dep.status})` };
    const max = this.app.config.workers.maxConcurrent;
    if (this.active.size >= max) return { reason: 'slot', detail: `${this.active.size}/${max} slots busy` };
    const free = Math.round(os.freemem() / 1048576);
    const need = this.app.config.workers.minFreeMemoryMB;
    if (this.active.size > 0 && free < need) return { reason: 'memory', detail: `${free} MB free, needs ${need} MB (workers.minFreeMemoryMB)` };
    return null;
  }

  private needsRun(w: WorkerRow): boolean {
    if (w.archived || this.active.has(w.id)) return false;
    if (w.after_worker && w.status === 'queued') {
      const dep = this.app.store.workerById(w.after_worker);
      if (dep && ['failed', 'stopped'].includes(dep.status)) {
        // What it waited for will never be done: say so instead of waiting forever.
        const msg = `${ref.W(dep.id)} ended ${dep.status}, and this task was to start after it`;
        this.app.store.updateWorker(w.id, { status: 'failed', error: msg });
        this.app.store.addLog(w.id, null, 'error', msg);
        this.report(w.id, 'failed', '', null, null, msg);
        this.changed(w.id);
        return false;
      }
      if (dep && (dep.status !== 'done' || this.syncing.has(dep.id))) return false;
    }
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
      // Each agent takes a few hundred MB: on a busy machine the rest wait (one always runs).
      if (this.active.size > 0 && this.lowMemory()) {
        this.memoryTimer ??= setTimeout(() => ((this.memoryTimer = null), this.schedule()), 30_000);
        break;
      }
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
        // dispatch --after in the same repo: build on that worker's branch, so its work is there.
        const dep = w.after_worker && !w.base ? store.workerById(w.after_worker) : null;
        if (dep?.branch && dep.repo === w.repo) {
          store.updateWorker(id, { base: dep.branch });
          w = store.workerById(id)!;
        }
        store.updateWorker(id, { status: 'running' });
        this.changed(id);
        ws = await prepareWorkspace(w, repo, { ownGitDir: !!adapter.needsOwnGitDir?.(config.workers.autonomy) });
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
          // Workers see the superagent skill too; this keeps them from acting as the router.
          env: { SUPERAGENT_WORKER: ref.W(id) },
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
      // The mail this run was started for counts as delivered (to a failed start). Otherwise it would
      // stay "undelivered" and schedule() would start the worker again at once, in a tight loop.
      const undelivered = store.undelivered(id);
      if (undelivered.length) {
        store.run('UPDATE inbox SET run_id = -1 WHERE worker_id = ? AND run_id IS NULL', id);
        store.addLog(id, entry.runId || null, 'system', `${undelivered.length} message${undelivered.length === 1 ? '' : 's'} not delivered because the worker could not start`);
      }
      store.updateWorker(id, { status: 'failed', error: msg, pid: null });
      store.addLog(id, entry.runId || null, 'error', msg);
      this.report(id, 'failed', '', null, null, msg);
      this.changed(id);
    } finally {
      this.active.delete(id);
      // Never re-enter startRun from inside its own unwinding.
      setImmediate(() => this.schedule());
    }
  }

  private onEvent(id: number, runId: number, ev: AgentEvent): void {
    const { store } = this.app;
    if (ev.kind === 'session') {
      if (store.workerById(id)?.agent_session !== ev.id) store.updateWorker(id, { agent_session: ev.id });
      return;
    }
    if (ev.kind === 'final') return;
    if (ev.kind !== 'ping') emit('worker_log', store.addLog(id, runId, ev.kind, ev.text.slice(0, 20_000)));
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
    // Whatever the run committed in its own clone belongs in the repo, however the run ended.
    const sync = syncBranch(w, this.app.findRepo(w.repo ?? undefined))
      .catch((e) => log(`worker ${ref.W(id)}: branch sync failed:`, (e as Error).message))
      .finally(() => {
        this.syncing.delete(id);
        this.schedule(); // workers dispatched --after this one can start now
      });
    this.syncing.set(id, sync);
    if (entry.ending === 'stopped' || entry.ending === 'shutdown') {
      store.updateRun(runId, { status: entry.ending, ended_at: ended, exit_code: res.code });
      return;
    }
    if (entry.ending === 'restart') {
      store.updateRun(runId, { status: 'restarted', ended_at: ended, exit_code: res.code });
      store.updateWorker(id, { status: 'queued', pid: null });
      store.addLog(id, runId, 'system', `Run restarted by ${entry.restartBy === 'watchdog' || !entry.restartBy ? 'the watchdog' : `the ${entry.restartBy}`}`);
      this.changed(id);
      return;
    }

    // A resumed session that no longer exists: start over with the original task.
    if (!fresh && res.error && SESSION_GONE.test(res.error)) {
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
      status = report.status === 'needs_input' ? 'waiting' : report.status === 'no_change' ? 'done' : report.status;
      summary = report.summary || snippet(res.finalText, 600);
      // Keep the question on the worker itself so `workers`, `logs` and the router can show it.
      if (report.question) summary = `${summary}\n\n**Question:** ${report.question}`;
    } else if (res.error) {
      status = 'failed';
      error = res.error;
      summary = '';
    } else {
      status = 'done';
      summary = snippet(res.finalText, 600) || 'Finished without a report.';
    }
    const repoSlug = this.app.findRepo(w.repo ?? undefined)?.slug?.toLowerCase();
    // A report that says "no PR" means it; a PR link elsewhere in the text only counts for this repo.
    const found = report ? report.pr_url : findPrUrl(res.finalText);
    const pr = found && (!repoSlug || found.toLowerCase().includes(`github.com/${repoSlug}/pull/`)) ? found : null;
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
    if (report?.question) emit('worker_log', store.addLog(id, runId, 'inbox', `Question for you: ${report.question}`));
    this.report(id, report?.status ?? (error ? 'failed' : 'done'), summary, pr, report?.question ?? null, error, report?.verified ?? null);
    const line =
      status === 'waiting' ? `${ref.W(id)} needs your input: ${w.title}` : `${status === 'done' ? 'Finished' : 'Failed'} ${ref.W(id)}: ${w.title}`;
    // A silent task is only news when it changed something.
    if (!w.silent || (status === 'done' && report?.status !== 'no_change')) this.announce(w, line, status);
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

  private report(id: number, status: string, summary: string, pr: string | null, question: string | null, error: string | null, verified: string | null = null): void {
    const w = this.app.store.workerById(id);
    this.app.ingest.ingest({
      source: 'worker',
      kind: 'report',
      text: summary || error || '(no summary)',
      meta: { worker: id, status, pr_url: pr, question, error, verified },
      // Acting ahead (Section 3.4): a silent task is only news if it worked. Its other results are kept
      // on the worker and in the activity log, but no router is asked to announce them.
      // (no_change, nothing needed doing, is dropped the same way.)
      policy: w?.silent && status !== 'done' ? { dropReason: `silent task ended ${status}` } : undefined,
    });
  }

  /** After a crash or reboot: runs that were in flight resume from their saved agent session. */
  async recover(): Promise<void> {
    const { store } = this.app;
    const interrupted = store.all<{ worker_id: number; started_at: number }>("SELECT worker_id, started_at FROM worker_runs WHERE status = 'running'");
    store.run("UPDATE worker_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'", Date.now());
    for (const w of store.workersWithStatus('running')) {
      // Still alive from before the crash: it can't be re-attached, and two runs must never share a
      // workspace. Only end it if that pid really is this run (a recycled pid started at another time),
      // and wait until it is gone.
      const runStart = interrupted.find((r) => r.worker_id === w.id)?.started_at;
      if (w.pid && runStart && isAlive(w.pid)) {
        const started = await processStartTime(w.pid);
        if (started !== null && Math.abs(started - runStart) < 30_000) {
          killTree(w.pid);
          for (let i = 0; i < 50 && isAlive(w.pid); i++) await new Promise((r) => setTimeout(r, 200));
        }
      }
      store.addInbox(
        w.id,
        'system',
        'SuperAgent restarted while you were working. Check the current state of your workspace (git status, files) and continue the task.',
      );
      store.updateWorker(w.id, { status: 'queued', pid: null });
      store.addLog(w.id, null, 'system', 'SuperAgent restarted during this run; resuming it (the step in progress is redone)');
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
