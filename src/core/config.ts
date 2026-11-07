import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from './paths.js';

export const AGENT_IDS = ['claude', 'codex', 'opencode', 'cursor'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** fast-path policy for one source: respond to @mentions only, treat everything as a candidate, or ignore. */
export type SourceMode = 'mentions' | 'all' | 'off';

export interface RepoConfig {
  /** Short name used in chat and by the router ("SuperAgent"). */
  name: string;
  /** GitHub owner/repo; enables GitHub triggers and PRs. */
  slug?: string;
  /** Local checkout. If empty and slug is set, SuperAgent clones into ~/.superagent/repos. */
  path?: string;
  mode: SourceMode;
  /** Which CI results reach the agent. */
  ci: 'failures' | 'all' | 'off';
  /** GitHub logins allowed to trigger the agent. Empty = anyone who can comment. */
  allowUsers: string[];
  /** Preferred worker agent for this repo. */
  agent?: AgentId;
}

export interface AgentSettings {
  enabled: boolean;
  /** Model passed to the CLI (empty = the CLI's own default). */
  model: string;
}

export interface TelegramChat {
  id: string;
  title?: string;
  mode: SourceMode;
}

export interface Config {
  port: number;
  /** Keyword that counts as an explicit mention in GitHub/Telegram. */
  mention: string;
  router: { agent: AgentId; model: string; maxBatch: number; rotateAfterTurns: number };
  workers: {
    defaultAgent: AgentId;
    maxConcurrent: number;
    /** full = agents run without approval prompts; safe = agents use their own sandbox/approval modes. */
    autonomy: 'full' | 'safe';
    allowDraftPRs: boolean;
    stallMinutes: number;
    maxRunMinutes: number;
  };
  agents: Record<AgentId, AgentSettings>;
  repos: RepoConfig[];
  github: { enabled: boolean; pollSeconds: number };
  telegram: { enabled: boolean; botToken: string; chats: TelegramChat[]; allowUsers: string[] };
  /** Natural-language policies for the router's semantic (slow-path) filter. */
  policies: string;
  watchdog: { enabled: boolean; llmChecks: boolean; checkMinutes: number };
}

export const DEFAULT_POLICIES = `- In monitored GitHub repos, if someone reports a clear, reproducible bug without mentioning me, silently try to reproduce and fix it (dispatch with silent=true). Only speak up if a fix is ready.
- Ignore small talk, thanks, and messages that need no action.`;

export function defaultConfig(): Config {
  return {
    port: 7878,
    // "@superagent" would ping a real GitHub user of that name; a slash command doesn't.
    mention: '/superagent',
    router: { agent: 'claude', model: 'haiku', maxBatch: 20, rotateAfterTurns: 60 },
    workers: {
      defaultAgent: 'claude',
      maxConcurrent: 3,
      autonomy: 'full',
      allowDraftPRs: true,
      stallMinutes: 20,
      maxRunMinutes: 120,
    },
    agents: {
      claude: { enabled: true, model: '' },
      codex: { enabled: true, model: '' },
      opencode: { enabled: true, model: '' },
      cursor: { enabled: true, model: '' },
    },
    repos: [],
    github: { enabled: true, pollSeconds: 45 },
    telegram: { enabled: false, botToken: '', chats: [], allowUsers: [] },
    policies: DEFAULT_POLICIES,
    watchdog: { enabled: true, llmChecks: true, checkMinutes: 20 },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge where arrays and scalars from `patch` replace those in `base`. */
export function merge<T>(base: T, patch: unknown): T {
  if (!isObject(patch) || !isObject(base)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

export function normalizeRepo(r: Partial<RepoConfig>): RepoConfig {
  const name = (r.name || r.slug?.split('/')[1] || r.path?.split(/[\\/]/).filter(Boolean).pop() || 'repo').trim();
  return {
    name,
    slug: r.slug?.trim() || undefined,
    path: r.path?.trim() || undefined,
    mode: r.mode ?? 'mentions',
    ci: r.ci ?? 'failures',
    allowUsers: (r.allowUsers ?? []).map((u) => u.replace(/^@/, '').trim()).filter(Boolean),
    agent: r.agent,
  };
}

export function loadConfig(): Config {
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    /* first run */
  }
  const cfg = merge(defaultConfig(), raw);
  cfg.repos = (cfg.repos ?? []).map(normalizeRepo);
  return cfg;
}

export function saveConfig(cfg: Config): void {
  const tmp = paths.config + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, paths.config);
}

export function ensureConfigFile(): Config {
  const cfg = loadConfig();
  if (!fs.existsSync(paths.config)) saveConfig(cfg);
  return cfg;
}

/** Local API token. Every API call needs it, so random web pages can't drive your agents. */
export function ensureToken(): string {
  try {
    const t = fs.readFileSync(paths.token, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* create below */
  }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(paths.token, t, { mode: 0o600 });
  return t;
}

/** Config as shown to the UI: secrets masked. */
export function publicConfig(cfg: Config): Config {
  const copy = structuredClone(cfg);
  if (copy.telegram.botToken) copy.telegram.botToken = '••••' + copy.telegram.botToken.slice(-4);
  return copy;
}

/** Apply a patch coming from the UI. A masked token means "unchanged". */
export function applyConfigPatch(cfg: Config, patch: unknown): Config {
  const next = merge(cfg, patch);
  if (next.telegram.botToken.startsWith('••••')) next.telegram.botToken = cfg.telegram.botToken;
  next.repos = (next.repos ?? []).map(normalizeRepo);
  next.workers.maxConcurrent = Math.max(1, Math.min(16, Math.round(Number(next.workers.maxConcurrent) || 3)));
  next.github.pollSeconds = Math.max(15, Math.round(Number(next.github.pollSeconds) || 45));
  return next;
}
