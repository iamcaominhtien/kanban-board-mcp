/** @AI in Docs comment threads (docs-ai-care E): who the @ picker offers, what a mention means, what a thread shows.
 * Pure, so it is tested. */
import type { DocsCommentItem, DocsCommentMember, DocsCommentThread } from '../types/docs';

export type DocsMentionIntent = 'ask' | 'suggest' | 'notify';

export interface MentionRow {
  id: string;
  name: string;
  color: string;
  group?: 'People' | 'AI';
  kind: 'human' | 'ai';
  /** AI rows: whether it can be asked now, and its status in words. */
  usable: boolean;
  status?: string;
  note?: string;
  tone?: 'ok' | 'warn' | 'off';
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'off' }> = {
  ready: { label: 'Ready', tone: 'ok' },
  paused: { label: 'Paused', tone: 'warn' },
  over_budget: { label: 'Over budget', tone: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'off' },
};

/**
 * Rows of the @ list in a Docs comment: people, then (only while Docs AI is on) the AI members in an "AI" group,
 * usable ones first. With Docs AI off an AI member is not offered at all (a mention would only notify).
 */
export function mentionRows(members: DocsCommentMember[], docsAi: boolean): MentionRow[] {
  const people = members.filter((m) => (m.kind ?? 'human') === 'human');
  const ai = docsAi ? members.filter((m) => m.kind === 'ai' && m.ai) : [];
  const grouped = ai.length > 0;
  const rows: MentionRow[] = people.map((m) => ({
    id: m.id,
    name: m.name,
    color: m.color,
    kind: 'human',
    usable: true,
    ...(grouped ? { group: 'People' as const } : {}),
  }));
  const aiRows: MentionRow[] = ai.map((m) => {
    const st = STATUS[m.ai!.status] ?? STATUS.unavailable;
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      kind: 'ai',
      group: 'AI',
      usable: m.ai!.usable,
      status: st.label,
      note: m.ai!.note,
      tone: st.tone,
    };
  });
  aiRows.sort((a, b) => Number(b.usable) - Number(a.usable));
  return [...rows, ...aiRows];
}

const LINK = /@\[([^\][\n]{1,200})\]\(member:([\w.-]{1,64})\)/g;

/** AI members a comment mentions (the picker's `@[Name](member:id)` or a typed `@Name`), in order. */
export function mentionedAi(text: string, members: DocsCommentMember[]): DocsCommentMember[] {
  const ai = members.filter((m) => m.kind === 'ai');
  const out: DocsCommentMember[] = [];
  for (const m of text.matchAll(LINK)) {
    const hit = ai.find((a) => a.id === m[2]);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  const plain = text.replace(LINK, (_s, name: string) => `@${name}`).toLowerCase();
  for (const a of [...ai].sort((x, y) => y.name.length - x.name.length)) {
    const at = plain.indexOf(`@${a.name.toLowerCase()}`);
    if (at < 0 || out.includes(a)) continue;
    const after = plain[at + a.name.length + 1];
    if (after === undefined || !/\w/.test(after)) out.push(a);
  }
  return out;
}

/** The meaning sent to the server: the ticket dialog's "Do the work" is "Suggest an edit" in Docs. */
export function serverIntent(intent: 'ask' | 'work' | 'suggest' | 'notify'): DocsMentionIntent {
  return intent === 'work' ? 'suggest' : intent;
}

/** What an AI reply is: an answer, a note (paused, over budget, hidden page), an error, or a proposal made. */
export function aiReplyKind(c: DocsCommentItem): 'answer' | 'note' | 'error' | 'proposal' | null {
  if (!c.ai) return null;
  return c.ai.kind ?? 'answer';
}

/** "Suggest an edit" shows on an AI answer that says the page is wrong, while the thread is open. */
export function canSuggestEdit(c: DocsCommentItem, thread: DocsCommentThread, docsAi: boolean): boolean {
  return (
    docsAi &&
    thread.canReply &&
    thread.status === 'open' &&
    aiReplyKind(c) === 'answer' &&
    !!c.ai?.canSuggest &&
    !(thread.aiJobs ?? []).some((j) => j.kind === 'suggest_edit')
  );
}

/** Names of the AI members working in the thread now (the "thinking" placeholder). */
export function thinking(thread: DocsCommentThread): { name: string; kind: string; step: string | null }[] {
  return (thread.aiJobs ?? [])
    .filter((j) => j.kind !== 'thread_summary')
    .map((j) => ({ name: j.memberName, kind: j.kind, step: j.step }));
}

export const SUMMARY_MIN = 4;

/** "Summarise" is offered on an open thread of four comments or more, unless a summary is fresh or on its way. */
export function canSummarise(thread: DocsCommentThread, docsAi: boolean): boolean {
  if (!docsAi || !thread.canReply || thread.comments.length < SUMMARY_MIN) return false;
  if ((thread.aiJobs ?? []).some((j) => j.kind === 'thread_summary')) return false;
  return !thread.aiSummary || thread.aiSummary.count < thread.comments.length;
}

/** Keep polling the comments while an AI member works in one of the threads. */
export function aiBusy(threads: DocsCommentThread[] | undefined): boolean {
  return !!threads?.some((t) => (t.aiJobs ?? []).length > 0);
}

/** "AI · $0.004" for an AI answer's cost (local runners cost nothing). */
export function aiCostLabel(cost: number | undefined): string {
  if (!cost) return 'AI';
  return `AI · $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
}
