import type { RunState } from '../../types/ai';
import type { Entry, HistoryRow } from '../../types/aiHistory';

/** "2.1 GB", "340 KB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** "14 min", "38 s", "2 h 05". */
export function fmtTook(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
}

/** The look of a run's end: the word, and its chip colours. */
export const END_LOOK: Record<RunState, { label: string; bg: string; fg: string }> = {
  queued: { label: 'Queued', bg: '#E8F1FA', fg: '#244E78' },
  starting: { label: 'Starting', bg: '#E8F1FA', fg: '#244E78' },
  running: { label: 'Running', bg: '#E6F2EA', fg: '#1F5A31' },
  needs_input: { label: 'Needed you', bg: '#FEF3D9', fg: '#7A5A06' },
  finished: { label: 'Finished', bg: '#E6F2EA', fg: '#1F5A31' },
  failed: { label: 'Failed', bg: '#FDECE8', fg: '#A5321E' },
  cancelled: { label: 'Cancelled', bg: '#F1F3F1', fg: '#5B6B60' },
  timed_out: { label: 'Timed out', bg: '#FDECE8', fg: '#A5321E' },
};

/** "11 Mar 11:22" for older runs, "11:22" for today's. */
export function fmtWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return clock;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock}`;
}

/** "11:22:04". */
export function fmtSecondClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** Text of a tool input or output: strings as they are, anything else as indented JSON. */
export function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Cut a long text in the middle: the first and last lines are kept, the count of those hidden is returned. */
export function cutMiddle(text: string, keep = 12): { shown: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= keep * 2 + 2) return { shown: text, hidden: 0 };
  const hidden = lines.length - keep * 2;
  return { shown: [...lines.slice(0, keep), `… ${hidden} lines hidden`, ...lines.slice(-keep)].join('\n'), hidden };
}

type ToolEntry = Extract<Entry, { type: 'tool' }>;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const oneLine = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The kind of a tool call, for the icon and the filter. */
export type ToolKind = 'command' | 'file' | 'search' | 'skill' | 'subagent' | 'board' | 'other';

/** What a tool call says in one line, and which kind it is. */
export function describeTool(e: ToolEntry): { kind: ToolKind; title: string } {
  const input = obj(e.input);
  const name = e.name;
  switch (name) {
    case 'Bash':
      return { kind: 'command', title: `Ran ${oneLine(str(input.command) || str(input.description))}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'file', title: `Edited ${str(input.file_path ?? input.path)}` };
    case 'Write':
      return { kind: 'file', title: `Wrote ${str(input.file_path ?? input.path)}` };
    case 'Read':
      return { kind: 'file', title: `Read ${str(input.file_path ?? input.path)}` };
    case 'Grep':
    case 'Glob':
      return { kind: 'search', title: `${name === 'Grep' ? 'Searched for' : 'Listed'} ${oneLine(str(input.pattern))}` };
    case 'Skill':
      return { kind: 'skill', title: `Used the skill ${str(input.skill) || str(input.name)}` };
    case 'Task':
    case 'Agent': {
      const who = str(input.subagent_type) || 'a subagent';
      const what = str(input.description);
      return { kind: 'subagent', title: `Handed to the subagent ${who}${what ? `: ${oneLine(what, 70)}` : ''}` };
    }
    default:
      if (name.startsWith('mcp__kanban__')) {
        return { kind: 'board', title: `Board: ${name.slice('mcp__kanban__'.length).replace(/_/g, ' ')}` };
      }
      if (name.startsWith('mcp__')) return { kind: 'other', title: `Called ${name.split('__').slice(1).join(' › ')}` };
      return { kind: 'other', title: `Called ${name}` };
  }
}

/** The words a board note carries as a label. */
export const NOTE_LABEL: Record<string, string> = {
  restart: 'Restarted',
  diagnosis: 'Diagnosis',
  retry: 'Retry',
  window: 'Usage window',
  stop_child: 'Stopped a process',
  sleep: 'Waiting',
  end: 'Ended',
  moved: 'Moved',
};

export interface Step {
  key: string;
  at: string;
  entry: Exclude<Entry, { type: 'sent' } | { type: 'init' }>;
  /** One line that tells what happened. */
  title: string;
  tone: 'plain' | 'tool' | 'error' | 'board' | 'person' | 'end';
  /** Seconds the step took (a tool call that has an end). */
  tookS: number | null;
}

/** The entry's first line of text, cut. */
function textTitle(text: string): string {
  return oneLine(text, 140) || '…';
}

/**
 * The steps of a run: every entry but the two that open it (what was sent, what the CLI started with), in order.
 * A thought is folded into the next step by the view, so it stays a step of its own here.
 */
export function buildSteps(entries: Entry[]): Step[] {
  const steps: Step[] = [];
  entries.forEach((entry, i) => {
    if (entry.type === 'sent' || entry.type === 'init') return;
    const key = `${i}:${entry.type}`;
    switch (entry.type) {
      case 'tool': {
        const d = describeTool(entry);
        const took =
          entry.endedAt && entry.at ? Math.max(0, (Date.parse(entry.endedAt) - Date.parse(entry.at)) / 1000) : null;
        steps.push({
          key,
          at: entry.at,
          entry,
          title: d.title,
          tone: entry.isError ? 'error' : d.kind === 'board' ? 'board' : 'tool',
          tookS: took != null && Number.isFinite(took) ? took : null,
        });
        break;
      }
      case 'say':
        steps.push({ key, at: entry.at, entry, title: textTitle(entry.text), tone: 'plain', tookS: null });
        break;
      case 'think':
        steps.push({
          key,
          at: entry.at,
          entry,
          title: `Thought: ${textTitle(entry.text)}`,
          tone: 'plain',
          tookS: null,
        });
        break;
      case 'message':
        steps.push({
          key,
          at: entry.at,
          entry,
          title: `A person wrote: ${textTitle(entry.text)}`,
          tone: 'person',
          tookS: null,
        });
        break;
      case 'note':
        steps.push({
          key,
          at: entry.at,
          entry,
          title: `${NOTE_LABEL[entry.kind] ?? 'Board'}: ${textTitle(entry.text)}`,
          tone: entry.kind === 'end' ? 'end' : 'board',
          tookS: null,
        });
        break;
      case 'compact':
        steps.push({
          key,
          at: entry.at,
          entry,
          title:
            entry.before != null && entry.after != null
              ? `Compacted its memory: ${entry.before.toLocaleString()} → ${entry.after.toLocaleString()} tokens`
              : 'Compacted its memory',
          tone: 'board',
          tookS: null,
        });
        break;
      case 'result':
        steps.push({
          key,
          at: entry.at,
          entry,
          title: entry.isError
            ? `Stopped with an error${entry.apiError ? ` (${entry.apiError})` : ''}`
            : `Finished${entry.turns != null ? ` after ${entry.turns} turns` : ''}`,
          tone: entry.isError ? 'error' : 'end',
          tookS: null,
        });
        break;
      case 'quota':
        steps.push({
          key,
          at: entry.at,
          entry,
          title: `Usage window: ${entry.status ?? 'reported'}`,
          tone: 'board',
          tookS: null,
        });
        break;
      case 'output':
        steps.push({ key, at: entry.at, entry, title: `Output: ${textTitle(entry.text)}`, tone: 'plain', tookS: null });
        break;
    }
  });
  return steps;
}

/** The two entries that say what the AI was given. */
export function givenOf(entries: Entry[]): {
  sent: Extract<Entry, { type: 'sent' }> | null;
  init: Extract<Entry, { type: 'init' }> | null;
  messages: Extract<Entry, { type: 'sent' }>[];
} {
  const sents = entries.filter((e): e is Extract<Entry, { type: 'sent' }> => e.type === 'sent');
  return {
    sent: sents[0] ?? null,
    init: entries.find((e): e is Extract<Entry, { type: 'init' }> => e.type === 'init') ?? null,
    messages: sents.slice(1),
  };
}

/** Skills and subagents a run used, read from its tool calls (a skill or a subagent is a step of its own). */
export function usedSkills(entries: Entry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'tool') continue;
    const input = obj(e.input);
    if (e.name === 'Skill') out.add(str(input.skill) || str(input.name));
    else if (e.name === 'Task' || e.name === 'Agent') out.add(str(input.subagent_type));
  }
  out.delete('');
  return [...out];
}

/** The text of a "who" cell: the member name, or the id when the member is gone. */
export const whoOf = (r: Pick<HistoryRow, 'memberName' | 'memberId'>) => r.memberName ?? r.memberId;

/** A run's end in words: "Finished", or "Failed · Board fault" when the board concluded a cause. */
export function endWords(r: Pick<HistoryRow, 'state' | 'diagnosis' | 'endedReason'>): {
  label: string;
  why: string | null;
} {
  const label = END_LOOK[r.state]?.label ?? r.state;
  if (r.diagnosis?.boardFault) return { label, why: 'Board fault' };
  return { label, why: r.state === 'finished' ? null : r.endedReason };
}
