import type { App } from '../daemon/app.js';
import type { ThreadRow, TriggerRow, WorkerRow } from '../core/store.js';
import { ago, duration, oneLine, parseRef, ref, snippet, tryJson } from '../core/util.js';
import { ADAPTERS } from '../agents/adapters.js';

/* Inline & Spill (Section 3.3): inline what the model will likely need (IDs, snippets, neighbours),
   spill the rest behind IDs it can recall. Every recalled object inlines next-hop IDs (Chain of Recall). */

const INLINE_EXPLICIT = 700;
const INLINE_CANDIDATE = 300;

function hhmm(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 5);
}

function agentLabel(id: string): string {
  return ADAPTERS[id]?.label ?? id;
}

export function threadLabel(th: ThreadRow | undefined | null): string {
  if (!th) return '';
  if (th.source === 'local') return `${ref.TH(th.id)} (local chat)`;
  return `${ref.TH(th.id)} ${th.source}${th.title ? ` "${snippet(th.title, 80)}"` : ''}`;
}

function workerBrief(app: App, w: WorkerRow): string {
  const running = w.status === 'running' ? ` ${duration(Date.now() - w.last_activity_at)} since last output` : '';
  return `${ref.W(w.id)} ${w.agent} ${w.status}${running} "${snippet(w.title, 70)}"${w.repo ? ` repo ${w.repo}` : ''}`;
}

function threadSummary(app: App, th: ThreadRow): string {
  const n = app.store.threadEventCount(th.id);
  const subs = app.store.subscribers(th.id).filter((w) => !w.archived);
  const parts = [`${n} event${n === 1 ? '' : 's'}`];
  if (subs.length) parts.push(`workers: ${subs.map((w) => `${ref.W(w.id)} ${w.status}`).join(', ')}`);
  return parts.join('; ');
}

export function renderTrigger(app: App, t: TriggerRow): string {
  const th = t.thread_id ? app.store.threadById(t.thread_id) : null;
  const meta = tryJson<Record<string, any>>(t.meta ?? '') ?? {};
  if (t.source === 'worker') {
    const w = app.store.workerById(Number(meta.worker));
    const replyTh = w?.reply_thread_id ? app.store.threadById(w.reply_thread_id) : null;
    const head = `${ref.T(t.id)} REPORT · ${ref.W(w?.id)} (${agentLabel(w?.agent ?? '')}) "${snippet(w?.title, 70)}" · status=${meta.status ?? '?'}${
      w?.silent ? ' · SILENT task' : ''
    } · reply thread ${ref.TH(replyTh?.id ?? app.store.localThread().id)}`;
    const extra = [meta.pr_url ? `PR: ${meta.pr_url}` : '', meta.question ? `question: ${snippet(meta.question, 400)}` : '', meta.error ? `error: ${snippet(meta.error, 300)}` : '']
      .filter(Boolean)
      .join(' · ');
    return `${head}\n  "${snippet(t.text, INLINE_EXPLICIT, `recall ${ref.W(w?.id)}`)}"${extra ? `\n  ${extra}` : ''}`;
  }

  const label = t.decision === 'candidate' ? 'CANDIDATE' : 'EXPLICIT';
  const who = t.source === 'local' ? 'you' : t.author ? `@${t.author}` : '';
  const head = [
    `${ref.T(t.id)} ${label}`,
    `${t.source} ${t.kind.replace(/_/g, ' ')}${who ? ` by ${who}` : ''}`,
    th ? `${threadLabel(th)}${th.source !== 'local' ? ` (${threadSummary(app, th)})` : ''}` : '',
    hhmm(t.created_at),
    t.url ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  const max = label === 'CANDIDATE' ? INLINE_CANDIDATE : INLINE_EXPLICIT;
  let out = `${head}\n  "${snippet(t.text, max, `recall ${ref.T(t.id)}`)}"`;
  // Locality: inline the event just before this one in the same (non-local) thread.
  if (th && th.source !== 'local') {
    const prev = app.store.get<TriggerRow>('SELECT * FROM triggers WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT 1', th.id, t.id);
    if (prev) out += `\n  ↳ previous in thread: ${ref.T(prev.id)} ${prev.author ? `@${prev.author}` : prev.source}: "${snippet(prev.text, 140)}"`;
  }
  return out;
}

export function renderContext(app: App): string {
  const cfg = app.config;
  const lines: string[] = ['[CONTEXT]', `Local chat with the user: ${ref.TH(app.store.localThread().id)}`];
  lines.push('Repositories:');
  if (!cfg.repos.length) lines.push('- (none configured; tasks run in a scratch folder. The user can add repos in Settings.)');
  for (const r of cfg.repos) {
    lines.push(
      `- ${r.name}${r.slug ? ` — GitHub ${r.slug}` : ' — local only'}${r.path ? ` · ${r.path}` : ''}${
        r.slug ? ` · GitHub events: ${r.mode}` : ''
      }${r.agent ? ` · preferred agent ${r.agent}` : ''}`,
    );
  }
  const avail = app.availableAgents();
  const unavailable = app.agents.filter((a) => a.id !== 'mock' && !avail.includes(a.id as never)).map((a) => `${a.id} (${a.error ?? 'disabled'})`);
  lines.push(
    `Worker agents available: ${avail.map((a) => (a === cfg.workers.defaultAgent ? `${a} (default)` : a)).join(', ') || 'none'}${
      unavailable.length ? `. Unavailable: ${unavailable.join(', ')}` : ''
    }`,
  );
  lines.push(`Draft PRs by workers: ${cfg.workers.allowDraftPRs ? 'allowed' : 'not allowed (workers only commit locally)'}`);
  if (cfg.policies.trim()) lines.push('Policies from the user (apply them to CANDIDATE events):', cfg.policies.trim());
  const mem = app.store.memory(30);
  if (mem.length) lines.push('Long-term memory:', ...mem.reverse().map((m) => `- ${m.text}`));
  return lines.join('\n');
}

export function renderPrimer(app: App): string {
  const lines: string[] = ['[RECENT HISTORY] (your session was (re)started; this is what happened before)'];
  const msgs = app.store.messages(app.store.localThread().id, 12).filter((m) => m.role !== 'system');
  if (msgs.length) {
    lines.push('Recent local chat:');
    for (const m of msgs) lines.push(`  ${m.role === 'user' ? 'user' : 'you'}: ${snippet(m.text, 200)}`);
  }
  const workers = app.store.listWorkers('current', 12);
  if (workers.length) {
    lines.push('Recent workers:');
    for (const w of workers) lines.push(`- ${workerBrief(app, w)}${w.pr_url ? ` · PR ${w.pr_url}` : ''}${w.summary ? ` · ${snippet(w.summary, 160)}` : ''}`);
  }
  const threads = app.store.recentThreads(8).filter((t) => t.source !== 'local');
  if (threads.length) lines.push('Recent threads:', ...threads.map((t) => `- ${threadLabel(t)} (${threadSummary(app, t)})`));
  return lines.length > 1 ? lines.join('\n') : '';
}

export function renderTurn(app: App, batch: TriggerRow[], fyi: TriggerRow[], notes: string[]): string {
  const lines: string[] = [`=== ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ===`];
  if (notes.length) lines.push('[SYSTEM NOTES]', ...notes.map((n) => `- ${n}`));
  lines.push(`[NEW EVENTS] (${batch.length})`);
  for (const t of batch) lines.push(renderTrigger(app, t));
  if (fyi.length) {
    lines.push('[FYI: already handled in code, no action needed unless relevant]');
    for (const t of fyi) {
      const th = t.thread_id ? app.store.threadById(t.thread_id) : null;
      const dest = t.decision === 'pass_through' ? `→ passed to ${t.routed_to}` : `(${t.reason})`;
      lines.push(`- ${ref.T(t.id)} ${dest} · ${t.source} ${t.kind}${t.author ? ` @${t.author}` : ''}${th ? ` on ${threadLabel(th)}` : ''}: "${snippet(t.text, 120)}"`);
    }
  }
  const active = app.store.workersWithStatus('queued', 'running', 'waiting').filter((w) => !w.archived);
  lines.push('[ACTIVE WORKERS]', ...(active.length ? active.map((w) => `- ${workerBrief(app, w)}`) : ['- none']));
  return lines.join('\n');
}

// ---------- Chain of Recall ----------

function recallTrigger(app: App, id: number): string {
  const t = app.store.triggerById(id);
  if (!t) return `${ref.T(id)}: not found`;
  const th = t.thread_id ? app.store.threadById(t.thread_id) : null;
  const lines = [
    `${ref.T(t.id)} · ${t.source} ${t.kind}${t.author ? ` by @${t.author}` : ''} · ${ago(t.created_at)} · decision ${t.decision}${t.routed_to ? ` → ${t.routed_to}` : ''}`,
  ];
  if (th) lines.push(`thread: ${threadLabel(th)}`);
  if (t.url) lines.push(`url: ${t.url}`);
  lines.push('text:', snippet(t.text, 1) === '' ? '(empty)' : t.text.length > 6000 ? t.text.slice(0, 6000) + `… [+${t.text.length - 6000} chars]` : t.text);
  const meta = tryJson<Record<string, any>>(t.meta ?? '');
  if (meta?.diff_hunk) lines.push('code context:', String(meta.diff_hunk).slice(-1500));
  if (th) {
    const prev = app.store.get<TriggerRow>('SELECT id FROM triggers WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT 1', th.id, t.id);
    const next = app.store.get<TriggerRow>('SELECT id FROM triggers WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT 1', th.id, t.id);
    const nav = [prev ? `previous ${ref.T(prev.id)}` : '', next ? `next ${ref.T(next.id)}` : ''].filter(Boolean).join(', ');
    if (nav) lines.push(`neighbours: ${nav}`);
  }
  return lines.join('\n');
}

function recallThread(app: App, id: number): string {
  const th = app.store.threadById(id);
  if (!th) return `${ref.TH(id)}: not found`;
  const lines = [`${threadLabel(th)} · key ${th.key}${th.url ? ` · ${th.url}` : ''} · updated ${ago(th.updated_at)}`];
  if (th.source === 'local') {
    const msgs = app.store.messages(th.id, 20);
    lines.push(`last ${msgs.length} messages:`);
    for (const m of msgs) lines.push(`  [${m.role}] ${snippet(m.text, 240)}`);
  } else {
    const total = app.store.threadEventCount(th.id);
    const events = app.store.triggersInThread(th.id, 15);
    if (total > events.length) lines.push(`(${total - events.length} earlier events not shown; oldest shown is ${ref.T(events[0]?.id)})`);
    for (const t of events) lines.push(`  ${ref.T(t.id)} ${t.kind}${t.author ? ` @${t.author}` : ''} [${t.decision}]: "${snippet(t.text, 160)}"`);
    const replies = app.store.outboxForThread(th.id, 3);
    if (replies.length) lines.push('your recent replies here:', ...replies.map((o) => `  "${snippet(o.text, 160)}" (${o.status})`));
  }
  const subs = app.store.subscribers(th.id);
  if (subs.length) lines.push('subscribed workers:', ...subs.map((w) => `  ${workerBrief(app, w)}`));
  const started = app.store.all<WorkerRow>('SELECT * FROM workers WHERE reply_thread_id = ? ORDER BY id DESC LIMIT 5', th.id);
  if (started.length) lines.push('workers that report to this thread:', ...started.map((w) => `  ${workerBrief(app, w)}`));
  return lines.join('\n');
}

function recallWorker(app: App, id: number): string {
  const w = app.store.workerById(id);
  if (!w) return `${ref.W(id)}: not found`;
  const lines = [
    `${ref.W(w.id)} "${w.title}" · ${agentLabel(w.agent)} · ${w.status} · runs ${w.run_count} · created ${ago(w.created_at)} by ${w.created_by}`,
  ];
  if (w.repo) lines.push(`repo ${w.repo}${w.branch ? ` · branch ${w.branch}` : ''}${w.cwd ? ` · ${w.cwd}` : ''}`);
  if (w.pr_url) lines.push(`PR: ${w.pr_url}`);
  if (w.reply_thread_id) lines.push(`reports to ${threadLabel(app.store.threadById(w.reply_thread_id))}`);
  const threads = app.store.threadsOf(w.id);
  if (threads.length) lines.push(`subscribed to: ${threads.map((t) => threadLabel(t)).join(', ')}`);
  if (w.origin_trigger_id) lines.push(`started from ${ref.T(w.origin_trigger_id)}`);
  lines.push('task:', w.task.length > 2500 ? w.task.slice(0, 2500) + `… [+${w.task.length - 2500} chars]` : w.task);
  if (w.summary) lines.push(`last report: ${w.summary}`);
  if (w.error) lines.push(`last error: ${snippet(w.error, 400)}`);
  const logs = app.store.tailLogs(w.id, 8);
  if (logs.length) lines.push('recent activity:', ...logs.map((l) => `  [${l.kind}] ${snippet(l.text, 160)}`));
  return lines.join('\n');
}

export function renderRecall(app: App, ids: string[]): string {
  const out: string[] = ['[RECALL RESULTS]'];
  for (const raw of ids.slice(0, 8)) {
    const r = parseRef(raw);
    if (!r) {
      out.push(`${raw}: unknown id format (use T#n, TH#n or W#n)`);
      continue;
    }
    out.push(r.kind === 'T' ? recallTrigger(app, r.id) : r.kind === 'TH' ? recallThread(app, r.id) : recallWorker(app, r.id), '');
  }
  return out.join('\n').trim();
}

export function workerLine(w: WorkerRow): string {
  return `${ref.W(w.id)} ${oneLine(w.title)}`;
}
