import { AGENTS, api, clear, h, icon, toast } from '../lib.js';
import { state } from '../state.js';

const MODES = [
  ['mentions', 'Mentions only'],
  ['all', 'Everything'],
  ['off', 'Off'],
];

function select(options, value, onchange, label) {
  return h(
    'select',
    { class: 'input', onchange: (e) => onchange(e.target.value), 'aria-label': label },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
  );
}

function toggle(checked, onchange, label) {
  return h('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => onchange(e.target.checked), 'aria-label': label });
}

function row(title, hint, control) {
  return h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('div', {}, title), hint ? h('div', { class: 'hint' }, hint) : null), h('div', { class: 'set-control' }, control));
}

function text(value, onsave, opts = {}) {
  const el = h('input', { class: 'input', value: value ?? '', placeholder: opts.placeholder ?? '', type: opts.type ?? 'text', 'aria-label': opts.label ?? opts.placeholder ?? '' });
  el.addEventListener('change', () => onsave(opts.type === 'number' ? Number(el.value) : el.value.trim()));
  return el;
}

function list(s) {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim().replace(/^@/, ''))
    .filter(Boolean);
}

export default function settingsView(el) {
  const page = h('div', { class: 'page narrow' });
  el.append(page);
  let cfg = state.config;
  let system = null;

  // Redraw after every save so fields show what was actually stored (clamped numbers,
  // sections that appear or disappear with a toggle).
  async function save(patch, msg = 'Saved') {
    try {
      cfg = state.config = await api('PUT', '/api/config', patch);
      toast(msg);
    } catch (e) {
      toast(e.message, 'bad');
    }
    render();
  }

  function agentsSection() {
    const agentOpts = Object.keys(AGENTS)
      .filter((id) => id !== 'mock' || state.agents.some((a) => a.id === 'mock'))
      .map((id) => [id, AGENTS[id]]);
    return h(
      'section',
      { class: 'set-section' },
      h('h2', {}, 'Coding agents'),
      h('p', { class: 'hint' }, 'SuperAgent uses the agents already installed and signed in on this computer. Nothing is sent anywhere else.'),
      state.agents
        .filter((a) => a.id !== 'mock')
        .map((a) =>
          h(
            'div',
            { class: 'agent-row' },
            h('span', { class: `dot agent-${a.id}` }),
            h('div', { class: 'agent-name' }, h('div', {}, a.label), h('div', { class: a.installed ? 'hint' : 'hint bad-text' }, a.installed ? a.version : a.error ?? 'Not found')),
            text(cfg.agents[a.id]?.model, (v) => save({ agents: { [a.id]: { model: v } } }), { placeholder: 'Default model', label: `${a.label} model` }),
            toggle(cfg.agents[a.id]?.enabled !== false, (v) => save({ agents: { [a.id]: { enabled: v } } }), `Use ${a.label}`),
          ),
        ),
      row('Default agent for tasks', 'Used when you or the router do not pick one.', select(agentOpts, cfg.workers.defaultAgent, (v) => save({ workers: { defaultAgent: v } }), 'Default agent')),
      row(
        'Router',
        'The always-on agent that talks to you and hands out work. A fast, small model works best.',
        h('div', { class: 'inline' }, select(agentOpts, cfg.router.agent, (v) => save({ router: { agent: v } }), 'Router agent'), text(cfg.router.model, (v) => save({ router: { model: v } }), { placeholder: 'Model, e.g. haiku', label: 'Router model' })),
      ),
      h(
        'div',
        { class: 'set-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              state.agents = await api('POST', '/api/agents/refresh');
              render();
              toast('Agents checked');
            },
          },
          icon('retry', 16),
          'Check agents again',
        ),
      ),
    );
  }

  function reposSection() {
    const input = h('input', { class: 'input grow', placeholder: 'Folder path, owner/repo, or GitHub URL', 'aria-label': 'Repository to add' });
    const mode = select(MODES, 'mentions', () => {}, 'GitHub events');
    const add = async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try {
        await api('POST', '/api/repos', { input: input.value.trim(), mode: mode.value });
        cfg = state.config = await api('GET', '/api/config');
        toast('Repository added');
        render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    // Start from the live config: repos may have been added from the CLI meanwhile.
    const updateRepo = (name, patch) => save({ repos: (state.config ?? cfg).repos.map((r) => (r.name === name ? { ...r, ...patch } : r)) });
    return h(
      'section',
      { class: 'set-section' },
      h('h2', {}, 'Repositories'),
      h(
        'p',
        { class: 'hint' },
        `Workers get their own branch and folder for every task. On GitHub, write "${cfg.mention}" in an issue or comment to call SuperAgent.`,
      ),
      cfg.repos.length
        ? cfg.repos.map((r) =>
            h(
              'div',
              { class: 'repo' },
              h(
                'div',
                { class: 'repo-head' },
                h('div', {}, h('strong', {}, r.name), h('div', { class: 'hint' }, r.slug ? `${r.slug}${r.path ? ' at ' + r.path : ', cloned on first use'}` : `Local only at ${r.path}`)),
                h(
                  'button',
                  {
                    class: 'btn btn-ghost',
                    type: 'button',
                    title: `Remove ${r.name}`,
                    onclick: async () => {
                      try {
                        await api('DELETE', `/api/repos/${encodeURIComponent(r.name)}`);
                        cfg = state.config = await api('GET', '/api/config');
                        toast(`Removed ${r.name}`);
                      } catch (e) {
                        toast(e.message, 'bad');
                      }
                      render();
                    },
                  },
                  icon('x', 16),
                ),
              ),
              r.slug
                ? h(
                    'div',
                    { class: 'repo-grid' },
                    h('label', { class: 'field' }, h('span', {}, 'GitHub events'), select(MODES, r.mode, (v) => updateRepo(r.name, { mode: v }), 'GitHub events')),
                    h(
                      'label',
                      { class: 'field' },
                      h('span', {}, 'CI results'),
                      select([['failures', 'Failures only'], ['all', 'All'], ['off', 'Off']], r.ci, (v) => updateRepo(r.name, { ci: v }), 'CI results'),
                    ),
                    h(
                      'label',
                      { class: 'field' },
                      h('span', {}, 'Who can call it'),
                      text(r.allowUsers.join(', '), (v) => updateRepo(r.name, { allowUsers: list(v) }), { placeholder: 'Anyone (comma-separated logins)', label: 'Allowed users' }),
                    ),
                    h(
                      'label',
                      { class: 'field' },
                      h('span', {}, 'Preferred agent'),
                      select([['', 'Default'], ...Object.entries(AGENTS).filter(([k]) => k !== 'mock')], r.agent ?? '', (v) => updateRepo(r.name, { agent: v || undefined }), 'Preferred agent'),
                    ),
                  )
                : null,
            ),
          )
        : h('p', { class: 'muted' }, 'No repositories yet. Without one, tasks run in a scratch folder.'),
      h('form', { class: 'add-row', onsubmit: add }, input, mode, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')),
    );
  }

  function channelsSection() {
    const tg = cfg.telegram;
    const chatId = h('input', { class: 'input', placeholder: 'Chat id, e.g. -1001234567890', 'aria-label': 'Telegram chat id' });
    return h(
      'section',
      { class: 'set-section' },
      h('h2', {}, 'Where it listens'),
      row('GitHub', 'Uses your GitHub CLI login to read issues, pull requests, reviews and CI.', toggle(cfg.github.enabled, (v) => save({ github: { enabled: v } }), 'GitHub')),
      row('Check GitHub every', 'Seconds between checks.', text(cfg.github.pollSeconds, (v) => save({ github: { pollSeconds: v } }), { type: 'number', label: 'Poll seconds' })),
      row('Call word', 'Writing this in GitHub or Telegram addresses SuperAgent directly.', text(cfg.mention, (v) => save({ mention: v }), { label: 'Call word' })),
      row(
        'Telegram',
        h('span', {}, 'Optional. Create a bot with ', h('a', { href: 'https://t.me/BotFather', target: '_blank', rel: 'noreferrer' }, '@BotFather'), ' and paste its token.'),
        toggle(tg.enabled, (v) => save({ telegram: { enabled: v } }), 'Telegram'),
      ),
      tg.enabled
        ? [
            row(
              'Bot token',
              tg.botToken ? 'Saved. Paste a new token to replace it.' : null,
              // Never prefill the masked token: typing next to it would look like an edit but be ignored.
              text('', (v) => v && save({ telegram: { botToken: v } }, 'Token saved'), { type: 'password', placeholder: tg.botToken || '123456:ABC…', label: 'Bot token' }),
            ),
            row('Your Telegram username', 'Direct messages from these users are answered.', text(tg.allowUsers.join(', '), (v) => save({ telegram: { allowUsers: list(v) } }), { placeholder: 'username', label: 'Telegram users' })),
            h(
              'div',
              { class: 'set-row col' },
              h('div', { class: 'set-label' }, h('div', {}, 'Group chats'), h('div', { class: 'hint' }, 'Add the bot to a group, send a message, then copy the chat id from Activity.')),
              tg.chats.map((c) =>
                h(
                  'div',
                  { class: 'inline' },
                  h('code', {}, c.id),
                  select(MODES, c.mode, (v) => save({ telegram: { chats: tg.chats.map((x) => (x.id === c.id ? { ...x, mode: v } : x)) } }), 'Chat mode'),
                  h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': `Remove chat ${c.id}`, onclick: () => save({ telegram: { chats: tg.chats.filter((x) => x.id !== c.id) } }) }, icon('x', 16)),
                ),
              ),
              h(
                'form',
                {
                  class: 'add-row',
                  onsubmit: (e) => {
                    e.preventDefault();
                    const id = chatId.value.trim();
                    if (!id) return;
                    if (tg.chats.some((x) => x.id === id)) return toast('That chat is already added');
                    save({ telegram: { chats: [...tg.chats, { id, mode: 'mentions' }] } });
                  },
                },
                chatId,
                h('button', { class: 'btn', type: 'submit' }, 'Add chat'),
              ),
            ),
          ]
        : null,
    );
  }

  function behaviorSection() {
    const policies = h('textarea', { class: 'input', rows: 5, 'aria-label': 'Policies' }, cfg.policies);
    policies.addEventListener('change', () => save({ policies: policies.value }, 'Policies saved'));
    return h(
      'section',
      { class: 'set-section' },
      h('h2', {}, 'How it works'),
      h('div', { class: 'set-row col' }, h('div', { class: 'set-label' }, h('div', {}, 'Policies'), h('div', { class: 'hint' }, 'Plain-language rules for events nobody addressed to SuperAgent directly. The router follows them.')), policies),
      row('Tasks at the same time', 'How many workers may run in parallel.', text(cfg.workers.maxConcurrent, (v) => save({ workers: { maxConcurrent: v } }), { type: 'number', label: 'Parallel tasks' })),
      row(
        'Autonomy',
        'Full lets agents work without asking for approval, inside their own task folder.',
        select([['full', 'Full'], ['safe', 'Safe (agent sandbox)']], cfg.workers.autonomy, (v) => save({ workers: { autonomy: v } }), 'Autonomy'),
      ),
      row('Open draft pull requests', 'Workers push their branch and open a draft PR. They never merge or push to your main branch.', toggle(cfg.workers.allowDraftPRs, (v) => save({ workers: { allowDraftPRs: v } }), 'Draft PRs')),
      row('Watchdog', 'Restarts crashed or stuck parts on its own.', toggle(cfg.watchdog.enabled, (v) => save({ watchdog: { enabled: v } }), 'Watchdog')),
      row('Progress checks', 'Asks the router model every few minutes whether long tasks are getting somewhere.', toggle(cfg.watchdog.llmChecks, (v) => save({ watchdog: { llmChecks: v } }), 'Progress checks')),
    );
  }

  function systemSection() {
    if (!system) return h('section', { class: 'set-section' }, h('h2', {}, 'This computer'), h('p', { class: 'muted' }, 'Loading…'));
    const skillBtn = (target, label) =>
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            try {
              const r = await api('POST', '/api/system/skill', { target });
              system.skill = r.skill;
              toast(`Skill installed for ${label}`);
              render();
            } catch (e) {
              toast(e.message, 'bad');
            }
          },
        },
        system.skill[target] ? `Reinstall for ${label}` : `Install for ${label}`,
      );
    return h(
      'section',
      { class: 'set-section' },
      h('h2', {}, 'This computer'),
      row(
        'Start when I log in',
        'Keeps SuperAgent listening in the background.',
        toggle(
          system.autostart,
          async (v) => {
            try {
              system.autostart = (await api('POST', '/api/system/autostart', { enabled: v })).autostart;
              toast(system.autostart ? 'Starts at login' : 'Will not start at login');
            } catch (e) {
              toast(e.message, 'bad');
            }
          },
          'Start at login',
        ),
      ),
      row(
        'Skill',
        h('span', {}, 'Lets you hand work to SuperAgent from inside Claude Code or Codex with ', h('code', {}, '/superagent'), '.'),
        h('div', { class: 'inline' }, skillBtn('claude', 'Claude Code'), skillBtn('codex', 'Codex')),
      ),
      row('Data folder', system.home, h('button', { class: 'btn', type: 'button', onclick: () => api('POST', '/api/system/open-home') }, icon('folder', 16), 'Open')),
      row('Version', `SuperAgent ${system.version}, Node ${system.node}`, null),
    );
  }

  function render() {
    cfg = state.config ?? cfg;
    if (!cfg) return;
    clear(page, h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), agentsSection(), reposSection(), channelsSection(), behaviorSection(), systemSection());
  }

  render();
  api('GET', '/api/system')
    .then((s) => {
      system = s;
      render();
    })
    .catch((e) => toast(e.message, 'bad'));
  return {};
}
