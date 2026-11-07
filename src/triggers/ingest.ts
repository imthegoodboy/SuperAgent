import type { App } from '../daemon/app.js';
import type { SourceMode } from '../core/config.js';
import type { TriggerRow } from '../core/store.js';
import { clip, emit, ref } from '../core/util.js';
import { decide } from './policy.js';

export interface IncomingEvent {
  externalId?: string;
  source: 'local' | 'github' | 'telegram' | 'worker' | 'watchdog';
  kind: string;
  threadKey?: string;
  threadTitle?: string;
  threadUrl?: string;
  subscribable?: boolean;
  author?: string | null;
  text: string;
  url?: string | null;
  meta?: Record<string, unknown>;
  createdAt?: number;
  policy?: {
    mode?: SourceMode;
    allowUsers?: string[];
    mentioned?: boolean;
    isBot?: boolean;
    ci?: 'failures' | 'all' | 'off';
    ciConclusion?: string | null;
    informational?: boolean;
    dropReason?: string;
    reviewBot?: boolean;
  };
}

/** How a trigger reads inside a worker's inbox. */
export function renderForWorker(t: TriggerRow, threadTitle?: string | null): string {
  const where = [t.source, t.kind.replace(/_/g, ' '), t.author ? `by @${t.author}` : '', threadTitle ? `on ${threadTitle}` : '']
    .filter(Boolean)
    .join(' ');
  return `[${ref.T(t.id)} · ${where}]${t.url ? ` ${t.url}` : ''}\n${clip(t.text, 4000)}`;
}

export class Ingest {
  constructor(private app: App) {}

  ingest(ev: IncomingEvent): TriggerRow | null {
    const { store } = this.app;
    const thread = ev.threadKey
      ? store.upsertThread({
          key: ev.threadKey,
          source: ev.source,
          title: ev.threadTitle,
          url: ev.threadUrl,
          subscribable: !!ev.subscribable,
        })
      : null;
    const subscribers = thread?.subscribable ? store.subscribers(thread.id).filter((w) => !w.archived) : [];
    const p = ev.policy ?? {};
    const { decision, reason } = decide(
      {
        source: ev.source,
        kind: ev.kind,
        text: ev.text,
        author: ev.author,
        isBot: p.isBot,
        mentioned: p.mentioned,
        mode: p.mode,
        allowUsers: p.allowUsers,
        ci: p.ci,
        ciConclusion: p.ciConclusion,
        informational: p.informational,
        dropReason: p.dropReason,
        reviewBot: p.reviewBot,
      },
      subscribers.length,
    );

    const status =
      decision === 'dropped' ? 'dropped' : decision === 'pass_through' ? 'delivered' : decision === 'fyi' ? 'handled' : 'pending';
    const routedTo =
      decision === 'pass_through' ? subscribers.map((w) => ref.W(w.id)).join(',') : status === 'pending' ? 'router' : null;

    const row = store.insertTrigger({
      external_id: ev.externalId ?? null,
      source: ev.source,
      kind: ev.kind,
      thread_id: thread?.id ?? null,
      author: ev.author ?? null,
      text: ev.text,
      url: ev.url ?? null,
      meta: ev.meta,
      created_at: ev.createdAt,
      decision,
      reason,
      routed_to: routedTo,
      status,
    });
    if (!row) return null;
    emit('trigger', row);

    if (decision === 'pass_through') {
      for (const w of subscribers) {
        store.addInbox(w.id, 'thread', renderForWorker(row, thread?.title), row.id);
        this.app.workers.wake(w.id);
      }
    } else if (ev.policy?.informational && thread) {
      // Issue closed / PR merged: the task is over, release its workers.
      for (const w of store.subscribers(thread.id)) {
        store.unsubscribe(w.id, thread.id);
        if (w.status === 'waiting') store.updateWorker(w.id, { status: 'done' });
        emit('worker', store.workerById(w.id));
      }
    }
    if (status === 'pending') this.app.router.kick();
    return row;
  }
}
