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
  /** Another target whose skill folder this agent also reads (so it would see the skill twice). */
  readsFrom?: string;
}

function targets(): Target[] {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    { agent: 'claude', label: 'Claude Code', base: path.join(home, '.claude'), command: 'claude' },
    { agent: 'codex', label: 'Codex', base: process.env.CODEX_HOME || path.join(home, '.codex'), command: 'codex' },
    // OpenCode also loads ~/.claude/skills.
    { agent: 'opencode', label: 'OpenCode', base: path.join(xdg, 'opencode'), command: 'opencode', readsFrom: 'claude' },
    { agent: 'cursor', label: 'Cursor', base: path.join(home, '.cursor'), command: 'cursor-agent' },
  ];
}

const skillDir = (t: Target) => path.join(t.base, 'skills', 'superagent');
const STAMP = () => path.join(paths.home, 'integrations.json');

export interface Integration {
  agent: string;
  label: string;
  /** The agent is on this computer. */
  detected: boolean;
  /** Where the skill lives for this agent (possibly another agent's folder it also reads). */
  path: string | null;
  /** The installed skill matches this version of SuperAgent. */
  current: boolean;
}

function skillHash(): string {
  return crypto.createHash('sha1').update(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'))).digest('hex');
}

function fileHash(file: string): string | null {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function detected(t: Target): boolean {
  return fs.existsSync(t.base) || !!which(t.command);
}

function copySkill(dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(SKILL_DIR)) fs.copyFileSync(path.join(SKILL_DIR, f), path.join(dest, f));
}

/** Where each detected agent should get the skill; agents that already read another folder share it. */
function plan(): { target: Target; dest: string; own: boolean }[] {
  const all = targets();
  const found = all.filter(detected);
  return found.map((t) => {
    const via = t.readsFrom ? found.find((o) => o.agent === t.readsFrom) : undefined;
    return { target: t, dest: skillDir(via ?? t), own: !via };
  });
}

export function integrationStatus(): Integration[] {
  const hash = skillHash();
  const byAgent = new Map(plan().map((p) => [p.target.agent, p]));
  return targets().map((t) => {
    const p = byAgent.get(t.agent);
    const file = p ? path.join(p.dest, 'SKILL.md') : null;
    const h = file ? fileHash(file) : null;
    return { agent: t.agent, label: t.label, detected: !!p, path: h ? p!.dest : null, current: h === hash };
  });
}

interface Stamp {
  hash: string;
  /** Agents we have installed the skill for at least once. */
  agents: string[];
  autostart?: boolean;
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
  for (const p of plan()) if (p.own) copySkill(p.dest);
  const st = readStamp();
  writeStamp({ ...st, hash: skillHash(), agents: plan().map((p) => p.target.agent) });
  return integrationStatus();
}

/**
 * Cheap check run by every CLI command, so installing the package is the only step a person takes:
 * agents installed later get the skill, and an updated skill reaches the folders that have it.
 * A skill someone deleted on purpose stays deleted.
 */
export function ensureIntegrations(): void {
  if (process.env.SUPERAGENT_SKIP_INTEGRATIONS === '1' || process.env.SUPERAGENT_WORKER) return;
  const st = readStamp();
  const hash = skillHash();
  const todo = plan().filter(
    (p) => p.own && (!st?.agents.includes(p.target.agent) || (st.hash !== hash && fs.existsSync(path.join(p.dest, 'SKILL.md')))),
  );
  if (st && st.hash === hash && !todo.length) return;
  for (const p of todo) copySkill(p.dest);
  writeStamp({ ...st, hash, agents: [...new Set([...(st?.agents ?? []), ...plan().map((p) => p.target.agent)])] });
}

/** Turn on start-at-login once, the first time SuperAgent starts. Someone who turns it off keeps it off. */
export async function ensureAutostartOnce(): Promise<void> {
  if (process.env.SUPERAGENT_SKIP_INTEGRATIONS === '1' || process.env.SUPERAGENT_SKIP_AUTOSTART === '1') return;
  const st = readStamp() ?? { hash: '', agents: [] };
  if (st.autostart !== undefined) return;
  let on = false;
  try {
    on = await setAutostart(true);
  } catch {
    /* not fatal: it simply won't start at login */
  }
  writeStamp({ ...st, autostart: on });
}

/** Remove the skill from every agent folder we put it in. */
export function uninstallIntegrations(): string[] {
  const removed: string[] = [];
  for (const t of targets()) {
    const dir = skillDir(t);
    const file = path.join(dir, 'SKILL.md');
    try {
      // Only ever delete our own skill.
      if (/^name: superagent$/m.test(fs.readFileSync(file, 'utf8'))) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {
      /* not installed there */
    }
  }
  fs.rmSync(STAMP(), { force: true });
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
