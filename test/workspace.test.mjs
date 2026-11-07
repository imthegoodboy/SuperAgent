// Worker workspaces: git worktrees, and self-contained clones for agents whose sandbox can only write
// inside their own folder (Codex in "safe" mode).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-ws-'));
process.env.SUPERAGENT_HOME = path.join(tmp, 'data'); // before the modules read it
const { prepareWorkspace, syncBranch, removeWorkspace } = await import('../dist/workers/workspace.js');

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();

function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return { name, path: dir, mode: 'off', ci: 'failures', allowUsers: [] };
}

test('a worktree shares the repo, so its branch is there at once', async () => {
  const repo = makeRepo('wt');
  const ws = await prepareWorkspace({ id: 1, title: 'Worktree job' }, repo);
  assert.equal(ws.branch, 'superagent/w1-worktree-job');
  assert.ok(fs.statSync(path.join(ws.cwd, '.git')).isFile(), 'a worktree has a .git file');
  assert.ok(!ws.gitDir.startsWith(ws.cwd), 'and its git data lives in the main repo');
  assert.equal(git(repo.path, 'rev-parse', '--verify', 'refs/heads/superagent/w1-worktree-job'), git(repo.path, 'rev-parse', 'main'));
});

test('a self-contained clone keeps all git writes inside the workspace and syncs its branch back', async () => {
  const repo = makeRepo('own');
  const base = git(repo.path, 'rev-parse', 'main');
  const w = { id: 2, title: 'Sandboxed job' };
  const ws = await prepareWorkspace(w, repo, { ownGitDir: true });
  assert.ok(fs.statSync(path.join(ws.cwd, '.git')).isDirectory(), 'its own .git folder');
  assert.ok(path.resolve(ws.gitDir).startsWith(path.resolve(ws.cwd)), 'git data inside the workspace');
  assert.equal(ws.base, 'main');
  assert.equal(git(ws.cwd, 'rev-parse', 'main'), base, 'the base ref points where it does in the repo');
  assert.equal(git(ws.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'superagent/w2-sandboxed-job');

  fs.writeFileSync(path.join(ws.cwd, 'game.html'), '<h1>game</h1>\n');
  git(ws.cwd, 'add', 'game.html');
  git(ws.cwd, 'commit', '-q', '-m', 'Add a game');
  const head = git(ws.cwd, 'rev-parse', 'HEAD');
  assert.throws(() => git(repo.path, 'rev-parse', '--verify', '--quiet', 'refs/heads/superagent/w2-sandboxed-job'), 'not in the repo before the sync');

  await syncBranch({ ...w, cwd: ws.cwd, branch: ws.branch }, repo);
  assert.equal(git(repo.path, 'rev-parse', 'refs/heads/superagent/w2-sandboxed-job'), head, 'the branch is in the repo after the sync');

  // A later workspace for the same task (say, after archive) continues from that branch.
  await removeWorkspace({ ...w, cwd: ws.cwd, branch: ws.branch, git_dir: ws.gitDir });
  assert.ok(!fs.existsSync(ws.cwd));
  const again = await prepareWorkspace(w, repo, { ownGitDir: true });
  assert.equal(git(again.cwd, 'rev-parse', 'HEAD'), head);
});
