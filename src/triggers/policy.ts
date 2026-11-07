import type { SourceMode } from '../core/config.js';
import type { Decision } from '../core/store.js';

/** Marker appended to everything SuperAgent posts, so it never reacts to its own messages. */
export const SELF_MARKER = '<!-- superagent';

export interface PolicyInput {
  source: string;
  kind: string;
  text: string;
  author?: string | null;
  isBot?: boolean;
  /** The event explicitly addresses the agent (mention, DM, reply to the bot). */
  mentioned?: boolean;
  mode?: SourceMode;
  allowUsers?: string[];
  ci?: 'failures' | 'all' | 'off';
  ciConclusion?: string | null;
  /** Lifecycle events (issue closed, PR merged) are informational. */
  informational?: boolean;
  /** A reason computed by the source itself (e.g. unknown Telegram chat). */
  dropReason?: string;
  /** A code-review bot the user listed (github.reviewBots): its comments reach a worker that follows the PR. */
  reviewBot?: boolean;
}

/**
 * Fast path (Section 3.1 + 3.2 of the design): cheap, deterministic decisions made in code
 * before any model is involved.
 *   dropped      - noise; stored for the Activity view, never shown to a model
 *   pass_through - thread already has subscribed workers; goes straight to them
 *   explicit     - addressed to the agent; router must handle it
 *   candidate    - from a monitored source; router decides using the user's semantic policies
 *   fyi          - recorded and summarised to the router, no decision needed
 */
export function decide(ev: PolicyInput, subscriberCount: number): { decision: Decision; reason: string } {
  if (ev.source === 'local') return { decision: 'explicit', reason: 'local chat' };
  if (ev.source === 'worker') return ev.dropReason ? { decision: 'dropped', reason: ev.dropReason } : { decision: 'explicit', reason: 'worker report' };
  if (ev.source === 'watchdog') return { decision: 'explicit', reason: 'watchdog' };

  if (ev.dropReason) return { decision: 'dropped', reason: ev.dropReason };
  if (ev.text.includes(SELF_MARKER)) return { decision: 'dropped', reason: 'posted by SuperAgent' };
  if (ev.mode === 'off') return { decision: 'dropped', reason: 'source is turned off' };
  // A worker waiting for an AI review of its own PR must get it, although bots never trigger work.
  if (ev.reviewBot && subscriberCount > 0) return { decision: 'pass_through', reason: 'review bot on a followed thread' };
  if (ev.isBot && ev.kind !== 'ci') return { decision: 'dropped', reason: 'bot account' };

  const allow = (ev.allowUsers ?? []).map((u) => u.toLowerCase());
  if (allow.length && ev.kind !== 'ci' && !allow.includes((ev.author ?? '').toLowerCase())) {
    return { decision: 'dropped', reason: `@${ev.author ?? 'unknown'} is not on the allowlist` };
  }

  if (ev.kind === 'ci') {
    if (ev.ci === 'off') return { decision: 'dropped', reason: 'CI events are turned off' };
    const failed = ev.ciConclusion && !['success', 'skipped', 'neutral'].includes(ev.ciConclusion);
    if (!failed && ev.ci !== 'all') return { decision: 'dropped', reason: `CI ${ev.ciConclusion ?? 'finished'}` };
  }

  if (ev.informational) return { decision: 'fyi', reason: 'lifecycle event' };
  if (subscriberCount > 0) return { decision: 'pass_through', reason: 'thread has subscribed workers' };
  if (ev.mentioned) return { decision: 'explicit', reason: 'mentions the agent' };
  if (ev.mode === 'all') return { decision: 'candidate', reason: 'monitored source' };
  return { decision: 'dropped', reason: 'no mention' };
}

export function mentions(text: string, keywords: string[]): boolean {
  const t = text.toLowerCase();
  return keywords.filter(Boolean).some((k) => t.includes(k.toLowerCase()));
}
