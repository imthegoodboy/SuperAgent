import { api, clear, connect, h, icon, listen, token } from './lib.js';
import { activeWorkers, loadAll, state } from './state.js';
import chatView from './views/chat.js';
import tasksView from './views/tasks.js';
import activityView from './views/activity.js';
import settingsView from './views/settings.js';

const VIEWS = {
  chat: { label: 'Chat', icon: 'chat', mount: chatView },
  tasks: { label: 'Tasks', icon: 'tasks', mount: tasksView },
  activity: { label: 'Activity', icon: 'activity', mount: activityView },
  settings: { label: 'Settings', icon: 'settings', mount: settingsView },
};

const root = document.getElementById('app');
const view = h('main', { id: 'view' });
const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
const foot = h('div', { class: 'side-foot' });
const badges = {};

for (const [key, v] of Object.entries(VIEWS)) {
  badges[key] = h('span', { class: 'nav-badge', hidden: true });
  nav.append(h('a', { href: `#/${key}`, 'data-view': key }, icon(v.icon), h('span', {}, v.label), badges[key]));
}

clear(
  root,
  h(
    'aside',
    { class: 'side' },
    h('a', { class: 'brand', href: '#/chat' }, h('img', { src: '/icon.svg', alt: '', width: 26, height: 26 }), 'SuperAgent'),
    nav,
    foot,
  ),
  view,
);

let isLocked = false;

function renderFoot() {
  const r = state.router;
  const running = activeWorkers().filter((w) => w.status === 'running').length;
  const waiting = activeWorkers().filter((w) => w.status === 'waiting').length;
  const connText = isLocked ? 'Not connected' : state.connected ? 'Running locally' : 'Reconnecting…';
  clear(
    foot,
    h('div', { class: `conn ${state.connected ? 'on' : 'off'}` }, h('span', { class: 'dot' }), connText),
    state.connected && r
      ? h('div', { class: 'foot-line' }, icon('router', 14), r.busy ? 'Router is thinking' : r.lastError ? 'Router hit an error' : 'Router is idle')
      : null,
    state.connected ? h('div', { class: 'foot-line' }, icon('worker', 14), running ? `${running} working` : 'No workers running') : null,
  );
  badges.tasks.hidden = !waiting;
  badges.tasks.textContent = waiting ? String(waiting) : '';
  badges.tasks.title = waiting ? `${waiting} task${waiting > 1 ? 's' : ''} need your input` : '';
}

let current = null;

function route() {
  const [, name = 'chat', arg] = location.hash.replace(/^#/, '').split('/');
  const key = Object.hasOwn(VIEWS, name) ? name : 'chat';
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.view === key);
  if (current?.key === key && current.update) {
    current.update(arg);
    return;
  }
  current?.unmount?.();
  clear(view);
  const viewApi = VIEWS[key].mount(view, arg) ?? {};
  current = { key, ...viewApi };
  document.title = `${VIEWS[key].label} · SuperAgent`;
}

function message(title, ...body) {
  current?.unmount?.();
  current = null;
  clear(view, h('div', { class: 'empty center' }, h('h1', {}, title), ...body.map((b) => h('p', { class: 'muted' }, b))));
}

function locked() {
  isLocked = true;
  renderFoot();
  message('Open SuperAgent from the app', [
    'This page needs your local access key. Open SuperAgent from the desktop app, or run ',
    h('code', {}, 'superagent open'),
    ' in a terminal.',
  ]);
}

let loaded = false;
let daemonId = null;
let es = null;

async function load(server) {
  try {
    await loadAll();
  } catch (e) {
    if (e.status === 401) {
      es?.close();
      return locked();
    }
    message('Could not load SuperAgent', e.message, 'Retrying…');
    setTimeout(() => load(server), 3000);
    return;
  }
  renderFoot();
  // Redraw on first load and when the daemon restarted; a plain reconnect keeps the page (and drafts).
  const id = `${server?.pid}:${server?.startedAt}`;
  if (!loaded || id !== daemonId) {
    loaded = true;
    daemonId = id;
    current?.unmount?.();
    current = null;
    route();
  }
}

listen((type, data) => {
  if (type === 'hello') return void load(data);
  if (type === 'disconnected' && !loaded) {
    // Never connected: tell a wrong key apart from a daemon that is down.
    api('GET', '/api/state').catch((e) => {
      if (e.status === 401) {
        es?.close();
        locked();
      }
    });
  }
  if (['router', 'worker', 'disconnected', 'agents'].includes(type)) renderFoot();
});

window.addEventListener('hashchange', () => loaded && route());
renderFoot();
if (!token) locked();
else {
  message('Connecting to SuperAgent…');
  es = connect();
}
