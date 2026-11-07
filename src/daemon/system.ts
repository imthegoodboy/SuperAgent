import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepo, type RepoConfig, type SourceMode } from '../core/config.js';
import { CLI_PATH, paths, SKILL_DIR } from '../core/paths.js';
import { run, which } from '../agents/process.js';

// ---------- repos ----------

export function slugFromRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

const samePath = (a?: string, b?: string) =>
  !!a && !!b && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/**
 * Add a repo to the list without clobbering another one. The same repository (same GitHub slug or same
 * checkout) is updated in place, keeping its settings except the ones given explicitly. A different
 * repository with a name that is already taken gets a numbered name.
 */
export function addRepo(
  repos: RepoConfig[],
  repo: RepoConfig,
  explicit: { mode?: string; agent?: string; allowUsers?: string[]; name?: string } = {},
): { repos: RepoConfig[]; repo: RepoConfig } {
  const same = repos.find((r) => (r.slug && repo.slug && r.slug.toLowerCase() === repo.slug.toLowerCase()) || samePath(r.path, repo.path));
  if (same) {
    const merged = normalizeRepo({
      ...same,
      slug: same.slug ?? repo.slug,
      path: repo.path ?? same.path,
      ...(explicit.name ? { name: explicit.name } : {}),
      ...(explicit.mode ? { mode: explicit.mode as SourceMode } : {}),
      ...(explicit.agent ? { agent: explicit.agent as RepoConfig['agent'] } : {}),
      ...(explicit.allowUsers ? { allowUsers: explicit.allowUsers } : {}),
    });
    return { repos: repos.map((r) => (r === same ? merged : r)), repo: merged };
  }
  let name = repo.name;
  const taken = (n: string) => repos.some((r) => r.name.toLowerCase() === n.toLowerCase());
  for (let i = 2; taken(name); i++) name = `${repo.name}-${i}`;
  const added = { ...repo, name };
  return { repos: [...repos, added], repo: added };
}

/** The configured repo whose checkout contains this folder, if any. */
export async function repoForFolder(repos: RepoConfig[], folder: string): Promise<RepoConfig | undefined> {
  const top = await run('git', ['-C', path.resolve(folder), 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) return undefined;
  return repos.find((r) => samePath(r.path, top.stdout.trim()));
}

/** Turn "C:\code\app", "owner/repo" or a GitHub URL into a repo entry. */
export async function resolveRepoInput(
  input: string,
  opts: { mode?: SourceMode; name?: string; agent?: string; allowUsers?: string[] } = {},
): Promise<RepoConfig> {
  const raw = input.trim();
  let repo: Partial<RepoConfig> = {};
  const asPath = path.resolve(raw);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
    const top = await run('git', ['-C', asPath, 'rev-parse', '--show-toplevel']);
    if (top.code !== 0) throw new Error(`${asPath} is not inside a git repository`);
    const root = path.resolve(top.stdout.trim());
    const remote = await run('git', ['-C', root, 'remote', 'get-url', 'origin']);
    repo = { path: root, slug: remote.code === 0 ? slugFromRemote(remote.stdout) ?? undefined : undefined };
  } else {
    const slug = slugFromRemote(raw) ?? (/^[\w.-]+\/[\w.-]+$/.test(raw) ? raw : null);
    if (!slug) throw new Error(`"${raw}" is not a folder, owner/repo, or GitHub URL`);
    const view = await run('gh', ['repo', 'view', slug, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { timeoutMs: 30_000 });
    if (view.code !== 0) throw new Error(`GitHub repo ${slug} not found or gh is not logged in: ${(view.stderr || '').trim().slice(0, 200)}`);
    repo = { slug: view.stdout.trim() || slug };
  }
  let allowUsers = opts.allowUsers;
  if (!allowUsers && repo.slug) {
    // Safe default: only you can trigger the agent from GitHub. Widen it with `repo add --allow`.
    const me = await run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 20_000 });
    allowUsers = me.code === 0 && me.stdout.trim() ? [me.stdout.trim()] : [];
  }
  return normalizeRepo({ ...repo, name: opts.name, mode: opts.mode, agent: opts.agent as RepoConfig['agent'], allowUsers });
}

// ---------- agent integrations: the skill, installed for every coding agent here ----------

/**
 * Every supported agent reads skills from a global folder. Installing ours there is what turns an
 * agent into SuperAgent's router: the skill tells it how to drive the `superagent` CLI.
 */
interface Target {
  agent: string;
  label: string;
  /** The agent's own config folder; it exists once the agent has been used here. */
  base: string;
  command: string;
}

function targets(): Target[] {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    { agent: 'claude', label: 'Claude Code', base: path.join(home, '.claude'), command: 'claude' },
    { agent: 'codex', label: 'Codex', base: process.env.CODEX_HOME || path.join(home, '.codex'), command: 'codex' },
    { agent: 'opencode', label: 'OpenCode', base: path.join(xdg, 'opencode'), command: 'opencode' },
    { agent: 'cursor', label: 'Cursor', base: path.join(home, '.cursor'), command: 'cursor-agent' },
  ];
}

const skillDir = (t: Target) => path.join(t.base, 'skills', 'superagent');

/**
 * The agents' skill folders and login items are global, but each data folder has its own stamp. With a
 * data folder other than ~/.superagent (development, tests), automatic setup leaves them alone.
 */
function customHome(): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(paths.home) !== norm(path.join(os.homedir(), '.superagent'));
}
const STAMP = () => path.join(paths.home, 'integrations.json');

export interface Integration {
  agent: string;
  label: string;
  /** The agent is on this computer. */
  detected: boolean;
  /** Where the skill lives for this agent. */
  path: string | null;
  /** The installed skill matches this version of SuperAgent. */
  current: boolean;
}

/**
 * Claude Code runs hooks declared in a skill's frontmatter for the rest of a session once the skill
 * has been used. This one shows waiting events on every user message, without the agent asking. Other
 * agents follow the plain Agent Skills format, so only Claude Code's copy carries it.
 */
const CLAUDE_HOOKS = `hooks:
  UserPromptSubmit:
    - hooks:
        - type: command
          command: superagent hook prompt
          timeout: 5
`;

const sha1 = (s: string | Buffer) => crypto.createHash('sha1').update(s).digest('hex');

/** SKILL.md as installed for one agent. */
function skillText(t: Target): string {
  const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  return t.agent === 'claude' ? text.replace(/^(---\r?\n[\s\S]*?\r?\n)(---\r?\n)/, `$1${CLAUDE_HOOKS}$2`) : text;
}

/** Changes whenever what we would install changes. */
function skillHash(): string {
  return sha1(targets().map(skillText).join('\0'));
}

function fileHash(file: string): string | null {
  try {
    return sha1(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function detected(t: Target): boolean {
  return fs.existsSync(t.base) || !!which(t.command);
}

function copySkill(t: Target): void {
  const dest = skillDir(t);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(SKILL_DIR)) {
    if (f === 'SKILL.md') fs.writeFileSync(path.join(dest, f), skillText(t));
    else fs.copyFileSync(path.join(SKILL_DIR, f), path.join(dest, f));
  }
}

/** The agents on this computer, each with its own copy of the skill. */
function plan(): { target: Target; dest: string }[] {
  return targets()
    .filter(detected)
    .map((t) => ({ target: t, dest: skillDir(t) }));
}

export function integrationStatus(): Integration[] {
  const byAgent = new Map(plan().map((p) => [p.target.agent, p]));
  return targets().map((t) => {
    const p = byAgent.get(t.agent);
    const file = p ? path.join(p.dest, 'SKILL.md') : null;
    const h = file ? fileHash(file) : null;
    return { agent: t.agent, label: t.label, detected: !!p, path: h ? p!.dest : null, current: h === sha1(skillText(t)) };
  });
}

interface Stamp {
  hash: string;
  /** Agents we have installed the skill for at least once. */
  agents: string[];
  /** Start at login: set once on first start, or by the person with `autostart on|off`. */
  autostart?: boolean;
  /** `superagent uninstall` ran: install nothing until `superagent install` or a fresh npm install. */
  uninstalled?: boolean;
}

function readStamp(): Stamp | null {
  try {
    return JSON.parse(fs.readFileSync(STAMP(), 'utf8'));
  } catch {
    return null;
  }
}

function writeStamp(st: Stamp): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(STAMP(), JSON.stringify(st, null, 2));
}

/** Install (or refresh) the skill for every coding agent on this computer. */
export function installIntegrations(): Integration[] {
  for (const p of plan()) copySkill(p.target);
  const st = readStamp();
  writeStamp({ ...st, hash: skillHash(), agents: plan().map((p) => p.target.agent), uninstalled: undefined });
  return integrationStatus();
}

/** After `npm install -g`: a first install (or one after `uninstall`) installs everywhere; an upgrade refreshes. */
export function postinstallIntegrations(): Integration[] {
  const st = readStamp();
  if (!st || st.uninstalled) return installIntegrations();
  ensureIntegrations();
  return integrationStatus();
}

/**
 * Cheap check run by every CLI command, so installing the package is the only step a person takes:
 * agents installed later get the skill, and an updated skill reaches the folders that have it.
 * A skill someone deleted on purpose stays deleted.
 */
export function ensureIntegrations(): void {
  if (process.env.SUPERAGENT_SKIP_INTEGRATIONS === '1' || process.env.SUPERAGENT_WORKER || customHome()) return;
  const st = readStamp();
  if (st?.uninstalled) return;
  const hash = skillHash();
  const todo = plan().filter((p) => !st?.agents.includes(p.target.agent) || (st.hash !== hash && fs.existsSync(path.join(p.dest, 'SKILL.md'))));
  if (st && st.hash === hash && !todo.length) return;
  for (const p of todo) copySkill(p.target);
  writeStamp({ ...st, hash, agents: [...new Set([...(st?.agents ?? []), ...plan().map((p) => p.target.agent)])] });
}

/** Turn on start-at-login once, the first time SuperAgent starts. Someone who turns it off keeps it off. */
export async function ensureAutostartOnce(): Promise<void> {
  if (process.env.SUPERAGENT_SKIP_INTEGRATIONS === '1' || process.env.SUPERAGENT_SKIP_AUTOSTART === '1' || customHome()) return;
  const st = readStamp() ?? { hash: '', agents: [] };
  if (st.autostart !== undefined || st.uninstalled) return;
  let on = false;
  try {
    on = await setAutostart(true);
  } catch {
    /* not fatal: it simply won't start at login */
  }
  writeStamp({ ...st, autostart: on });
}

/** `superagent autostart on|off`: the person's choice, which the first start must not override. */
export async function chooseAutostart(enabled: boolean): Promise<boolean> {
  const on = await setAutostart(enabled);
  writeStamp({ ...(readStamp() ?? { hash: '', agents: [] }), autostart: on });
  return on;
}

/** Remove the skill files we put in each agent's folder (and the folder, if nothing else is in it). */
export function uninstallIntegrations(): string[] {
  const ours = fs.readdirSync(SKILL_DIR);
  const removed: string[] = [];
  for (const t of targets()) {
    const dir = skillDir(t);
    try {
      // Only ever delete our own skill, and only the files it consists of.
      if (!/^name: superagent$/m.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))) continue;
    } catch {
      continue; // not installed there
    }
    for (const f of ours) fs.rmSync(path.join(dir, f), { force: true });
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    removed.push(dir);
  }
  writeStamp({ ...(readStamp() ?? { hash: '', agents: [] }), uninstalled: true });
  return removed;
}

// ---------- autostart (start SuperAgent when you log in) ----------

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.superagent.daemon.plist');
const LINUX_DESKTOP = path.join(os.homedir(), '.config', 'autostart', 'superagent.desktop');

export async function autostartStatus(): Promise<boolean> {
  if (process.platform === 'win32') return (await run('reg', ['query', RUN_KEY, '/v', 'SuperAgent'])).code === 0;
  if (process.platform === 'darwin') return fs.existsSync(MAC_PLIST);
  return fs.existsSync(LINUX_DESKTOP);
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  const node = process.execPath;
  if (process.platform === 'win32') {
    if (!enabled) {
      await run('reg', ['delete', RUN_KEY, '/v', 'SuperAgent', '/f']);
      return autostartStatus();
    }
    const vbs = path.join(paths.home, 'autostart.vbs');
    fs.writeFileSync(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${node}"" ""${CLI_PATH}"" start", 0, False\r\n`);
    const r = await run('reg', ['add', RUN_KEY, '/v', 'SuperAgent', '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f']);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'reg add failed');
    return true;
  }
  if (process.platform === 'darwin') {
    if (!enabled) fs.rmSync(MAC_PLIST, { force: true });
    else {
      fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
      fs.writeFileSync(
        MAC_PLIST,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.superagent.daemon</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${CLI_PATH}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH ?? ''}</string></dict>
</dict></plist>
`,
      );
    }
    return fs.existsSync(MAC_PLIST);
  }
  if (!enabled) fs.rmSync(LINUX_DESKTOP, { force: true });
  else {
    fs.mkdirSync(path.dirname(LINUX_DESKTOP), { recursive: true });
    fs.writeFileSync(LINUX_DESKTOP, `[Desktop Entry]\nType=Application\nName=SuperAgent\nExec="${node}" "${CLI_PATH}" start\nX-GNOME-Autostart-enabled=true\n`);
  }
  return fs.existsSync(LINUX_DESKTOP);
}
