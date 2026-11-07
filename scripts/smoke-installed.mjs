// Smoke test of the installed package, as a brand-new user would get it: install a package (a tarball from
// `npm pack`, or a registry spec) into an isolated prefix and home, then use it end to end with the mock
// agent. The real home, any running service and login items are never touched.
//
//   npm pack && node scripts/smoke-installed.mjs ./phigon-superagent-0.1.1.tgz
//   node scripts/smoke-installed.mjs @phigon/superagent         (the published package)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spec = process.argv[2] ? (fs.existsSync(process.argv[2]) ? path.resolve(process.argv[2]) : process.argv[2]) : '@phigon/superagent';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-smoke-'));
const home = path.join(T, 'home');
const prefix = path.join(T, 'prefix');
const project = path.join(T, 'project');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
fs.mkdirSync(prefix);
const bin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
const PATH = `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path}`;
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  SUPERAGENT_HOME: '',
  SUPERAGENT_SKIP_INTEGRATIONS: '',
  SUPERAGENT_SKIP_AUTOSTART: '1', // the Windows Run key is per user: never touch the real one
  SUPERAGENT_MOCK: '1',
  SUPERAGENT_SESSION: 'smoke-session',
  MOCK_DELAY_MS: '800',
  NO_COLOR: '1',
  PATH,
  Path: PATH,
};
delete env.SUPERAGENT_HOME;
delete env.SUPERAGENT_SKIP_INTEGRATIONS;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 180_000, shell: false, ...opts });
const sa = (args, opts = {}) => {
  const exe = process.platform === 'win32' ? path.join(prefix, 'node_modules', '@phigon', 'superagent', 'dist', 'cli.js') : path.join(bin, 'superagent');
  return process.platform === 'win32' ? sh(process.execPath, [exe, ...args], opts) : sh(exe, args, opts);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // npm.cmd can only be started through a shell on Windows; quote the paths for it.
  const q = (a) => (process.platform === 'win32' ? `"${a}"` : a);
  const inst = sh(npm, ['install', '-g', q(spec), '--prefix', q(prefix), '--no-fund', '--no-audit'], { shell: process.platform === 'win32' });
  check(inst.status === 0, `npm install -g ${path.basename(spec)} (${(inst.stdout + inst.stderr).match(/added \d+ package/)?.[0] ?? inst.stderr.slice(-300)})`);
  check(fs.existsSync(path.join(bin, process.platform === 'win32' ? 'superagent.cmd' : 'superagent')), 'the superagent command is on PATH');
  const ver = sa(['--version']).stdout.trim();
  check(/^\d+\.\d+\.\d+$/.test(ver), `superagent --version → ${ver}`);

  const install = sa(['install']);
  check(install.status === 0 && /Claude Code/.test(install.stdout), 'superagent install');
  const claudeSkill = path.join(home, '.claude', 'skills', 'superagent', 'SKILL.md');
  check(fs.existsSync(claudeSkill) && /command: superagent hook prompt/.test(fs.readFileSync(claudeSkill, 'utf8')), 'Claude Code skill installed, with the prompt hook');
  check(fs.existsSync(path.join(home, '.codex', 'skills', 'superagent', 'SKILL.md')), 'Codex skill installed');

  // Use the mock agent and a spare port for this fresh service.
  const data = path.join(home, '.superagent');
  fs.mkdirSync(data, { recursive: true });
  const cfgFile = path.join(data, 'config.json');
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : { router: {}, workers: {} };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ...cfg, port: 19811, router: { ...cfg.router, agent: 'mock', model: '' }, workers: { ...cfg.workers, defaultAgent: 'mock' }, github: { enabled: false } }, null, 2));

  const doctor = sa(['doctor', '--json']);
  const dj = JSON.parse(doctor.stdout);
  check(dj.skill.some((i) => i.agent === 'claude' && i.path && i.current), 'doctor --json: skill current for Claude Code');

  fs.mkdirSync(project);
  sh('git', ['-C', project, 'init', '-q', '-b', 'main']);
  sh('git', ['-C', project, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);

  const attach = sa(['router', 'attach'], { cwd: project });
  check(attach.status === 0 && /You are now the router/.test(attach.stdout), 'router attach starts the service by itself and attaches');
  const d = sa(['dispatch', 'Add a CHANGELOG entry', '--repo', '.', '--json'], { cwd: project });
  const started = JSON.parse(d.stdout || '{}');
  check(started.ok && started.repo === 'project', `dispatch --repo . → ${started.worker} in repo ${started.repo}`);

  let report = null;
  for (let i = 0; i < 40 && !report; i++) {
    const ev = JSON.parse(sa(['events', '--wait', '5', '--json']).stdout || '{}');
    report = ev.events?.find((e) => e.worker === started.worker);
    if (report) check(ev.text.includes(`branch superagent/w${started.worker.slice(2)}-`), 'the report says where the work is');
  }
  check(!!report && /Mock finished/.test(report.text), 'the worker report arrives in events');

  const diff = sa(['diff', started.worker]);
  check(/Not committed:[\s\S]*mock-output\.txt/.test(diff.stdout), 'diff shows the worker’s changes');
  check(new RegExp(`${started.worker} Mock Agent · done`).test(sa(['graph']).stdout), 'graph shows the finished worker');

  // Another job, then the Claude Code hook notice for this session before `events` hands it out.
  const d2 = JSON.parse(sa(['dispatch', 'Second job', '--json']).stdout || '{}');
  for (let i = 0; i < 40; i++) {
    const w = JSON.parse(sa(['workers', '--json']).stdout || '[]').find((x) => `W#${x.id}` === d2.worker);
    if (w?.status === 'done') break;
    await sleep(500);
  }
  const hook = sa(['hook', 'prompt'], { input: JSON.stringify({ session_id: 'smoke-session' }) });
  check(/\[SuperAgent\] You are the router and 1 event is waiting/.test(hook.stdout), 'the prompt hook announces the waiting report');

  check(sa(['router', 'detach']).status === 0, 'router detach');
  check(sa(['stop']).status === 0, 'stop');
  const un = sa(['uninstall']);
  check(un.status === 0 && !fs.existsSync(claudeSkill), 'uninstall removes the skill');
} catch (e) {
  check(false, String(e?.stack ?? e));
} finally {
  sa(['stop']);
  await sleep(500);
  fs.rmSync(T, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
