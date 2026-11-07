import { api, clear, clock, dur, h, icon, listen, toast } from '../lib.js';

const SOURCE_ICON = { local: 'you', user: 'you', github: 'github', telegram: 'telegram', worker: 'worker', watchdog: 'shield' };

function decision(t) {
  if (t.decision === 'dropped') return h('span', { class: 'chip-s muted-chip', title: 'Filtered in code before any model saw it' }, `Filtered: ${t.reason}`);
  if (t.decision === 'pass_through') return h('span', { class: 'chip-s accent-chip', title: 'Thread has a subscribed worker' }, `Sent to ${String(t.routed_to).replaceAll('#', '')}`);
  if (t.decision === 'fyi') return h('span', { class: 'chip-s muted-chip' }, 'Recorded');
  if (t.status === 'pending') return h('span', { class: 'chip-s warn-chip' }, 'Waiting for router');
  if (t.status === 'ignored') return h('span', { class: 'chip-s muted-chip', title: t.reason ?? '' }, `Ignored: ${t.reason ?? 'not actionable'}`);
  return h('span', { class: 'chip-s ok-chip' }, t.decision === 'candidate' ? 'Considered by router' : 'Handled by router');
}

function who(t, threads) {
  const th = t.thread_id ? threads[t.thread_id] : null;
  if (t.source === 'local') return 'You, in chat';
  if (t.source === 'worker') return 'Worker report';
  if (t.source === 'watchdog') return 'Watchdog';
  if (t.source === 'user') return 'You started a task';
  const kind = t.kind.replace(/_/g, ' ');
  return `${t.author ? '@' + t.author : t.source} ${kind}${th?.title ? ` on ${th.title}` : ''}`;
}

export default function activityView(el) {
  const tabs = ['Events', 'Router', 'Watchdog'];
  let tab = 'Events';
  const body = h('div', { class: 'activity-body' });
  const seg = h('div', { class: 'seg', role: 'tablist' });
  const intro = h('p', { class: 'muted intro' });
  const INTRO = {
    Events: 'Everything that reached SuperAgent, and what happened to it. Most noise is filtered in code; the rest goes to the router or straight to the worker that owns the thread.',
    Router: 'Each turn of the router: how many events it handled at once, how long it took, and what it decided.',
    Watchdog: 'The watchdog runs outside the main process. It restarts crashed or stuck parts and checks that workers are making progress.',
  };
  el.append(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'Activity'), seg), intro, body));

  let threads = {};
  const rows = new Map();

  function eventRow(t) {
    return h(
      'div',
      { class: `ev-row src-${t.source}` },
      h('span', { class: 'ev-icon' }, icon(SOURCE_ICON[t.source] ?? 'activity', 16)),
      h(
        'div',
        { class: 'ev-main' },
        h('div', { class: 'ev-top' }, h('span', { class: 'ev-who' }, who(t, threads)), decision(t), h('span', { class: 'when' }, clock(t.created_at))),
        h('div', { class: 'ev-text' }, t.text),
        t.url ? h('a', { class: 'ev-link', href: t.url, target: '_blank', rel: 'noreferrer' }, 'Open on ', t.source === 'github' ? 'GitHub' : t.source) : null,
      ),
    );
  }

  async function showEvents() {
    const data = await api('GET', '/api/triggers?limit=200');
    threads = data.threads;
    rows.clear();
    if (!data.triggers.length) return clear(body, h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Nothing yet. Messages, GitHub events and worker reports will show up here.')));
    const list = h('div', { class: 'ev-list' });
    for (const t of data.triggers) {
      const r = eventRow(t);
      rows.set(t.id, r);
      list.append(r);
    }
    clear(body, list);
  }

  function actionsSummary(turn) {
    let acts = [];
    try {
      acts = JSON.parse(turn.actions || '[]');
    } catch {
      /* none */
    }
    if (!acts.length) return [h('span', { class: 'chip-s muted-chip' }, turn.error ? 'Error' : 'No action')];
    const counts = {};
    for (const a of acts) counts[a.type] = (counts[a.type] ?? 0) + 1;
    return Object.entries(counts).map(([k, n]) => h('span', { class: `chip-s act-${k}` }, `${k.replace('_', ' ')}${n > 1 ? ` ×${n}` : ''}`));
  }

  async function showRouter() {
    const data = await api('GET', '/api/router');
    const s = data.status;
    const reset = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          try {
            await api('POST', '/api/router/reset');
            toast('Router session restarted');
          } catch (e) {
            toast(e.message, 'bad');
          }
        },
      },
      icon('retry', 16),
      'Start a fresh session',
    );
    clear(
      body,
      h(
        'div',
        { class: 'router-status' },
        h('div', {}, h('strong', {}, `${s.agent}${s.model ? ' / ' + s.model : ''}`), h('span', { class: 'muted' }, ` ${s.turns} turns in this session`)),
        s.lastError ? h('div', { class: 'callout bad' }, h('strong', {}, 'Last error'), h('pre', {}, s.lastError)) : null,
        reset,
      ),
      data.turns.length
        ? h(
            'div',
            { class: 'turns' },
            data.turns.map((t) =>
              h(
                'details',
                { class: `turn${t.error ? ' turn-err' : ''}` },
                h(
                  'summary',
                  {},
                  h('span', { class: 'when' }, clock(t.started_at)),
                  h('span', {}, t.hop ? 'Recall' : `${t.batch_size} event${t.batch_size === 1 ? '' : 's'}`),
                  h('span', { class: 'muted' }, t.ended_at ? dur(t.ended_at - t.started_at) : 'running'),
                  h('span', { class: 'turn-acts' }, actionsSummary(t)),
                ),
                h('div', { class: 'turn-io' }, h('h3', {}, 'Input'), h('pre', {}, t.input), h('h3', {}, 'Output'), h('pre', {}, t.error ? `${t.error}\n\n${t.output ?? ''}` : t.output ?? '')),
              ),
            ),
          )
        : h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'The router has not run yet.')),
    );
  }

  async function showWatchdog() {
    const events = await api('GET', '/api/watchdog');
    if (!events.length) return clear(body, h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'All quiet. The watchdog has not had to step in.')));
    clear(
      body,
      h(
        'div',
        { class: 'ev-list' },
        events.map((e) =>
          h(
            'div',
            { class: `ev-row wd-${e.level}` },
            h('span', { class: 'ev-icon' }, icon('shield', 16)),
            h('div', { class: 'ev-main' }, h('div', { class: 'ev-top' }, h('span', { class: 'ev-who' }, e.text), h('span', { class: 'when' }, clock(e.ts)))),
          ),
        ),
      ),
    );
  }

  const LOADERS = { Events: showEvents, Router: showRouter, Watchdog: showWatchdog };
  let pending = null;

  function load(forTab) {
    if (forTab !== tab) return;
    LOADERS[forTab]().catch((e) => {
      if (forTab === tab) clear(body, h('div', { class: 'empty' }, h('p', {}, e.message)));
    });
  }

  // Debounced refresh that never paints into a tab the user has since left.
  function refreshSoon(forTab, ms) {
    clearTimeout(pending);
    pending = setTimeout(() => load(forTab), ms);
  }

  function show() {
    clearTimeout(pending);
    for (const b of seg.children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    intro.textContent = INTRO[tab];
    load(tab);
  }

  for (const t of tabs) seg.append(h('button', { type: 'button', role: 'tab', 'data-tab': t, onclick: () => ((tab = t), show()) }, t));
  show();

  const off = listen((type, data) => {
    if (tab === 'Events' && type === 'trigger' && data) {
      const existing = rows.get(data.id);
      if (data.thread_id && !threads[data.thread_id]) return refreshSoon('Events', 300);
      const r = eventRow(data);
      rows.set(data.id, r);
      const list = body.querySelector('.ev-list');
      if (existing) existing.replaceWith(r);
      else if (list) {
        list.prepend(r);
        while (list.children.length > 200) {
          const last = list.lastElementChild;
          for (const [id, el] of rows) if (el === last) rows.delete(id);
          last.remove();
        }
      } else refreshSoon('Events', 0);
    }
    if (tab === 'Router' && (type === 'router_turn' || type === 'router')) refreshSoon('Router', 400);
    if (tab === 'Watchdog' && type === 'watchdog') refreshSoon('Watchdog', 0);
  });
  return {
    unmount: () => {
      clearTimeout(pending);
      off();
    },
  };
}
