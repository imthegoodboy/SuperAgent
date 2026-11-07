import type { App } from '../daemon/app.js';
import { emit, log, ref } from '../core/util.js';
import { runOk } from '../agents/process.js';

export const GITHUB_SIGNATURE = '\n\n<!-- superagent -->';

/** Delivers router replies to the channel a thread lives in. */
export class Outbound {
  constructor(private app: App) {}

  /** Never throws for delivery problems: the result says whether it was sent. */
  async send(threadId: number, text: string): Promise<{ ok: boolean; error?: string }> {
    const { store } = this.app;
    const th = store.threadById(threadId);
    if (!th) throw new Error(`unknown thread ${ref.TH(threadId)}`);
    const outId = store.addOutbox(threadId, text);
    try {
      if (th.source === 'local') {
        emit('message', store.addMessage(threadId, 'agent', text));
      } else if (th.source === 'github') {
        const m = th.key.match(/^github:([\w.-]+\/[\w.-]+)#(\d+)$/);
        if (!m) throw new Error(`cannot comment on ${th.key}`);
        await runOk('gh', ['api', '--method', 'POST', `repos/${m[1]}/issues/${m[2]}/comments`, '--input', '-'], {
          stdin: JSON.stringify({ body: text + GITHUB_SIGNATURE }),
          timeoutMs: 60_000,
        });
      } else if (th.source === 'telegram') {
        await this.app.telegram.send(th.key, text);
      } else {
        throw new Error(`cannot reply to a ${th.source} thread`);
      }
      store.updateOutbox(outId, 'sent');
      emit('outbox', { thread_id: threadId });
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      store.updateOutbox(outId, 'failed', msg);
      log(`reply to ${ref.TH(threadId)} failed:`, msg);
      // Never lose a reply: surface it in the local chat.
      const local = store.localThread().id;
      if (threadId !== local) {
        emit('message', store.addMessage(local, 'system', `Could not post to ${th.title ?? th.key}: ${msg}\n\nMessage was:\n${text}`, { event: 'delivery_failed' }));
      }
      emit('outbox', { thread_id: threadId });
      return { ok: false, error: msg };
    }
  }
}
