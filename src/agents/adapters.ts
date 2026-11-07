import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId } from '../core/config.js';
import { clip, oneLine, tail, tryJson } from '../core/util.js';
import type { Resolved } from './process.js';

export type AgentEvent =
  | { kind: 'session'; id: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'output'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'final'; text: string };

export interface RunSpec {
  cwd: string;
  prompt: string;
  /** Agent-native session id to resume, if any. */
  session: string | null;
  model: string;
  /** Extra system instructions (merged into the prompt for agents without a system flag). */
  system: string;
  autonomy: 'full' | 'safe';
  /** Directories outside cwd the agent must be able to write (e.g. the main repo's .git for worktrees). */
  writableDirs: string[];
}

export interface RouterSpec {
  cwd: string;
  prompt: string;
  session: string | null;
  model: string;
  system: string;
  schema: object;
  schemaPath: string;
}

export interface AgentAdapter {
  id: AgentId | 'mock';
  label: string;
  command: string;
  promptVia: 'stdin' | 'arg';
  supportsSystem: boolean;
  workerArgs(spec: RunSpec): string[];
  routerArgs(spec: RouterSpec): string[];
  parser(): (line: string) => AgentEvent[];
  resolve?(): Resolved | null;
}

function toolSummary(name: string, input: any): string {
  const i = input ?? {};
  const target = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description;
  if (name === 'Bash' || name === 'PowerShell') return `$ ${clip(oneLine(String(i.command ?? '')), 300)}`;
  if (name === 'TodoWrite' && Array.isArray(i.todos)) return `Plan: ${i.todos.map((t: any) => t.content).join(' · ')}`;
  return `${name}${target ? ' ' + clip(oneLine(String(target)), 200) : ''}`;
}

function resultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return '';
}

// ---------- Claude Code ----------

function claudeParser(): (line: string) => AgentEvent[] {
  return (line) => {
    const ev = tryJson<any>(line);
    if (!ev || typeof ev !== 'object') return [];
    const out: AgentEvent[] = [];
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) out.push({ kind: 'session', id: ev.session_id });
    else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text });
        else if (c.type === 'tool_use') out.push({ kind: 'tool', text: toolSummary(c.name, c.input) });
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content) && !ev.parent_tool_use_id) {
      for (const c of ev.message.content) {
        if (c.type === 'tool_result') {
          const t = tail(resultText(c.content).trim(), 600);
          if (t) out.push({ kind: c.is_error ? 'error' : 'output', text: t });
        }
      }
    } else if (ev.type === 'result') {
      if (ev.session_id) out.push({ kind: 'session', id: ev.session_id });
      if (ev.is_error) out.push({ kind: 'error', text: String(ev.result || ev.subtype || 'Claude Code reported an error') });
      else if (ev.structured_output !== undefined && ev.structured_output !== null)
        out.push({ kind: 'final', text: JSON.stringify(ev.structured_output) });
      else out.push({ kind: 'final', text: String(ev.result ?? '') });
    }
    return out;
  };
}

export const claude: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  promptVia: 'stdin',
  supportsSystem: true,
  workerArgs(s) {
    return [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', s.autonomy === 'full' ? 'bypassPermissions' : 'auto',
      ...(s.autonomy === 'safe' ? ['--permission-prompts', 'none'] : []),
      ...(s.model ? ['--model', s.model] : []),
      ...(s.session ? ['--resume', s.session] : []),
      ...(s.system && !s.session ? ['--append-system-prompt', s.system] : []),
      ...s.writableDirs.flatMap((d) => ['--add-dir', d]),
    ];
  },
  routerArgs(s) {
    return [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
      '--json-schema', JSON.stringify(s.schema),
      ...(s.model ? ['--model', s.model] : []),
      ...(s.session ? ['--resume', s.session] : ['--system-prompt', s.system]),
    ];
  },
  parser: claudeParser,
};

// ---------- Codex ----------

export const codex: AgentAdapter = {
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  promptVia: 'stdin',
  supportsSystem: false,
  workerArgs(s) {
    const sandbox =
      s.autonomy === 'full'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : [
            '-c', 'sandbox_mode="workspace-write"',
            '-c', 'sandbox_workspace_write.network_access=true',
            ...(s.writableDirs.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(s.writableDirs)}`] : []),
          ];
    const model = s.model ? ['-m', s.model] : [];
    return s.session
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...sandbox, ...model, s.session, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-C', s.cwd, ...sandbox, ...model, '-'];
  },
  routerArgs(s) {
    const common = ['--json', '--skip-git-repo-check', '--output-schema', s.schemaPath, ...(s.model ? ['-m', s.model] : [])];
    return s.session
      ? ['exec', 'resume', ...common, '-c', 'sandbox_mode="read-only"', s.session, '-']
      : ['exec', ...common, '-C', s.cwd, '-s', 'read-only', '-'];
  },
  parser() {
    let last = '';
    return (line) => {
      const ev = tryJson<any>(line);
      if (!ev || typeof ev !== 'object') return [];
      const item = ev.item ?? {};
      switch (ev.type) {
        case 'thread.started':
          return ev.thread_id ? [{ kind: 'session', id: ev.thread_id }] : [];
        case 'item.started':
          if (item.type === 'command_execution') return [{ kind: 'tool', text: `$ ${clip(oneLine(item.command), 300)}` }];
          return [];
        case 'item.completed':
          switch (item.type) {
            case 'agent_message':
              last = item.text ?? '';
              return last.trim() ? [{ kind: 'text', text: last }] : [];
            case 'command_execution': {
              const out = tail(String(item.aggregated_output ?? '').trim(), 600);
              return [{ kind: item.exit_code ? 'error' : 'output', text: `exit ${item.exit_code ?? '?'}${out ? `\n${out}` : ''}` }];
            }
            case 'file_change':
              return [{ kind: 'tool', text: `Edit ${(item.changes ?? []).map((c: any) => c.path).join(', ')}` }];
            case 'mcp_tool_call':
              return [{ kind: 'tool', text: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}` }];
            case 'web_search':
              return [{ kind: 'tool', text: `WebSearch ${item.query ?? ''}` }];
            case 'todo_list':
              return [{ kind: 'tool', text: `Plan: ${(item.items ?? []).map((t: any) => t.text).join(' · ')}` }];
            case 'error':
              return [{ kind: 'error', text: item.message ?? 'error' }];
            default:
              return [];
          }
        case 'turn.completed':
          return [{ kind: 'final', text: last }];
        case 'turn.failed':
          return [{ kind: 'error', text: ev.error?.message ?? 'Codex turn failed' }];
        case 'error':
          return [{ kind: 'error', text: ev.message ?? 'Codex error' }];
        default:
          return [];
      }
    };
  },
};

// ---------- OpenCode ----------

export const opencode: AgentAdapter = {
  id: 'opencode',
  label: 'OpenCode',
  command: 'opencode',
  promptVia: 'arg',
  supportsSystem: false,
  workerArgs(s) {
    return [
      'run', '--format', 'json',
      ...(s.autonomy === 'full' ? ['--auto'] : []),
      ...(s.model ? ['-m', s.model] : []),
      ...(s.session ? ['-s', s.session] : []),
    ];
  },
  routerArgs(s) {
    // The built-in read-only "plan" agent keeps the router from editing files or running commands.
    return ['run', '--format', 'json', '--agent', 'plan', ...(s.model ? ['-m', s.model] : []), ...(s.session ? ['-s', s.session] : [])];
  },
  parser() {
    let sent = false;
    return (line) => {
      const ev = tryJson<any>(line);
      if (!ev || typeof ev !== 'object') return [];
      const out: AgentEvent[] = [];
      if (ev.sessionID && !sent) {
        sent = true;
        out.push({ kind: 'session', id: ev.sessionID });
      }
      const part = ev.part ?? {};
      if (ev.type === 'text' && part.text?.trim()) out.push({ kind: 'text', text: part.text });
      else if (ev.type === 'tool_use' || ev.type === 'tool') {
        const st = part.state ?? {};
        out.push({ kind: 'tool', text: toolSummary(part.tool ?? 'tool', st.input) });
        if (st.status === 'completed' && st.output) out.push({ kind: 'output', text: tail(String(st.output).trim(), 600) });
        if (st.status === 'error') out.push({ kind: 'error', text: String(st.error ?? 'tool error') });
      } else if (ev.type === 'error') {
        out.push({ kind: 'error', text: String(ev.error?.message ?? ev.error?.data?.message ?? ev.message ?? 'OpenCode error') });
      }
      return out;
    };
  },
};

// ---------- Cursor Agent ----------

function cursorToolSummary(tc: any): string {
  if (!tc || typeof tc !== 'object') return 'tool';
  const key = Object.keys(tc)[0] ?? 'tool';
  const args = tc[key]?.args ?? {};
  const name = key.replace(/ToolCall$/, '');
  const target = args.command ?? args.path ?? args.pattern ?? args.query ?? args.url ?? '';
  return name === 'shell' ? `$ ${clip(oneLine(String(target)), 300)}` : `${name}${target ? ' ' + clip(oneLine(String(target)), 200) : ''}`;
}

export const cursor: AgentAdapter = {
  id: 'cursor',
  label: 'Cursor Agent',
  command: 'cursor-agent',
  promptVia: 'arg',
  supportsSystem: false,
  workerArgs(s) {
    return [
      '-p', '--output-format', 'stream-json', '--trust', '--workspace', s.cwd,
      ...(s.autonomy === 'full' ? ['--force'] : []),
      ...(s.model ? ['--model', s.model] : []),
      ...(s.session ? ['--resume', s.session] : []),
    ];
  },
  routerArgs(s) {
    return [
      '-p', '--output-format', 'stream-json', '--trust', '--mode', 'ask', '--workspace', s.cwd,
      ...(s.model ? ['--model', s.model] : []),
      ...(s.session ? ['--resume', s.session] : []),
    ];
  },
  parser() {
    let sent = false;
    return (line) => {
      const ev = tryJson<any>(line);
      if (!ev || typeof ev !== 'object') return [];
      const out: AgentEvent[] = [];
      const sid = ev.session_id ?? ev.chatId;
      if (sid && !sent) {
        sent = true;
        out.push({ kind: 'session', id: sid });
      }
      if (ev.type === 'assistant') {
        const content = ev.message?.content ?? [];
        const text = (Array.isArray(content) ? content : [content]).map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
        if (text.trim()) out.push({ kind: 'text', text });
      } else if (ev.type === 'tool_call' && ev.subtype === 'started') out.push({ kind: 'tool', text: cursorToolSummary(ev.tool_call) });
      else if (ev.type === 'result') {
        if (ev.is_error) out.push({ kind: 'error', text: String(ev.result ?? 'Cursor Agent error') });
        else out.push({ kind: 'final', text: String(ev.result ?? '') });
      } else if (ev.type === 'error') out.push({ kind: 'error', text: String(ev.message ?? ev.error ?? 'Cursor Agent error') });
      return out;
    };
  },
};

// ---------- Mock (tests / demo, enabled with SUPERAGENT_MOCK=1) ----------

const MOCK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-agent.js');

export const mock: AgentAdapter = {
  id: 'mock',
  label: 'Mock Agent',
  command: 'mock',
  promptVia: 'stdin',
  supportsSystem: true,
  workerArgs(s) {
    return ['worker', ...(s.session ? ['--resume', s.session] : [])];
  },
  routerArgs(s) {
    return ['router', ...(s.session ? ['--resume', s.session] : [])];
  },
  parser: claudeParser,
  resolve() {
    return { file: process.execPath, prefix: [MOCK_SCRIPT], via: 'node', path: MOCK_SCRIPT };
  },
};

export const ADAPTERS: Record<string, AgentAdapter> = { claude, codex, opencode, cursor, mock };

export function adapterFor(id: string): AgentAdapter | null {
  if (id === 'mock' && process.env.SUPERAGENT_MOCK !== '1') return null;
  return ADAPTERS[id] ?? null;
}
