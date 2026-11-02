/**
 * AIs talking to each other (ai-story-flow P): which comments are only between AI members, how a run of them folds
 * into one line, and what the line says. Anything addressed to a person, a Board note and every question stays open.
 */
import type { AiRun } from '../../../types/ai';
import type { Comment } from '../../../types/ticket';

/** Who is an AI member: by member id, and by the name a comment is written under. */
export interface AiLookup {
  isAiId: (id: string) => boolean;
  isAiAuthor: (author: string) => boolean;
  nameOf: (id: string) => string;
}

/** AI comments that speak to a person or to the board, never folded. */
const OPEN_KINDS = new Set(['answer', 'summary', 'failed', 'ask_failed', 'move_blocked', 'chat_answer']);

/** An AI member's comment whose mentions are all AI members: one AI speaking to another. */
export function isAiToAi(c: Comment, ai: AiLookup): boolean {
  if (c.boardNote || c.answerToRun || c.askedAi) return false;
  if (c.ai && OPEN_KINDS.has(c.ai.kind)) return false;
  if (!ai.isAiAuthor(c.author)) return false;
  const mentions = c.mentions ?? [];
  return mentions.length > 0 && mentions.every(ai.isAiId);
}

/** An AI's plain note to the ticket (no mention) right after the talk: it closes the exchange and folds with it. */
function closesTalk(c: Comment, ai: AiLookup, authors: Set<string>): boolean {
  if (c.boardNote || c.answerToRun || c.askedAi) return false;
  if (c.ai && OPEN_KINDS.has(c.ai.kind)) return false;
  return (c.mentions ?? []).length === 0 && ai.isAiAuthor(c.author) && authors.has(c.author);
}

/** A run of comments between AIs, folded into one line. */
export interface TalkRun {
  /** The ids of the comments in the run, oldest first. */
  ids: string[];
  comments: Comment[];
  /** The AI members in it, by name, in the order they first speak or are spoken to. */
  names: string[];
  first: string;
  last: string;
}

/** Runs of two or more comments between AIs, in the order of the comments (which are oldest first). */
export function talkRuns(comments: Comment[], ai: AiLookup, min = 2): TalkRun[] {
  const out: TalkRun[] = [];
  let cur: Comment[] = [];
  let authors = new Set<string>();
  const flush = () => {
    if (cur.length >= min) {
      const names: string[] = [];
      const add = (n: string) => {
        if (n && !names.includes(n)) names.push(n);
      };
      for (const c of cur) {
        add(c.author);
        (c.mentions ?? []).forEach((id) => add(ai.nameOf(id)));
      }
      out.push({ ids: cur.map((c) => c.id), comments: cur, names, first: cur[0].at, last: cur[cur.length - 1].at });
    }
    cur = [];
    authors = new Set();
  };
  for (const c of comments) {
    if (isAiToAi(c, ai)) {
      cur.push(c);
      authors.add(c.author);
    } else if (cur.length > 0 && closesTalk(c, ai, authors)) {
      cur.push(c);
      flush();
    } else flush();
  }
  flush();
  return out;
}

/** "Dev Khoa and Reviewer Binh", "PM Linh, Dev Khoa and Reviewer Binh". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'The AIs';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "to Reviewer Binh", "to Dev Khoa and PM Linh", "to the ticket". */
export function addressedTo(c: Comment, ai: AiLookup): string {
  const ids = c.mentions ?? [];
  return ids.length ? `to ${namesList(ids.map(ai.nameOf))}` : 'to the ticket';
}

const GRACE_MS = 60_000;

/** The hand-offs between AIs while they talked: runs started by a hand-off inside the run's time. */
export function handoffsIn(run: TalkRun, runs: AiRun[]): AiRun[] {
  const from = Date.parse(run.first) - GRACE_MS;
  const to = Date.parse(run.last) + GRACE_MS;
  return runs
    .filter((r) => r.trigger === 'handoff')
    .filter((r) => {
      const t = Date.parse(r.queuedAt);
      return t >= from && t <= to;
    })
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/** The longest mention chain behind the talk: who started it, each hop, and its depth. */
export function chainOf(run: TalkRun, runs: AiRun[], ai: AiLookup): { path: string[]; depth: number } | null {
  const from = Date.parse(run.first) - GRACE_MS;
  const to = Date.parse(run.last) + GRACE_MS;
  const inside = runs.filter((r) => {
    const t = Date.parse(r.queuedAt);
    return t >= from && t <= to && (r.chain ?? []).length > 0;
  });
  const best = inside.sort((a, b) => b.chain.length - a.chain.length)[0];
  if (!best) return null;
  const path = [...best.chain.map(ai.nameOf), best.memberName ?? ai.nameOf(best.memberId)];
  return { path, depth: best.chain.length };
}

/** "12:51" in local time. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The comment text that joins in: a mention of each AI, then what the person wrote. */
export function joinText(members: { id: string; name: string }[], text: string): string {
  return `${members.map((m) => `@[${m.name}](member:${m.id})`).join(' ')} ${text.trim()}`;
}
