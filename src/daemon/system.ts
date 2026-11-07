import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepo, type RepoConfig, type SourceMode } from '../core/config.js';
import { CLI_PATH, paths, SKILL_DIR } from '../core/paths.js';
import { run } from '../agents/process.js';

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
    // Safe default: only you can trigger the agent from GitHub. Clear the list in Settings to open it up.
    const me = await run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 20_000 });
    allowUsers = me.code === 0 && me.stdout.trim() ? [me.stdout.trim()] : [];
  }
  return normalizeRepo({ ...repo, name: opts.name, mode: opts.mode, agent: opts.agent as RepoConfig['agent'], allowUsers });
}

// ---------- skill ----------

export type SkillTarget = 'claude' | 'codex';

function skillDest(target: SkillTarget): string {
  return target === 'codex'
    ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'superagent')
    : path.join(os.homedir(), '.claude', 'skills', 'superagent');
}

export function installSkill(target: SkillTarget): string {
  const dest = skillDest(target);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(SKILL_DIR)) fs.copyFileSync(path.join(SKILL_DIR, f), path.join(dest, f));
  return path.join(dest, 'SKILL.md');
}

export function skillStatus(): Record<SkillTarget, boolean> {
  return {
    claude: fs.existsSync(path.join(skillDest('claude'), 'SKILL.md')),
    codex: fs.existsSync(path.join(skillDest('codex'), 'SKILL.md')),
  };
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

// ---------- misc ----------

export function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

export function openFolder(dir: string): void {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
