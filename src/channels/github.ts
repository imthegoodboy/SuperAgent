import type { App } from '../daemon/app.js';
import type { RepoConfig } from '../core/config.js';
import type { WorkerRow } from '../core/store.js';
import { emit, log, tryJson } from '../core/util.js';
import { run } from '../agents/process.js';
import { mentions } from '../triggers/policy.js';

const OVERLAP_MS = 2 * 60_000;

function isBot(user: any): boolean {
  return user?.type === 'Bot' || /\[bot\]$/.test(user?.login ?? '');
}

/** Every page of a list endpoint (after a weekend asleep, or in a busy repo, page 1 is not enough). */
async function ghPages(pathAndQuery: string): Promise<any[]> {
  // Every page in one JSON array; keep all of it (the default 256 KB tail would cut it).
  const r = await run('gh', ['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', pathAndQuery], {
    timeoutMs: 3 * 60_000,
    keepBytes: 64 * 1024 * 1024,
  });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300) || `gh api ${pathAndQuery} failed`);
  const pages = tryJson<any[]>(r.stdout);
  if (!Array.isArray(pages)) throw new Error(`gh api ${pathAndQuery}: unexpected output`);
  return pages;
}

async function ghList(pathAndQuery: string): Promise<any[]> {
  return (await ghPages(pathAndQuery)).flat();
}

/** Review bots whose comments reach the worker that follows the PR (other bots are noise). */
export function isReviewBot(login: string | null | undefined, allowed: string[]): boolean {
  const name = String(login ?? '').toLowerCase().replace(/\[bot\]$/, '');
  return !!name && allowed.map((b) => b.toLowerCase().replace(/\[bot\]$/, '')).includes(name);
}

/**
 * Polls GitHub through the user's own `gh` login (no webhooks, no server, no extra auth).
 * Emits triggers for new issues/PRs, comments, review comments, reviews on followed PRs,
 * finished CI runs, and closed/merged threads.
 */
export class GitHubSource {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  /** Bumped by stop(): a poll that was in flight must not schedule another loop when it ends. */
  private generation = 0;
  login: string | null = null;
  lastError: string | null = null;
  lastPollAt: number | null = null;

  constructor(private app: App) {}

  start(): void {
    this.stop();
    const gen = this.generation;
    void this.detectLogin();
    const tick = async () => {
      if (gen !== this.generation) return;
      await this.pollAll();
      if (gen !== this.generation) return; // reloaded meanwhile: the new loop takes over
      this.timer = setTimeout(tick, this.app.config.github.pollSeconds * 1000);
    };
    this.timer = setTimeout(tick, 3000);
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reload(): void {
    this.start();
  }

  status() {
    const repos = this.app.config.repos.filter((r) => r.slug);
    return { enabled: this.app.config.github.enabled, login: this.login, repos: repos.length, lastPollAt: this.lastPollAt, lastError: this.lastError };
  }

  private async detectLogin(): Promise<void> {
    const r = await run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 20_000 });
    this.login = r.code === 0 ? r.stdout.trim() || null : null;
  }

  async pollAll(): Promise<void> {
    if (this.polling || !this.app.config.github.enabled) return;
    this.polling = true;
    try {
      const repos = this.app.config.repos.filter((r) => r.slug && r.mode !== 'off');
      let error: string | null = null;
      for (const repo of repos) {
        try {
          await this.pollRepo(repo);
        } catch (e) {
          error = `${repo.slug}: ${(e as Error).message}`;
          log('github poll failed', error);
        }
      }
      this.lastError = error;
      this.lastPollAt = Date.now();
      emit('github', this.status());
    } finally {
      this.polling = false;
    }
  }

  private async pollRepo(repo: RepoConfig): Promise<void> {
    const slug = repo.slug!;
    const key = `github.since.${slug}`;
    const pollStart = Date.now();
    const sinceStr = this.app.store.getKv(key);
    if (!sinceStr) {
      // First poll of a repo: start from now, never replay old history.
      this.app.store.setKv(key, new Date(pollStart - OVERLAP_MS).toISOString());
      return;
    }
    const since = Date.parse(sinceStr);
    const q = `since=${encodeURIComponent(sinceStr)}`;
    const base = {
      mode: repo.mode,
      allowUsers: repo.allowUsers,
      ci: repo.ci,
    };
    const kw = [this.app.config.mention, '@superagent'];
    const reviewBot = (user: any) => isBot(user) && isReviewBot(user?.login, this.app.config.github.reviewBots);
    // Some requests may fail; what did arrive is still handled (it is deduplicated), but the cursor
    // only moves once everything since it was read.
    const failures: string[] = [];

    const issues: any[] = await ghList(`repos/${slug}/issues?state=all&sort=updated&direction=asc&per_page=100&${q}`);
    for (const it of issues) {
      const isPr = !!it.pull_request;
      const threadKey = `github:${slug}#${it.number}`;
      const threadTitle = `${isPr ? 'PR' : 'Issue'} #${it.number}: ${it.title}`;
      if (Date.parse(it.created_at) >= since) {
        this.app.ingest.ingest({
          externalId: `gh:issue:${it.id}`,
          source: 'github',
          kind: isPr ? 'pr_opened' : 'issue_opened',
          threadKey,
          threadTitle,
          threadUrl: it.html_url,
          subscribable: true,
          author: it.user?.login,
          text: `${it.title}\n\n${it.body ?? ''}`.trim(),
          url: it.html_url,
          createdAt: Date.parse(it.created_at),
          meta: { number: it.number, isPr },
          policy: { ...base, isBot: isBot(it.user), mentioned: mentions(`${it.title}\n${it.body ?? ''}`, kw) },
        });
      }
      if (it.state === 'closed' && it.closed_at && Date.parse(it.closed_at) >= since) {
        const merged = !!it.pull_request?.merged_at;
        this.app.ingest.ingest({
          externalId: `gh:closed:${it.id}:${it.closed_at}`,
          source: 'github',
          kind: merged ? 'pr_merged' : 'closed',
          threadKey,
          threadTitle,
          threadUrl: it.html_url,
          subscribable: true,
          author: it.closed_by?.login ?? null,
          text: `${merged ? 'Merged' : 'Closed'}: ${it.title}`,
          url: it.html_url,
          createdAt: Date.parse(it.closed_at),
          policy: { ...base, allowUsers: [], informational: true },
        });
      }
    }

    const comments: any[] = await ghList(`repos/${slug}/issues/comments?sort=updated&direction=asc&per_page=100&${q}`);
    for (const c of comments) {
      if (Date.parse(c.created_at) < since) continue;
      const number = Number(String(c.issue_url).split('/').pop());
      this.app.ingest.ingest({
        externalId: `gh:comment:${c.id}`,
        source: 'github',
        kind: 'comment',
        threadKey: `github:${slug}#${number}`,
        threadUrl: String(c.html_url).replace(/#.*$/, ''),
        subscribable: true,
        author: c.user?.login,
        text: c.body ?? '',
        url: c.html_url,
        createdAt: Date.parse(c.created_at),
        policy: { ...base, isBot: isBot(c.user), reviewBot: reviewBot(c.user), mentioned: mentions(c.body ?? '', kw) },
      });
    }

    const reviewComments: any[] = await ghList(`repos/${slug}/pulls/comments?sort=updated&direction=asc&per_page=100&${q}`);
    for (const c of reviewComments) {
      if (Date.parse(c.created_at) < since) continue;
      const number = Number(String(c.pull_request_url).split('/').pop());
      this.app.ingest.ingest({
        externalId: `gh:review_comment:${c.id}`,
        source: 'github',
        kind: 'review_comment',
        threadKey: `github:${slug}#${number}`,
        threadUrl: `https://github.com/${slug}/pull/${number}`,
        subscribable: true,
        author: c.user?.login,
        text: `${c.path}${c.line ? `:${c.line}` : ''}\n${c.body ?? ''}`,
        url: c.html_url,
        createdAt: Date.parse(c.created_at),
        meta: { path: c.path, line: c.line, diff_hunk: c.diff_hunk },
        policy: { ...base, isBot: isBot(c.user), reviewBot: reviewBot(c.user), mentioned: mentions(c.body ?? '', kw) },
      });
    }

    // Reviews have no repo-wide endpoint: check only PRs that workers follow.
    const followed = this.app.store.all<{ key: string }>(
      `SELECT DISTINCT t.key FROM threads t JOIN subscriptions s ON s.thread_id = t.id WHERE t.key LIKE ?`,
      `github:${slug}#%`,
    );
    for (const { key: tk } of followed) {
      const number = tk.split('#')[1];
      const reviews: any[] = await ghList(`repos/${slug}/pulls/${number}/reviews?per_page=100`).catch((e) => {
        failures.push(`reviews of #${number}: ${(e as Error).message}`);
        return [];
      });
      for (const r of reviews) {
        if (!r.submitted_at || Date.parse(r.submitted_at) < since) continue;
        if (r.state === 'COMMENTED' && !r.body) continue; // inline comments arrive separately
        this.app.ingest.ingest({
          externalId: `gh:review:${r.id}`,
          source: 'github',
          kind: 'review',
          threadKey: tk,
          subscribable: true,
          author: r.user?.login,
          text: `Review ${String(r.state).toLowerCase().replace('_', ' ')}${r.body ? `: ${r.body}` : ''}`,
          url: r.html_url,
          createdAt: Date.parse(r.submitted_at),
          policy: { ...base, isBot: isBot(r.user), reviewBot: reviewBot(r.user), mentioned: true },
        });
      }
    }

    if (repo.ci !== 'off') {
      // Only runs created since the day before the cursor, every page of them.
      const day = new Date(since - 86_400_000).toISOString().slice(0, 10);
      const pages = await ghPages(`repos/${slug}/actions/runs?per_page=100&created=${encodeURIComponent('>=' + day)}`).catch((e) => {
        failures.push(`CI runs: ${(e as Error).message}`);
        return [];
      });
      for (const wr of pages.flatMap((p: any) => p?.workflow_runs ?? [])) {
        if (wr.status !== 'completed' || Date.parse(wr.updated_at) < since) continue;
        let threadKey = `github:${slug}@${wr.head_branch}`;
        let subscribable = false;
        const pr = wr.pull_requests?.[0]?.number;
        if (pr) {
          threadKey = `github:${slug}#${pr}`;
          subscribable = true;
        } else {
          const w = this.app.store.get<WorkerRow>('SELECT * FROM workers WHERE branch = ? ORDER BY id DESC LIMIT 1', wr.head_branch);
          const m = w?.pr_url?.match(/\/pull\/(\d+)/);
          if (m) {
            threadKey = `github:${slug}#${m[1]}`;
            subscribable = true;
          }
        }
        this.app.ingest.ingest({
          externalId: `gh:run:${wr.id}:${wr.run_attempt ?? 1}`,
          source: 'github',
          kind: 'ci',
          threadKey,
          threadTitle: subscribable ? undefined : `CI on ${wr.head_branch}`,
          subscribable,
          author: wr.actor?.login,
          text: `CI "${wr.name}" ${wr.conclusion} on ${wr.head_branch} (${String(wr.head_sha).slice(0, 7)}). Inspect with: gh run view ${wr.id} --repo ${slug} --log-failed`,
          url: wr.html_url,
          createdAt: Date.parse(wr.updated_at),
          meta: { conclusion: wr.conclusion, run: wr.id },
          policy: { ...base, ciConclusion: wr.conclusion },
        });
      }
    }

    if (failures.length) throw new Error(failures.join('; ')); // try the same window again next time
    this.app.store.setKv(key, new Date(pollStart - OVERLAP_MS).toISOString());
  }
}
