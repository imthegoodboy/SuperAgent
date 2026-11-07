import { clear, connect, h, icon, listen } from './lib.js';
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

function renderFoot() {
  const r = state.router;
  const running = activeWorkers().filter((w) => w.status === 'running').length;
  const waiting = activeWorkers().filter((w) => w.status === 'waiting').length;
  clear(
    foot,
    h('div', { class: `conn ${state.connected ? 'on' : 'off'}` }, h('span', { class: 'dot' }), state.connected ? 'Running on this computer' : 'Reconnecting…'),
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
  const key = VIEWS[name] ? name : 'chat';
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.view === key);
  if (current?.key === key && current.update) {
    current.update(arg);
    return;
  }
  current?.unmount?.();
  clear(view);
  const api = VIEWS[key].mount(view, arg) ?? {};
  current = { key, ...api };
  document.title = `${VIEWS[key].label} · SuperAgent`;
}

let wasConnected = false;
listen((type) => {
  if (type === 'hello') {
    // First connect, or the daemon restarted: reload everything and redraw.
    loadAll()
      .then(() => {
        renderFoot();
        if (wasConnected || !current) {
          current?.unmount?.();
          current = null;
          route();
        }
        wasConnected = true;
      })
      .catch(console.error);
    return;
  }
  if (['router', 'worker', 'disconnected', 'agents'].includes(type)) renderFoot();
});

window.addEventListener('hashchange', route);
renderFoot();
clear(view, h('div', { class: 'empty center' }, h('p', { class: 'muted' }, 'Connecting to SuperAgent…')));
connect();
