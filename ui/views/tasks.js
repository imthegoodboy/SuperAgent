import { AGENTS, STATUS_TEXT, agentDot, ago, api, clear, clock, h, icon, listen, md, toast, track } from '../lib.js';
import { availableAgents, state } from '../state.js';

const ACTIVE = ['queued', 'running', 'waiting'];

function pill(status) {
  return h('span', { class: `pill st-${status}` }, STATUS_TEXT[status] ?? status);
}

function logRow(l) {
  const t = String(l.text ?? '');
  switch (l.kind) {
    case 'text':
      return h('div', { class: 'l-text md', html: md(t) });
    case 'tool':
      return h('div', { class: 'l-tool' }, t);
    case 'output':
      return h('pre', { class: 'l-out' }, t.split('\n').slice(-14).join('\n'));
    case 'error':
      return h('pre', { class: 'l-err' }, t);
    case 'inbox':
      return h('div', { class: 'l-inbox' }, icon('chat', 14), h('span', {}, t));
    default:
      return h('div', { class: 'l-sys' }, h('span', {}, t), h('span', { class: 'when' }, clock(l.ts)));
  }
}

export default function tasksView(el, arg) {
  let selected = arg ? Number(arg) : null;
  const listBody = h('div', { class: 'task-list' });
  const detail = h('section', { class: 'detail' });
  const newBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openNew() }, icon('plus', 16), 'New task');
  const showArchived = h('input', { type: 'checkbox', class: 'switch sm', onchange: () => reloadList() });
  const listPane = h(
    'section',
    { class: 'list-pane' },
    h('div', { class: 'pane-head' }, h('h1', {}, 'Tasks'), newBtn),
    listBody,
    h('label', { class: 'archived-toggle' }, showArchived, 'Show archived'),
  );
  const split = h('div', { class: `split${selected ? ' has-detail' : ''}` }, listPane, detail);
  el.append(split);

  let archived = [];
  async function reloadList() {
    try {
      archived = showArchived.checked ? await api('GET', '/api/workers?archived=only') : [];
    } catch (e) {
      toast(e.message, 'bad');
    }
    renderList();
  }

  function row(w) {
    return h(
      'a',
      { class: `task-row${w.id === selected ? ' selected' : ''}`, href: `#/tasks/${w.id}` },
      h('div', { class: 'row-top' }, agentDot(w.agent), h('span', { class: 'row-title' }, w.title)),
      h('div', { class: 'row-meta' }, pill(w.status), h('span', {}, `W#${w.id}`), w.repo ? h('span', {}, w.repo) : null, h('span', {}, ago(w.created_at))),
      w.status === 'running' ? track(w.id, true) : null,
    );
  }

  function renderList() {
    const all = [...state.workers.values()].filter((w) => !w.archived).sort((a, b) => b.id - a.id);
    const active = all.filter((w) => ACTIVE.includes(w.status));
    const finished = all.filter((w) => !ACTIVE.includes(w.status));
    if (!all.length && !archived.length) {
      return clear(listBody, h('div', { class: 'empty' }, h('p', {}, 'No tasks yet.'), h('p', { class: 'muted' }, 'Ask for something in Chat, or start one here with New task.')));
    }
    clear(
      listBody,
      active.length ? [h('h2', { class: 'group' }, 'Active'), active.map(row)] : null,
      finished.length ? [h('h2', { class: 'group' }, 'Finished'), finished.map(row)] : null,
      archived.length ? [h('h2', { class: 'group' }, 'Archived'), archived.map(row)] : null,
    );
  }

  // ---------- detail ----------

  let logEl = null;
  let lastLogId = 0;

  function actions(w, active) {
    const btns = [];
    if (w.cwd && !w.archived)
      btns.push(h('button', { class: 'btn', type: 'button', onclick: () => call(`/api/workers/${w.id}/open`) }, icon('folder', 16), 'Open folder'));
    if (ACTIVE.includes(w.status) || active)
      btns.push(h('button', { class: 'btn btn-danger', type: 'button', onclick: () => call(`/api/workers/${w.id}/stop`, 'Stopped') }, icon('stop', 16), 'Stop'));
    if (['failed', 'stopped'].includes(w.status) && !w.archived)
      btns.push(h('button', { class: 'btn', type: 'button', onclick: () => call(`/api/workers/${w.id}/retry`, 'Retrying') }, icon('retry', 16), 'Retry'));
    if (!ACTIVE.includes(w.status) && !w.archived)
      btns.push(
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            title: 'Remove the workspace folder. The branch and any pull request stay.',
            onclick: async () => {
              const ok = confirm(`Archive W#${w.id}? Its workspace folder is deleted, including uncommitted changes. Committed work on its branch and any pull request stay.`);
              if (ok && (await call(`/api/workers/${w.id}/archive`, 'Archived'))) location.hash = '#/tasks';
            },
          },
          icon('archive', 16),
          'Archive',
        ),
      );
    return btns;
  }

  async function call(path, msg) {
    try {
      await api('POST', path);
      if (msg) toast(msg);
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    }
  }

  function callout(w) {
    if (w.status === 'waiting')
      return h('div', { class: 'callout warn' }, h('strong', {}, 'Needs your input'), h('div', { class: 'md', html: md(w.summary || 'The worker is waiting for an answer.') }), h('p', { class: 'muted' }, 'Reply below, or answer in Chat.'));
    if (w.status === 'failed' && w.error) return h('div', { class: 'callout bad' }, h('strong', {}, 'Failed'), h('pre', {}, w.error));
    if (w.summary) return h('div', { class: 'callout' }, h('strong', {}, w.status === 'done' ? 'Result' : 'Latest report'), h('div', { class: 'md', html: md(w.summary) }));
    return null;
  }

  function header(d) {
    const w = d.worker;
    return h(
      'div',
      { class: 'detail-head' },
      h('a', { class: 'back', href: '#/tasks' }, 'All tasks'),
      h('div', { class: 'detail-title' }, agentDot(w.agent), h('h2', {}, w.title)),
      h(
        'div',
        { class: 'detail-meta' },
        pill(w.status),
        h('span', {}, `W#${w.id}`),
        h('span', {}, AGENTS[w.agent] ?? w.agent),
        w.repo ? h('span', {}, w.repo) : h('span', { class: 'muted' }, 'Scratch folder'),
        w.branch ? h('code', {}, w.branch) : null,
        w.pr_url ? h('a', { href: w.pr_url, target: '_blank', rel: 'noreferrer', class: 'pr-link' }, icon('pr', 14), 'Pull request') : null,
      ),
      h('div', { class: 'detail-actions' }, actions(w, d.active)),
    );
  }

  async function showDetail(id) {
    selected = id;
    split.classList.toggle('has-detail', !!id);
    renderList();
    if (!id) {
      logEl = null;
      return clear(detail, h('div', { class: 'empty center' }, h('p', { class: 'muted' }, 'Pick a task to see what its agent is doing.')));
    }
    let d;
    try {
      d = await api('GET', `/api/workers/${id}`);
    } catch (e) {
      if (selected !== id) return;
      return clear(detail, h('div', { class: 'empty center' }, h('p', {}, e.message)));
    }
    if (selected !== id) return;
    logEl = h('div', { class: 'log', role: 'log' }, d.logs.map(logRow));
    lastLogId = d.logs.at(-1)?.id ?? 0;
    const msgInput = h('input', { class: 'input', placeholder: `Send W#${id} a message, e.g. "also update the docs"`, 'aria-label': 'Message this worker' });
    const msgForm = h(
      'form',
      {
        class: 'worker-composer',
        onsubmit: async (e) => {
          e.preventDefault();
          const text = msgInput.value.trim();
          if (!text) return;
          msgInput.value = '';
          try {
            await api('POST', `/api/workers/${id}/message`, { text });
          } catch (err) {
            msgInput.value = text;
            toast(err.message, 'bad');
          }
        },
      },
      msgInput,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send'),
    );
    const followed = d.threads.filter((t) => t.url);
    clear(
      detail,
      h('div', { class: 'detail-headwrap', 'data-head': '1' }, header(d), callout(d.worker)),
      h(
        'div',
        { class: 'detail-body' },
        h('details', { class: 'task-text' }, h('summary', {}, 'Task instructions'), h('div', { class: 'md', html: md(d.worker.task) })),
        followed.length
          ? h('p', { class: 'follows muted' }, 'Following ', followed.map((t, i) => [i ? ', ' : '', h('a', { href: t.url, target: '_blank', rel: 'noreferrer' }, t.title ?? t.key)]))
          : null,
        logEl,
      ),
      d.worker.archived ? null : msgForm,
    );
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
  }

  function refreshHeader() {
    const w = state.workers.get(selected);
    const wrap = detail.querySelector('[data-head]');
    if (!w || !wrap) return;
    clear(wrap, header({ worker: w, active: ACTIVE.includes(w.status) }), callout(w));
  }

  // ---------- new task dialog ----------

  function openNew() {
    const task = h('textarea', { class: 'input', rows: 5, required: true, placeholder: 'Describe what you want done. Be as specific as you like.' });
    const title = h('input', { class: 'input', placeholder: 'Optional short title' });
    const agents = availableAgents();
    const agent = h(
      'select',
      { class: 'input' },
      h('option', { value: '' }, 'Automatic'),
      agents.map((a) => h('option', { value: a.id }, a.label)),
    );
    const repo = h(
      'select',
      { class: 'input' },
      h('option', { value: '' }, 'No repository (scratch folder)'),
      (state.config?.repos ?? []).map((r) => h('option', { value: r.name }, r.slug ? `${r.name} (${r.slug})` : r.name)),
    );
    const dlg = h(
      'dialog',
      { class: 'dialog' },
      h(
        'form',
        {
          method: 'dialog',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const w = await api('POST', '/api/workers', { task: task.value, title: title.value, agent: agent.value, repo: repo.value });
              dlg.close();
              location.hash = `#/tasks/${w.id}`;
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        },
        h('h2', {}, 'New task'),
        h('p', { class: 'muted' }, 'Starts a worker right away, without going through the router.'),
        h('label', { class: 'field' }, h('span', {}, 'Task'), task),
        h('label', { class: 'field' }, h('span', {}, 'Title'), title),
        h('div', { class: 'field-row' }, h('label', { class: 'field' }, h('span', {}, 'Agent'), agent), h('label', { class: 'field' }, h('span', {}, 'Repository'), repo)),
        h(
          'div',
          { class: 'dialog-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
          h('button', { class: 'btn btn-primary', type: 'submit' }, 'Start task'),
        ),
      ),
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    task.focus();
  }

  const off = listen((type, data) => {
    if (type === 'worker') {
      if (showArchived.checked && data?.archived) reloadList();
      else renderList();
      if (data?.id === selected) refreshHeader();
    } else if (type === 'worker_log' && data?.worker_id === selected && logEl && data.id > lastLogId) {
      lastLogId = data.id;
      const box = logEl.parentElement;
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      logEl.append(logRow(data));
      if (stick) box.scrollTop = box.scrollHeight;
    }
  });

  showDetail(selected);
  return {
    update: (next) => showDetail(next ? Number(next) : null),
    unmount: off,
  };
}
