import type { App } from '../daemon/app.js';
import { emit, log, sleep } from '../core/util.js';
import { mentions } from '../triggers/policy.js';

/** Optional IM channel. Uses a bot token the user creates with @BotFather; long-polls getUpdates. */
/**
 * Who sent a Telegram message, and whether they are on the allowlist. Only the username or the numeric
 * id identify someone: a display name can be set to anything, an allowed username included, so it is
 * shown but never trusted.
 */
export function telegramSender(from: any, allowUsers: string[]): { author: string; username: string | null; allowed: boolean } {
  const username = from?.username ? String(from.username) : null;
  const userId = from?.id !== undefined && from?.id !== null ? String(from.id) : null;
  const author = username ?? `${from?.first_name ?? 'unknown'} (id ${userId ?? '?'})`;
  const allow = allowUsers.map((u) => u.replace(/^@/, '').toLowerCase());
  const allowed = (!!username && allow.includes(username.toLowerCase())) || (!!userId && allow.includes(userId));
  return { author, username, allowed };
}

export class TelegramSource {
  private abort: AbortController | null = null;
  private offset = 0;
  bot: { id: number; username: string } | null = null;
  lastError: string | null = null;

  constructor(private app: App) {}

  private get token(): string {
    return this.app.config.telegram.botToken.trim();
  }

  status() {
    return { enabled: this.app.config.telegram.enabled && !!this.token, bot: this.bot?.username ?? null, lastError: this.lastError };
  }

  start(): void {
    this.stop();
    if (!this.app.config.telegram.enabled || !this.token) return;
    const ctrl = new AbortController();
    this.abort = ctrl;
    void this.loop(ctrl.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  reload(): void {
    this.start();
  }

  private async api(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(json.description ?? `Telegram ${method} failed (${res.status})`);
    return json.result;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (!this.bot) {
          const me = await this.api('getMe', {}, signal);
          this.bot = { id: me.id, username: me.username };
          this.lastError = null;
          emit('telegram', this.status());
        }
        const updates: any[] = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, signal);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message?.text) this.handle(u.message);
        }
      } catch (e) {
        if (signal.aborted) return;
        this.lastError = (e as Error).message;
        log('telegram:', this.lastError);
        emit('telegram', this.status());
        await sleep(10_000);
      }
    }
  }

  private handle(msg: any): void {
    const cfg = this.app.config.telegram;
    const chatId = String(msg.chat.id);
    const isPrivate = msg.chat.type === 'private';
    const { author, username, allowed: userAllowed } = telegramSender(msg.from, cfg.allowUsers);
    const allow = cfg.allowUsers;
    const chat = cfg.chats.find((c) => c.id === chatId);
    let mode = chat?.mode;
    let dropReason: string | undefined;
    if (msg.from?.is_bot) dropReason = 'bot account';
    else if (allow.length && !userAllowed) dropReason = `${username ? '@' + username : author} is not on the allowlist`;
    if (!mode) {
      if (isPrivate && userAllowed) mode = 'all';
      else dropReason ??= `unknown chat ${chatId} (${msg.chat.title ?? '@' + author}); add it with \`superagent config set telegram.chats '[{"id":"${chatId}","mode":"mentions"}]'\` (keep any chats already listed)`;
    }
    const mentioned =
      isPrivate ||
      msg.reply_to_message?.from?.id === this.bot?.id ||
      mentions(msg.text, [this.bot ? `@${this.bot.username}` : '', this.app.config.mention]);
    const topic = msg.is_topic_message ? `:${msg.message_thread_id}` : '';
    this.app.ingest.ingest({
      externalId: `tg:${chatId}:${msg.message_id}`,
      source: 'telegram',
      kind: 'message',
      threadKey: `telegram:${chatId}${topic}`,
      threadTitle: msg.chat.title ?? `@${author}`,
      subscribable: false,
      author,
      text: msg.text,
      createdAt: msg.date * 1000,
      meta: { chatId, messageId: msg.message_id },
      // The allowlist was applied above, by username or id; the policy must not compare display names.
      policy: { mode, allowUsers: [], mentioned, dropReason },
    });
  }

  async send(threadKey: string, text: string): Promise<void> {
    const m = threadKey.match(/^telegram:(-?\d+)(?::(\d+))?$/);
    if (!m) throw new Error(`bad telegram thread ${threadKey}`);
    if (!this.token) throw new Error('Telegram is not configured');
    await this.api('sendMessage', {
      chat_id: m[1],
      text: text.slice(0, 4000),
      ...(m[2] ? { message_thread_id: Number(m[2]) } : {}),
    });
  }
}
