import { agentDot, api, clear, clock, h, icon, listen, md, toast, track } from '../lib.js';
import { activeWorkers, state } from '../state.js';

const LANE_STATUS = {
  queued: 'Waiting for a free slot',
  running: 'Working',
  waiting: 'Needs your input',
};

export default function chatView(el) {
  const list = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'chat-scroll' }, list);
  const thinking = h('div', { class: 'thinking', hidden: true }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), 'Thinking');
  const input = h('textarea', {
    rows: 1,
    placeholder: 'Ask SuperAgent to build, fix or check something',
    'aria-label': 'Message SuperAgent',
  });
  const send = h('button', { class: 'send', type: 'submit', title: 'Send (Enter)', 'aria-label': 'Send' }, icon('send', 18));
  const composer = h('form', { class: 'composer' }, input, send);
  const lanes = h('aside', { class: 'lanes', 'aria-label': 'Running now' });
  const wrap = h('div', { class: 'chat' }, h('section', { class: 'chat-main' }, scroller, h('div', { class: 'composer-wrap' }, thinking, composer)), lanes);
  el.append(wrap);

  const seen = new Set();
  let empty = null;

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const toBottom = () => (scroller.scrollTop = scroller.scrollHeight);

  function emptyState() {
    const repos = state.config?.repos ?? [];
    const repo = repos[0]?.name;
    const examples = repo
      ? [`Find and fix the failing tests in ${repo}`, `Review the open pull requests in ${repo}`, `Use Codex to add a dark mode to ${repo}`]
      : ['Write a script that renames my photos by date', 'Explain what the code in my current project does', 'Use Codex to build a small todo app'];
    return h(
      'div',
      { class: 'empty-chat' },
      h('img', { src: '/icon.svg', alt: '', width: 44, height: 44 }),
      h('h1', {}, 'What should we work on?'),
      h(
        'p',
        { class: 'muted' },
        'Ask in plain words. SuperAgent hands the work to Claude Code, Codex, OpenCode or Cursor, runs several tasks at once, and reports back here.',
      ),
      h(
        'div',
        { class: 'suggestions' },
        examples.map((t) =>
          h('button', { class: 'chip', type: 'button', onclick: () => ((input.value = t), autosize(), input.focus()) }, t),
        ),
      ),
      !repos.length ? h('p', { class: 'hint' }, 'Tip: add a repository in ', h('a', { href: '#/settings' }, 'Settings'), ' so workers can open pull requests.') : null,
    );
  }

  function render(m) {
    if (seen.has(m.id)) return null;
    seen.add(m.id);
    if (m.role === 'user') return h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble' }, m.text));
    if (m.role === 'agent') return h('div', { class: 'msg msg-agent' }, h('div', { class: 'md', html: md(m.text) }));
    let meta = {};
    try {
      meta = JSON.parse(m.meta || '{}');
    } catch {
      /* plain system line */
    }
    const w = meta.worker ? state.workers.get(meta.worker) : null;
    const body = [w ? agentDot(w.agent) : icon('shield', 14), h('span', { class: 'ev-text' }, m.text), h('span', { class: 'when' }, clock(m.created_at))];
    return meta.worker
      ? h('a', { class: `msg-event ev-${meta.event ?? 'info'}`, href: `#/tasks/${meta.worker}` }, body)
      : h('div', { class: `msg-event ev-${meta.event ?? 'info'}` }, body);
  }

  function add(m) {
    const stick = nearBottom();
    const node = render(m);
    if (!node) return;
    if (empty) {
      empty.remove();
      empty = null;
    }
    list.append(node);
    if (stick || m.role === 'user') toBottom();
  }

  function renderLanes() {
    const active = activeWorkers();
    wrap.classList.toggle('with-lanes', active.length > 0);
    if (!active.length) return clear(lanes);
    clear(
      lanes,
      h('h2', {}, 'Running now'),
      active.map((w) =>
        h(
          'a',
          { class: `lane st-${w.status}`, href: `#/tasks/${w.id}` },
          h('div', { class: 'lane-top' }, agentDot(w.agent), h('span', { class: 'lane-title' }, w.title)),
          h('div', { class: 'lane-meta' }, `W${w.id}`, h('span', {}, LANE_STATUS[w.status] ?? w.status)),
          track(w.id, w.status === 'running'),
        ),
      ),
    );
  }

  function setThinking() {
    thinking.hidden = !state.router?.busy;
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  async function submit(e) {
    e?.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    try {
      await api('POST', '/api/messages', { text });
    } catch (err) {
      input.value = text;
      autosize();
      toast(err.message, 'bad');
    }
  }

  composer.addEventListener('submit', submit);
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) submit(e);
  });

  api('GET', '/api/messages?limit=200')
    .then((msgs) => {
      if (!msgs.length) list.append((empty = emptyState()));
      for (const m of msgs) add(m);
      toBottom();
    })
    .catch((e) => toast(e.message, 'bad'));
  renderLanes();
  setThinking();
  input.focus();

  const off = listen((type, data) => {
    if (type === 'message') add(data);
    else if (type === 'router') setThinking();
    else if (type === 'worker') renderLanes();
  });
  return { unmount: off };
}
