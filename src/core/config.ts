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
  router: {
    /** Agent CLI that runs the background router (used whenever no agent session is attached). */
    agent: AgentId;
    model: string;
    maxBatch: number;
    rotateAfterTurns: number;
    /** An attached agent session stays the router this long after its last router command. */
    leaseMinutes: number;
  };
  workers: {
    defaultAgent: AgentId;
    maxConcurrent: number;
    /** full = agents run without approval prompts; safe = agents use their own sandbox/approval modes. */
    autonomy: 'full' | 'safe';
    allowDraftPRs: boolean;
    stallMinutes: number;
    maxRunMinutes: number;
    /** Don't start another worker while the computer has less free memory than this (one always runs). */
    minFreeMemoryMB: number;
  };
  agents: Record<AgentId, AgentSettings>;
  repos: RepoConfig[];
  /** reviewBots: code-review bots whose comments on a worker's own PR are passed to that worker. */
  github: { enabled: boolean; pollSeconds: number; reviewBots: string[] };
  telegram: { enabled: boolean; botToken: string; chats: TelegramChat[]; allowUsers: string[] };
  /** Natural-language policies for the router's semantic (slow-path) filter. */
  policies: string;
  watchdog: { enabled: boolean; llmChecks: boolean; checkMinutes: number };
}

export const DEFAULT_POLICIES = `- In monitored GitHub repos, if someone reports a clear, reproducible bug without mentioning me, silently try to reproduce and fix it (a silent dispatch). Only speak up if a fix is ready.
- Ignore small talk, thanks, and messages that need no action.`;

export function defaultConfig(): Config {
  return {
    port: 7878,
    // "@superagent" would ping a real GitHub user of that name; a slash command doesn't.
    mention: '/superagent',
    router: { agent: 'claude', model: 'haiku', maxBatch: 20, rotateAfterTurns: 60, leaseMinutes: 15 },
    workers: {
      defaultAgent: 'claude',
      maxConcurrent: 3,
      autonomy: 'full',
      allowDraftPRs: true,
      stallMinutes: 20,
      maxRunMinutes: 120,
      minFreeMemoryMB: 400,
    },
    agents: {
      claude: { enabled: true, model: '' },
      codex: { enabled: true, model: '' },
      opencode: { enabled: true, model: '' },
      cursor: { enabled: true, model: '' },
    },
    repos: [],
    github: {
      enabled: true,
      pollSeconds: 45,
      reviewBots: ['chatgpt-codex-connector', 'coderabbitai', 'copilot-pull-request-reviewer', 'gemini-code-assist', 'devin-ai-integration', 'cubic-dev-ai', 'codeant-ai'],
    },
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
  // A hand-edited or older file with a bad number must not stall the service (maxConcurrent 0, …).
  const defaults = defaultConfig();
  for (const [key, rule] of Object.entries(RULES)) {
    if (rule.kind !== 'number' || key.includes('*') || !check(key, rule, getKey(cfg, key))) continue;
    setKey(cfg, key, getKey(defaults, key));
  }
  return cfg;
}

function getKey(obj: unknown, key: string): unknown {
  return key.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

function setKey(obj: any, key: string, value: unknown): void {
  const parts = key.split('.');
  const last = parts.pop()!;
  const parent = parts.reduce<any>((o, k) => (o[k] ??= {}), obj);
  parent[last] = value;
}

export function saveConfig(cfg: Config): void {
  // The CLI can change settings before the daemon has ever created the data folder.
  fs.mkdirSync(paths.home, { recursive: true });
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

type Rule =
  | { kind: 'number'; min: number; max: number; int?: boolean }
  | { kind: 'boolean' }
  | { kind: 'string'; nonEmpty?: boolean }
  | { kind: 'enum'; values: readonly string[] | (() => readonly string[]) }
  | { kind: 'strings' }
  | { kind: 'repos' }
  | { kind: 'chats' };

/** The mock agent exists only for tests and demos (SUPERAGENT_MOCK=1). */
const agentChoices = (): readonly string[] => (process.env.SUPERAGENT_MOCK === '1' ? [...AGENT_IDS, 'mock'] : AGENT_IDS);

/** Every setting a person or agent may change, with what it accepts. `*` matches one agent id. */
const RULES: Record<string, Rule> = {
  port: { kind: 'number', min: 1024, max: 65535, int: true },
  mention: { kind: 'string', nonEmpty: true },
  policies: { kind: 'string' },
  'router.agent': { kind: 'enum', values: agentChoices },
  'router.model': { kind: 'string' },
  'router.maxBatch': { kind: 'number', min: 1, max: 100, int: true },
  'router.rotateAfterTurns': { kind: 'number', min: 1, max: 10_000, int: true },
  'router.leaseMinutes': { kind: 'number', min: 0.01, max: 24 * 60 },
  'workers.defaultAgent': { kind: 'enum', values: agentChoices },
  'workers.maxConcurrent': { kind: 'number', min: 1, max: 16, int: true },
  'workers.autonomy': { kind: 'enum', values: ['full', 'safe'] },
  'workers.allowDraftPRs': { kind: 'boolean' },
  'workers.stallMinutes': { kind: 'number', min: 1, max: 24 * 60 },
  'workers.maxRunMinutes': { kind: 'number', min: 1, max: 7 * 24 * 60 },
  'workers.minFreeMemoryMB': { kind: 'number', min: 0, max: 1_000_000, int: true },
  'agents.*.enabled': { kind: 'boolean' },
  'agents.*.model': { kind: 'string' },
  repos: { kind: 'repos' },
  'github.enabled': { kind: 'boolean' },
  'github.pollSeconds': { kind: 'number', min: 15, max: 24 * 3600, int: true },
  'github.reviewBots': { kind: 'strings' },
  'telegram.enabled': { kind: 'boolean' },
  'telegram.botToken': { kind: 'string' },
  'telegram.chats': { kind: 'chats' },
  'telegram.allowUsers': { kind: 'strings' },
  'watchdog.enabled': { kind: 'boolean' },
  'watchdog.llmChecks': { kind: 'boolean' },
  'watchdog.checkMinutes': { kind: 'number', min: 1, max: 24 * 60 },
};

function ruleFor(key: string): Rule | undefined {
  if (RULES[key]) return RULES[key];
  const m = key.match(/^agents\.([^.]+)\.(\w+)$/);
  return m && (AGENT_IDS as readonly string[]).includes(m[1]) ? RULES[`agents.*.${m[2]}`] : undefined;
}

/** Setting names in a patch that don't exist (typos like "workers.maxConcurent"). */
export function unknownKeys(patch: unknown, prefix = ''): string[] {
  if (!isObject(patch)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (ruleFor(key)) continue;
    const isBranch = Object.keys(RULES).some((r) => r.startsWith(`${key}.`)) || /^agents(\.[^.]+)?$/.test(key);
    if (isBranch && isObject(v)) out.push(...unknownKeys(v, key));
    else out.push(key);
  }
  return out;
}

function check(key: string, rule: Rule, v: unknown): string | null {
  switch (rule.kind) {
    case 'number': {
      const n = typeof v === 'number' ? v : NaN;
      if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.int && !Number.isInteger(n))) {
        return `${key} must be ${rule.int ? 'a whole number' : 'a number'} from ${rule.min} to ${rule.max} (got ${JSON.stringify(v)})`;
      }
      return null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? null : `${key} must be true or false (got ${JSON.stringify(v)})`;
    case 'string':
      return typeof v !== 'string' ? `${key} must be text` : rule.nonEmpty && !v.trim() ? `${key} can't be empty` : null;
    case 'enum': {
      const values = typeof rule.values === 'function' ? rule.values() : rule.values;
      return values.includes(v as string) ? null : `${key} must be one of ${values.join(', ')} (got ${JSON.stringify(v)})`;
    }
    case 'strings':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : `${key} must be a list of names, e.g. '["alice","bob"]'`;
    case 'repos': {
      const str = (x: unknown) => x === undefined || typeof x === 'string';
      const okRepo = (r: any) => isObject(r) && str(r.name) && str(r.slug) && str(r.path) && (!!r.slug || !!r.path) && (r.allowUsers === undefined || Array.isArray(r.allowUsers));
      return Array.isArray(v) && v.every(okRepo) ? null : `${key} must be a list of repositories, each with a "slug" (owner/repo) or a "path"`;
    }
    case 'chats':
      return Array.isArray(v) && v.every((c) => isObject(c) && typeof c.id === 'string')
        ? null
        : `${key} must be a list like '[{"id":"-100123","mode":"mentions"}]'`;
  }
}

/** Problems with a whole config, one message per bad setting. */
export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];
  const get = (key: string) => key.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), cfg);
  for (const [key, rule] of Object.entries(RULES)) {
    if (key.includes('*')) {
      for (const id of AGENT_IDS) {
        const k = key.replace('*', id);
        const v = get(k);
        if (v !== undefined) {
          const e = check(k, rule, v);
          if (e) errors.push(e);
        }
      }
      continue;
    }
    const e = check(key, rule, get(key));
    if (e) errors.push(e);
  }
  return errors;
}

/** Apply a change from the CLI or an agent. Unknown settings and bad values are refused, not guessed. */
export function applyConfigPatch(cfg: Config, patch: unknown): Config {
  const unknown = unknownKeys(patch);
  if (unknown.length) throw new Error(`Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. See \`superagent config\` for all settings.`);
  const next = merge(cfg, patch);
  if (next.telegram.botToken.startsWith('••••')) next.telegram.botToken = cfg.telegram.botToken;
  const errors = validateConfig(next); // before normalizing: a malformed repo entry must be refused, not crash
  if (errors.length) throw new Error(errors.join('; '));
  next.repos = next.repos.map(normalizeRepo);
  return next;
}
