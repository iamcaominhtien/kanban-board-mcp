import type { LiveFeedItem } from '../../../api/aiLiveFeed';

/** A line as the feed shows it: a command's result folded into the command's own line. */
export interface FeedLine extends LiveFeedItem {
  result: { text: string; tone: LiveFeedItem['tone'] } | null;
  /** A fold of dense commands (kind `fold`): the lines it stands for. */
  folded?: FeedLine[];
}

/** Where a feed line came from: its AI and its ticket light up in the drawing, and the other way round. */
export interface LitMark {
  memberId: string | null;
  ticketId: string | null;
}

/** Highlights (the default) or Everything (every command, read and edit: the feed of main). */
export type FeedDetail = 'highlights' | 'everything';

/** Consecutive lines of one AI on one ticket, shown like a chat: the name once, the lines under it. */
export interface FeedGroup {
  key: string;
  speaker: string;
  memberId: string | null;
  memberName: string;
  glyph: string | null;
  color: string | null;
  roleLabel: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  lines: FeedLine[];
}

export interface FeedFilter {
  /** A speaker key (see `speakerOf`), or null for everyone. */
  speaker: string | null;
  ticketId: string | null;
}

/** Lines further apart than this start a new group even from the same AI on the same ticket. */
export const GROUP_GAP_MS = 5 * 60_000;

/** Who said it: the member, or the board itself (no member). */
export const speakerOf = (i: Pick<LiveFeedItem, 'memberId' | 'memberName'>) => i.memberId ?? `name:${i.memberName}`;

/** The part of a result line after its command ("`npm test` — 12 passed" → "12 passed"). */
export function resultSuffix(text: string): string {
  const at = text.indexOf(' — ');
  return at >= 0 ? text.slice(at + 3) : text;
}

/** A line Highlights keeps. An older server sends no flag: every line counts then. */
export const isHighlight = (i: Pick<LiveFeedItem, 'highlight'>) => i.highlight !== false;

/** The lines to show: results folded into their command's line, then the filter (and Highlights, when asked). */
export function toLines(items: LiveFeedItem[], filter: FeedFilter, detail: FeedDetail = 'everything'): FeedLine[] {
  const byId = new Map<string, FeedLine>();
  const out: FeedLine[] = [];
  for (const i of items) {
    if (i.kind === 'result' && i.ref && byId.has(i.ref)) {
      const parent = byId.get(i.ref)!;
      parent.result = { text: resultSuffix(i.text), tone: i.tone };
      continue;
    }
    const line: FeedLine = { ...i, result: null };
    byId.set(i.id, line);
    out.push(line);
  }
  return out.filter(
    (l) =>
      (filter.speaker == null || speakerOf(l) === filter.speaker) &&
      (filter.ticketId == null || l.ticketId === filter.ticketId) &&
      (detail === 'everything' || isHighlight(l)),
  );
}

/** More than this many commands by one AI in a minute fold into one line (design K, 6). */
export const FOLD_OVER = 5;
export const FOLD_WINDOW_MS = 60_000;

/** "Ran `npm test`" → "npm test". */
const commandOf = (text: string) => text.replace(/^Ran\s+/, '').replace(/`/g, '');

/**
 * Dense events fold: more than five commands in a row by one AI on one ticket within a minute become one line that
 * opens. Its summary counts what passed and failed, and names a single failure so folding never hides it.
 */
export function foldDense(lines: FeedLine[]): FeedLine[] {
  const out: FeedLine[] = [];
  let run: FeedLine[] = [];
  const flush = () => {
    if (run.length > FOLD_OVER) {
      const first = run[0];
      const last = run[run.length - 1];
      const failed = run.filter((l) => (l.result?.tone ?? l.tone) === 'bad');
      const passed = run.filter((l) => (l.result?.tone ?? l.tone) === 'good').length;
      const mins = Math.max(1, Math.round((Date.parse(last.at) - Date.parse(first.at)) / 60_000));
      const bits = [passed ? `${passed} passed` : '', failed.length ? `${failed.length} failed` : ''].filter(Boolean);
      const named = failed.length === 1 ? `: ${commandOf(failed[0].text)}` : '';
      out.push({
        ...last,
        id: `fold:${first.id}`,
        at: last.at,
        kind: 'fold',
        text: `Ran ${run.length} commands in ${mins} min`,
        tone: failed.length ? 'bad' : passed ? 'good' : 'info',
        ref: null,
        result: bits.length ? { text: `${bits.join(', ')}${named}`, tone: failed.length ? 'bad' : 'good' } : null,
        folded: run,
      });
    } else out.push(...run);
    run = [];
  };
  for (const l of lines) {
    const head = run[0];
    if (
      l.kind === 'command' &&
      head &&
      speakerOf(head) === speakerOf(l) &&
      head.ticketId === l.ticketId &&
      Date.parse(l.at) - Date.parse(head.at) <= FOLD_WINDOW_MS
    ) {
      run.push(l);
      continue;
    }
    flush();
    if (l.kind === 'command') run = [l];
    else out.push(l);
  }
  flush();
  return out;
}

/** How many lines each AI has, for the counts on the chips ("Dev · 2"). */
export function linesBySpeaker(lines: FeedLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(speakerOf(l), (out.get(speakerOf(l)) ?? 0) + (l.folded?.length ?? 1));
  return out;
}

/** Lines grouped like a chat. */
export function toGroups(lines: FeedLine[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    const prev = last?.lines[last.lines.length - 1];
    if (
      last &&
      prev &&
      last.speaker === speakerOf(l) &&
      last.ticketId === l.ticketId &&
      Date.parse(l.at) - Date.parse(prev.at) <= GROUP_GAP_MS
    ) {
      last.lines.push(l);
      continue;
    }
    groups.push({
      key: l.id,
      speaker: speakerOf(l),
      memberId: l.memberId,
      memberName: l.memberName,
      glyph: l.glyph,
      color: l.color,
      roleLabel: l.roleLabel,
      ticketId: l.ticketId,
      ticketTitle: l.ticketTitle,
      lines: [l],
    });
  }
  return groups;
}

/** "now", "12s", "4m", "2h", "3d": how long ago, short like a live chat. */
export function relTime(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (Number.isNaN(s)) return '';
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The clock time of a line, for its tooltip. */
export function clockOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Text with `code` spans split out. */
export function codeParts(text: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

/** The AIs (and the board) that spoke, newest speaker first, for the filter chips. */
export function speakersIn(items: LiveFeedItem[]) {
  const seen = new Map<
    string,
    { key: string; name: string; color: string | null; glyph: string | null; board: boolean }
  >();
  for (let n = items.length - 1; n >= 0; n--) {
    const i = items[n];
    const key = speakerOf(i);
    if (!seen.has(key))
      seen.set(key, { key, name: i.memberName, color: i.color, glyph: i.glyph, board: i.memberId == null });
  }
  return [...seen.values()];
}

/** The tickets the feed talks about, newest first. */
export function ticketsIn(items: LiveFeedItem[]) {
  const seen = new Map<string, string | null>();
  for (let n = items.length - 1; n >= 0; n--) {
    const i = items[n];
    if (i.ticketId && !seen.has(i.ticketId)) seen.set(i.ticketId, i.ticketTitle);
  }
  return [...seen.entries()].map(([id, title]) => ({ id, title }));
}
