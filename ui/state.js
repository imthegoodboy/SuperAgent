import { api, listen, pushTick, refreshTracks, seedTicks } from './lib.js';

/** Shared client state, kept current by the daemon's live event stream. */
export const state = {
  connected: false,
  server: null,
  router: null,
  agents: [],
  config: null,
  workers: new Map(),
};

export async function loadAll() {
  const [workers, config, agents] = await Promise.all([api('GET', '/api/workers'), api('GET', '/api/config'), api('GET', '/api/agents')]);
  state.workers = new Map(workers.map((w) => [w.id, w]));
  for (const w of workers) if (w.ticks) seedTicks(w.id, w.ticks);
  state.config = config;
  state.agents = agents;
}

export function activeWorkers() {
  return [...state.workers.values()]
    .filter((w) => !w.archived && ['queued', 'running', 'waiting'].includes(w.status))
    .sort((a, b) => a.id - b.id);
}

export function availableAgents() {
  return state.agents.filter((a) => a.installed && (a.id === 'mock' || state.config?.agents?.[a.id]?.enabled !== false));
}

listen((type, data) => {
  switch (type) {
    case 'hello':
      state.connected = true;
      state.server = data;
      state.router = data.router;
      state.agents = data.agents;
      break;
    case 'disconnected':
      state.connected = false;
      break;
    case 'router':
      state.router = data;
      break;
    case 'agents':
      state.agents = data;
      break;
    case 'config':
      state.config = data;
      break;
    case 'worker':
      if (data) state.workers.set(data.id, data);
      break;
    case 'worker_log':
      if (data) {
        pushTick(data.worker_id, data.kind);
        refreshTracks(data.worker_id, data.kind);
      }
      break;
  }
});
