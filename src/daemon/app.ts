import { AGENT_IDS, applyConfigPatch, ensureConfigFile, ensureToken, publicConfig, saveConfig, type AgentId, type Config, type RepoConfig } from '../core/config.js';
import { ensureDirs, paths, pkgVersion } from '../core/paths.js';
import { LOCAL_THREAD_KEY, Store } from '../core/store.js';
import { emit, log, ref, snippet } from '../core/util.js';
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
    await this.refreshAgents();
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
    this.workers.schedule();
    return next;
  }

  /** A message typed in the desktop app or CLI. */
  sendLocal(text: string) {
    const local = this.store.localThread();
    const message = this.store.addMessage(local.id, 'user', text);
    emit('message', message);
    const trigger = this.ingest.ingest({ source: 'local', kind: 'message', threadKey: LOCAL_THREAD_KEY, author: 'you', text });
    return { message, trigger };
  }

  /** Start a worker directly (CLI `run`, desktop "New task", skill), skipping the router's decision. */
  dispatchDirect(input: { title?: string; task: string; agent?: string; repo?: string }) {
    const repo = this.findRepo(input.repo);
    if (input.repo && !repo) throw new Error(`Unknown repo "${input.repo}". Add it first (superagent repo add …).`);
    const requested = (input.agent ?? '').toLowerCase() as AgentId;
    if (input.agent && !this.availableAgents().includes(requested)) {
      throw new Error(`Agent "${input.agent}" is not available. Available: ${this.availableAgents().join(', ') || 'none'}`);
    }
    const w = this.workers.create({
      title: input.title?.trim() || snippet(input.task, 60),
      task: input.task,
      agent: this.pickAgent(input.agent ? requested : undefined, repo?.agent),
      repo: repo?.name ?? null,
      replyThreadId: this.store.localThread().id,
      createdBy: 'user',
    });
    this.ingest.ingest({ source: 'user', kind: 'direct_task', text: `${ref.W(w.id)} "${w.title}" (${w.agent}): ${w.task}` });
    return w;
  }

  state() {
    const workers = this.store.listWorkers(false, 500);
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
