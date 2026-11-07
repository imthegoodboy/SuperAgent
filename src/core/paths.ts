import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Everything SuperAgent keeps lives under one folder. SUPERAGENT_HOME overrides it (tests, dev). */
export const HOME = path.resolve(process.env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent'));

/** Identifies which data folder a running daemon serves, without revealing the path. */
export const HOME_ID = crypto.createHash('sha256').update(HOME.toLowerCase()).digest('hex').slice(0, 12);

export const paths = {
  home: HOME,
  db: path.join(HOME, 'superagent.db'),
  config: path.join(HOME, 'config.json'),
  token: path.join(HOME, 'token'),
  logs: path.join(HOME, 'logs'),
  run: path.join(HOME, 'run'),
  worktrees: path.join(HOME, 'worktrees'),
  scratch: path.join(HOME, 'scratch'),
  repos: path.join(HOME, 'repos'),
  router: path.join(HOME, 'router'),
  prompts: path.join(HOME, 'prompts'),
};

/** Root of the installed package (contains dist/, ui/, skill/). */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_PATH = path.join(PKG_ROOT, 'dist', 'cli.js');
export const UI_DIR = path.join(PKG_ROOT, 'ui');
export const SKILL_DIR = path.join(PKG_ROOT, 'skill', 'superagent');

export function ensureDirs(): void {
  for (const dir of [paths.home, paths.logs, paths.run, paths.worktrees, paths.scratch, paths.repos, paths.router, paths.prompts]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function pkgVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
