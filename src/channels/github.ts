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

async function ghJson(pathAndQuery: string): Promise<any> {
  const r = await run('gh', ['api', '-H', 'Accept: application/vnd.github+json', pathAndQuery], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300) || `gh api ${pathAndQuery} failed`);
  return tryJson(r.stdout);
}

/**
 * Polls GitHub through the user's own `gh` login (no webhooks, no server, no extra auth).
 * Emits triggers for new issues/PRs, comments, review comments, reviews on followed PRs,
 * finished CI runs, and closed/merged threads.
 */
export class GitHubSource {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  login: string | null = null;
  lastError: string | null = null;
  lastPollAt: number | null = null;

  constructor(private app: App) {}

  start(): void {
    this.stop();
    void this.detectLogin();
    const tick = async () => {
      await this.pollAll();
      this.timer = setTimeout(tick, this.app.config.github.pollSeconds * 1000);
    };
    this.timer = setTimeout(tick, 3000);
  }

  stop(): void {
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

    const issues: any[] = (await ghJson(`repos/${slug}/issues?state=all&sort=updated&direction=asc&per_page=50&${q}`)) ?? [];
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

    const comments: any[] = (await ghJson(`repos/${slug}/issues/comments?sort=updated&direction=asc&per_page=100&${q}`)) ?? [];
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
        policy: { ...base, isBot: isBot(c.user), mentioned: mentions(c.body ?? '', kw) },
      });
    }

    const reviewComments: any[] = (await ghJson(`repos/${slug}/pulls/comments?sort=updated&direction=asc&per_page=100&${q}`)) ?? [];
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
        policy: { ...base, isBot: isBot(c.user), mentioned: mentions(c.body ?? '', kw) },
      });
    }

    // Reviews have no repo-wide endpoint: check only PRs that workers follow.
    const followed = this.app.store.all<{ key: string }>(
      `SELECT DISTINCT t.key FROM threads t JOIN subscriptions s ON s.thread_id = t.id WHERE t.key LIKE ?`,
      `github:${slug}#%`,
    );
    for (const { key: tk } of followed) {
      const number = tk.split('#')[1];
      const reviews: any[] = (await ghJson(`repos/${slug}/pulls/${number}/reviews?per_page=50`).catch(() => [])) ?? [];
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
          policy: { ...base, isBot: isBot(r.user), mentioned: true },
        });
      }
    }

    if (repo.ci !== 'off') {
      const runs: any = await ghJson(`repos/${slug}/actions/runs?per_page=25`).catch(() => null);
      for (const wr of runs?.workflow_runs ?? []) {
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

    this.app.store.setKv(key, new Date(pollStart - OVERLAP_MS).toISOString());
  }
}
