import { AGENT_IDS, applyConfigPatch, ensureConfigFile, ensureToken, publicConfig, saveConfig, type AgentId, type Config, type RepoConfig } from '../core/config.js';
import { ensureDirs, paths, pkgVersion } from '../core/paths.js';
import { Store } from '../core/store.js';
import { emit, log } from '../core/util.js';
import { detectAgents, type AgentInfo } from '../agents/runner.js';
import { GitHubSource } from '../channels/github.js';
import { Outbound } from '../channels/outbound.js';
import { TelegramSource } from '../channels/telegram.js';
import { Router } from '../router/router.js';
import { Ingest } from '../triggers/ingest.js';
import { WorkerManager } from '../workers/manager.js';

export class App {
  readonly store: Store;
  readonly token: string;
  readonly startedAt = Date.now();
  config: Config;
  agents: AgentInfo[] = [];
  /** Settles once the first agent detection is done (the server answers before that). */
  agentsReady: Promise<unknown> = Promise.resolve();
  readonly ingest: Ingest;
  readonly router: Router;
  readonly workers: WorkerManager;
  readonly outbound: Outbound;
  readonly github: GitHubSource;
  readonly telegram: TelegramSource;
  onShutdown: (() => void) | null = null;

  constructor() {
    ensureDirs();
    this.config = ensureConfigFile();
    this.token = ensureToken();
    this.store = new Store(paths.db);
    this.ingest = new Ingest(this);
    this.router = new Router(this);
    this.workers = new WorkerManager(this);
    this.outbound = new Outbound(this);
    this.github = new GitHubSource(this);
    this.telegram = new TelegramSource(this);
  }

  async init(): Promise<void> {
    this.agentsReady = this.refreshAgents().catch(() => {});
    await this.agentsReady;
    this.workers.recover();
    this.router.kick();
    this.github.start();
    this.telegram.start();
  }

  async refreshAgents(): Promise<AgentInfo[]> {
    this.agents = await detectAgents();
    emit('agents', this.agents);
    log('agents:', this.agents.map((a) => `${a.id}=${a.installed ? a.version : 'missing'}`).join(' '));
    return this.agents;
  }

  /** Installed and enabled agents, in preference order. */
  availableAgents(): AgentId[] {
    return this.agents
      .filter((a) => a.installed && (a.id === 'mock' || this.config.agents[a.id as AgentId]?.enabled !== false))
      .map((a) => a.id as AgentId);
  }

  pickAgent(requested?: AgentId, repoPreferred?: AgentId): AgentId {
    const avail = this.availableAgents();
    const order = [requested, repoPreferred, this.config.workers.defaultAgent, ...AGENT_IDS].filter(Boolean) as AgentId[];
    return order.find((a) => avail.includes(a)) ?? requested ?? this.config.workers.defaultAgent;
  }

  findRepo(nameOrSlug?: string | null): RepoConfig | undefined {
    if (!nameOrSlug) return undefined;
    const q = String(nameOrSlug).trim().toLowerCase();
    return this.config.repos.find(
      (r) => r.name.toLowerCase() === q || r.slug?.toLowerCase() === q || r.slug?.toLowerCase().endsWith('/' + q),
    );
  }

  updateConfig(patch: unknown): Config {
    const prev = this.config;
    const next = applyConfigPatch(prev, patch);
    saveConfig(next);
    this.config = next;
    emit('config', publicConfig(next));
    if (JSON.stringify(prev.github) !== JSON.stringify(next.github) || JSON.stringify(prev.repos) !== JSON.stringify(next.repos)) this.github.reload();
    if (JSON.stringify(prev.telegram) !== JSON.stringify(next.telegram)) this.telegram.reload();
    if (prev.router.leaseMinutes !== next.router.leaseMinutes) this.router.configChanged();
    this.workers.schedule();
    return next;
  }

  state() {
    const workers = this.store.listWorkers('current', 500);
    const counts: Record<string, number> = {};
    for (const w of workers) counts[w.status] = (counts[w.status] ?? 0) + 1;
    return {
      version: pkgVersion(),
      pid: process.pid,
      startedAt: this.startedAt,
      home: paths.home,
      router: this.router.status(),
      workers: { counts, running: this.workers.runningCount, max: this.config.workers.maxConcurrent },
      agents: this.agents,
      github: this.github.status(),
      telegram: this.telegram.status(),
      localThread: this.store.localThread().id,
    };
  }

  shutdown(): void {
    this.github.stop();
    this.telegram.stop();
    this.workers.shutdown();
    try {
      this.store.close();
    } catch {
      /* already closed */
    }
  }
}
