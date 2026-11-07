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

const cloning = new Map<string, Promise<void>>();

/** Local checkout for a configured repo, cloning it on first use when only owner/repo is known. */
export async function ensureCheckout(repo: RepoConfig): Promise<string> {
  if (repo.path) {
    if (!fs.existsSync(path.join(repo.path, '.git'))) {
      throw new Error(
        `${repo.path} is not a git repository${fs.existsSync(repo.path) ? '' : ' (the folder is gone: moved or deleted?)'}. ` +
          `Fix it with \`superagent repo add <new path> --name ${repo.name}\`, or remove it with \`superagent repo rm ${repo.name}\`.`,
      );
    }
    return repo.path;
  }
  if (!repo.slug) throw new Error(`repo ${repo.name} has neither a path nor a GitHub slug`);
  const dest = path.join(paths.repos, ...repo.slug.split('/'));
  if (!fs.existsSync(path.join(dest, '.git'))) {
    // Two workers dispatched at once to a repo that isn't cloned yet share one clone.
    let pending = cloning.get(dest);
    if (!pending) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      pending = runOk('gh', ['repo', 'clone', repo.slug, dest], { timeoutMs: 10 * 60_000 }).then(() => undefined);
      cloning.set(dest, pending);
      pending.finally(() => cloning.delete(dest)).catch(() => {});
    }
    await pending;
  }
  return dest;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runOk('git', ['-C', cwd, ...args], { timeoutMs: 5 * 60_000 })).trim();
}

/**
 * Each task gets its own git worktree and branch, so parallel workers never step on each other.
 * `ownGitDir`: a sandboxed agent can only write inside its folder, but a worktree keeps its index in the
 * main repo's .git. Such a worker gets a self-contained clone that shares the repo's objects
 * (`clone --shared`, nothing is copied); `syncBranch` brings its branch back into the repo.
 */
export async function prepareWorkspace(w: WorkerRow, repo: RepoConfig | undefined, opts: { ownGitDir?: boolean } = {}): Promise<Workspace> {
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
  // A base the router asked for (dispatch --base): a branch of the person's own, for example.
  if (w.base) {
    const wanted = w.base;
    // A branch, local or on origin: the worker's PR goes against it, and a PR needs a branch.
    const ok = async (ref: string) => (await run('git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', ref])).code === 0;
    if (wanted.startsWith('origin/') && (await ok(`refs/remotes/${wanted}`))) base = wanted;
    else if (await ok(`refs/heads/${wanted}`)) base = wanted;
    else if (hasOrigin && (await ok(`refs/remotes/origin/${wanted}`))) base = `origin/${wanted}`;
    else throw new Error(`base "${wanted}" is not a branch in ${repo.name}`);
  }

  const branch = `superagent/w${w.id}-${slugify(w.title, 32)}`;
  const cwd = path.join(paths.worktrees, `${slugify(repo.name, 24)}-w${w.id}`);
  if (!fs.existsSync(cwd)) {
    const existing = await run('git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (opts.ownGitDir) {
      const baseSha = await git(checkout, ['rev-parse', `${base}^{commit}`]);
      const start = existing.code === 0 ? existing.stdout.trim() : baseSha;
      await runOk('git', ['clone', '--quiet', '--shared', '--no-checkout', checkout, cwd], { timeoutMs: 5 * 60_000 });
      // The base ref points where it does in the repo, so diffs and PRs read the same as in a worktree.
      if (base !== 'HEAD') await git(cwd, ['update-ref', base.startsWith('origin/') ? `refs/remotes/${base}` : `refs/heads/${base}`, baseSha]);
      await git(cwd, ['checkout', '--quiet', '-B', branch, start]);
      // Pushes and PRs go where the repo's own origin points.
      const url = hasOrigin ? (await run('git', ['-C', checkout, 'remote', 'get-url', 'origin'])).stdout.trim() : '';
      if (url) await git(cwd, ['remote', 'set-url', 'origin', url]);
    } else {
      await git(checkout, existing.code === 0 ? ['worktree', 'add', cwd, branch] : ['worktree', 'add', '-b', branch, cwd, base]);
    }
  }
  const common = await git(cwd, ['rev-parse', '--git-common-dir']);
  return { cwd, branch, base, gitDir: path.resolve(cwd, common) };
}

/** A worker in its own clone: copy its branch into the repo, where a worktree's branch would already be. */
export async function syncBranch(w: WorkerRow, repo: RepoConfig | undefined): Promise<void> {
  if (!repo || !w.cwd || !w.branch) return;
  if (!fs.statSync(path.join(w.cwd, '.git'), { throwIfNoEntry: false })?.isDirectory()) return; // a worktree
  const checkout = await ensureCheckout(repo);
  // Refused (and harmless) if the person has that branch checked out themselves.
  await run('git', ['-C', checkout, 'fetch', '--quiet', w.cwd, `+refs/heads/${w.branch}:refs/heads/${w.branch}`], { timeoutMs: 5 * 60_000 });
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
