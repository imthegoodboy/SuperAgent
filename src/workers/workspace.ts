import fs from 'node:fs';
import path from 'node:path';
import type { RepoConfig } from '../core/config.js';
import { paths } from '../core/paths.js';
import type { WorkerRow } from '../core/store.js';
import { slugify } from '../core/util.js';
import { run, runOk } from '../agents/process.js';

export interface Workspace {
  cwd: string;
  branch: string | null;
  base: string | null;
  gitDir: string | null;
}

/** Local checkout for a configured repo, cloning it on first use when only owner/repo is known. */
export async function ensureCheckout(repo: RepoConfig): Promise<string> {
  if (repo.path) {
    if (!fs.existsSync(path.join(repo.path, '.git'))) throw new Error(`${repo.path} is not a git repository`);
    return repo.path;
  }
  if (!repo.slug) throw new Error(`repo ${repo.name} has neither a path nor a GitHub slug`);
  const dest = path.join(paths.repos, ...repo.slug.split('/'));
  if (!fs.existsSync(path.join(dest, '.git'))) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await runOk('gh', ['repo', 'clone', repo.slug, dest], { timeoutMs: 10 * 60_000 });
  }
  return dest;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runOk('git', ['-C', cwd, ...args], { timeoutMs: 5 * 60_000 })).trim();
}

/** Each task gets its own git worktree and branch, so parallel workers never step on each other. */
export async function prepareWorkspace(w: WorkerRow, repo: RepoConfig | undefined): Promise<Workspace> {
  if (!repo) {
    const cwd = path.join(paths.scratch, `w${w.id}`);
    fs.mkdirSync(cwd, { recursive: true });
    return { cwd, branch: null, base: null, gitDir: null };
  }
  const checkout = await ensureCheckout(repo);
  const hasOrigin = (await run('git', ['-C', checkout, 'remote', 'get-url', 'origin'])).code === 0;
  if (hasOrigin) await run('git', ['-C', checkout, 'fetch', 'origin', '--prune', '--quiet'], { timeoutMs: 5 * 60_000 });

  let base: string | null = null;
  if (hasOrigin) {
    const head = await run('git', ['-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head.code === 0 && head.stdout.trim()) base = head.stdout.trim();
    else {
      for (const b of ['origin/main', 'origin/master']) {
        if ((await run('git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', b])).code === 0) {
          base = b;
          break;
        }
      }
    }
  }
  if (!base) base = (await git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';

  const branch = `superagent/w${w.id}-${slugify(w.title, 32)}`;
  const cwd = path.join(paths.worktrees, `${slugify(repo.name, 24)}-w${w.id}`);
  if (!fs.existsSync(cwd)) {
    const exists = (await run('git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    await git(checkout, exists ? ['worktree', 'add', cwd, branch] : ['worktree', 'add', '-b', branch, cwd, base]);
  }
  const common = await git(cwd, ['rev-parse', '--git-common-dir']);
  return { cwd, branch, base, gitDir: path.resolve(cwd, common) };
}

/** Remove a worker's worktree (the branch stays, it may back an open PR). */
export async function removeWorkspace(w: WorkerRow): Promise<void> {
  if (!w.cwd || !fs.existsSync(w.cwd)) return;
  if (w.git_dir && w.branch) {
    const main = path.dirname(w.git_dir);
    const r = await run('git', ['-C', main, 'worktree', 'remove', '--force', w.cwd]);
    if (r.code === 0) return;
  }
  if (w.cwd.startsWith(paths.home)) fs.rmSync(w.cwd, { recursive: true, force: true });
}
