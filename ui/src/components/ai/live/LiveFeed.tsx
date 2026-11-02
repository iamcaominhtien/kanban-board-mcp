import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { aiOpsApi, deliveredWords } from '../../../api/aiOps';
import { safetyApi } from '../../../api/aiSafety';
import { extractError } from '../../../api/extractError';
import { useLiveFeed, type FeedScope, type LiveFeedItem } from '../../../api/aiLiveFeed';
import type { LiveRun, NeedsItem } from '../../../types/aiTeam';
import { AI_GLYPHS, GlyphIcon } from '../aiUi';
import {
  clockOf,
  codeParts,
  foldDense,
  linesBySpeaker,
  relTime,
  speakersIn,
  toGroups,
  toLines,
  type FeedDetail,
  type FeedFilter,
  type FeedGroup,
  type FeedLine,
  type LitMark,
} from './liveFeedModel';
import './liveFeed.css';

/** What the Flow tab tells the feed: its scope, the runs going on, and the link to the drawing (design K). */
export interface FeedLinks {
  /** The scope bar's scope: the feed shows only the lines in it. */
  scope?: FeedScope;
  /** The scope line (not a button): which Story or ticket the column follows. */
  scopeLabel?: { kind: 'story' | 'ticket'; id: string; title: string | null } | null;
  /** The runs going on, to tell the AI that is working on a line. */
  liveRuns?: LiveRun[];
  /** What is hovered in the drawing: its lines light up. */
  lit?: LitMark | null;
  /** A line is hovered: light up the box, arrow or bar it came from. */
  onHoverLine?: (m: LitMark | null) => void;
  /** A line is clicked: open its run. */
  onOpenRun?: (runId: string) => void;
  onOpenDocsPage?: (pageId: string) => void;
  /** An empty ticket scope offers the Story it is in. */
  onShowStory?: () => void;
  /** The tickets an empty ticket waits for ("It waits for KAN-305."). */
  waitsFor?: string[];
}

const DETAIL_KEY = 'kanban.ai.liveFeed.detail';

function readDetail(): FeedDetail {
  try {
    return window.localStorage.getItem(DETAIL_KEY) === 'everything' ? 'everything' : 'highlights';
  } catch {
    return 'highlights';
  }
}

const COLLAPSED_KEY = 'kanban.ai.liveFeed.collapsed';
const GREY = '#5B6B60';
/** How close to the bottom still counts as "at the live edge". */
const LIVE_EDGE_PX = 28;

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    /* a private window: the panel just forgets */
  }
}

function reducedMotion(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const raw = words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
  return raw.toUpperCase() || '?';
}

/** The speaker's square: its glyph in its colour, or the board's own mark. */
export function FeedAvatar({
  name,
  glyph,
  color,
  board,
  size = 30,
}: {
  name: string;
  glyph: string | null;
  color: string | null;
  board?: boolean;
  size?: number;
}) {
  if (board)
    return (
      <span className="lf-av lf-av-board" style={{ width: size, height: size }} title="Board" aria-hidden="true">
        <svg
          width={size * 0.5}
          height={size * 0.5}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        >
          <rect x="3.5" y="4" width="5" height="16" rx="1.5" />
          <rect x="9.5" y="4" width="5" height="10" rx="1.5" />
          <rect x="15.5" y="4" width="5" height="13" rx="1.5" />
        </svg>
      </span>
    );
  const tint = color || GREY;
  return (
    <span
      className="lf-av"
      aria-hidden="true"
      title={name}
      style={{ width: size, height: size, color: tint, background: `${tint}1f`, borderColor: `${tint}66` }}
    >
      {glyph && AI_GLYPHS[glyph] ? (
        <GlyphIcon glyph={glyph} size={Math.round(size * 0.52)} />
      ) : (
        <span className="lf-av-txt">{initials(name)}</span>
      )}
    </span>
  );
}

function Rich({ text }: { text: string }) {
  return (
    <>
      {codeParts(text).map((p, n) =>
        p.code ? (
          <code key={n} className="lf-code">
            {p.text}
          </code>
        ) : (
          <span key={n}>{p.text}</span>
        ),
      )}
    </>
  );
}

function IconBtn({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`lf-ibtn${pressed ? ' on' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/** The run a line came from: the server says it; a run's own lines carry its id before the first colon. */
export function runOf(line: Pick<LiveFeedItem, 'id' | 'runId'>, known: Set<string>): string | null {
  if (line.runId) return line.runId;
  const head = line.id.split(':')[0];
  return known.has(head) ? head : null;
}

function Line({
  line,
  now,
  fresh,
  onOpenRun,
}: {
  line: FeedLine;
  now: number;
  fresh: boolean;
  onOpenRun?: (line: FeedLine) => void;
}) {
  const [open, setOpen] = useState(false);
  // a command's line takes its result's colour once the result is in
  const tone = line.result && line.tone === 'info' ? line.result.tone : line.tone;
  if (line.folded) {
    return (
      <li className="lf-fold-wrap" data-kind="fold">
        <button
          type="button"
          className={`lf-fold lf-t-${tone}`}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid="live-feed-fold"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            aria-hidden="true"
          >
            <path d={open ? 'M6 9L12 15L18 9' : 'M9 6L15 12L9 18'} />
          </svg>
          <span className="lf-text">
            <b>{line.text}</b>
            {line.result ? <span className={`lf-res lf-t-${line.result.tone}`}> {line.result.text}</span> : null}
          </span>
          <time className="lf-time" dateTime={line.at}>
            {relTime(line.at, now)}
          </time>
        </button>
        {open && (
          <ul className="lf-lines lf-fold-lines">
            {line.folded.map((l) => (
              <Line key={l.id} line={l} now={now} fresh={false} onOpenRun={onOpenRun} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li
      className={`lf-line lf-t-${tone}${fresh ? ' lf-in' : ''}${onOpenRun ? ' lf-click' : ''}`}
      data-kind={line.kind}
      title={clockOf(line.at)}
      onClick={onOpenRun ? () => onOpenRun(line) : undefined}
    >
      <span className="lf-mark" aria-hidden="true" />
      <span className="lf-text">
        <Rich text={line.text} />
        {line.result ? (
          <span className={`lf-res lf-t-${line.result.tone}`}>
            {' — '}
            {line.result.text}
          </span>
        ) : null}
      </span>
      <time className="lf-time" dateTime={line.at}>
        {relTime(line.at, now)}
      </time>
    </li>
  );
}

/** "Tell Dev Khoa, who is working on KAN-305": a sentence for the running AI, through Tell the AI (ai_ops.py). */
function TellBox({ g, runId }: { g: FeedGroup; runId: string | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const tell = useMutation({ mutationFn: (v: { runId: string; text: string }) => aiOpsApi.tell(v.runId, v.text) });
  const role = g.roleLabel?.split(' ')[0] ?? g.memberName.split(' ')[0];
  if (!runId) {
    return (
      <div className="lf-tell off" data-testid="live-feed-tell-off">
        {g.memberName} is not running now: nothing to tell it.
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" className="lf-tell-btn" onClick={() => setOpen(true)} data-testid="live-feed-tell-open">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M21 3L10 14M21 3L14.5 21L10 14L3 9.5Z" strokeLinejoin="round" />
        </svg>
        Tell {g.memberName}
        {g.ticketId ? `, who is working on ${g.ticketId}` : ''}
      </button>
    );
  }
  const send = () => {
    const t = text.trim();
    if (!t) return;
    tell.mutate(
      { runId, text: t },
      {
        onSuccess: (r) => {
          setText('');
          setSaid(
            r?.delivered ? deliveredWords(r.delivered) : `Sent to the running run. ${role} reads it at its next step.`,
          );
        },
        onError: (e) => setSaid(extractError(e)),
      },
    );
  };
  return (
    <div className="lf-tell" data-testid="live-feed-tell" onClick={(e) => e.stopPropagation()}>
      <div className="lf-tell-h">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M21 3L10 14M21 3L14.5 21L10 14L3 9.5Z" strokeLinejoin="round" />
        </svg>
        Tell {g.memberName}
        {g.ticketId ? `, who is working on ${g.ticketId}` : ''}
      </div>
      <textarea
        autoFocus
        rows={2}
        value={text}
        aria-label={`Tell ${g.memberName}`}
        placeholder="What should it know?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <div className="lf-tell-foot">
        <span>{said ?? `Sent to the running run. ${role} reads it at its next step.`}</span>
        <button
          type="button"
          className="st-btn st-btn-sm st-btn-primary"
          disabled={!text.trim() || tell.isPending}
          onClick={send}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Group({
  g,
  now,
  fresh,
  onOpenTicket,
  lit,
  links,
  runId,
  onOpenRun,
}: {
  g: FeedGroup;
  now: number;
  fresh: Set<string>;
  onOpenTicket?: (id: string) => void;
  lit?: boolean;
  /** Set when the column is joined to the drawing. */
  links?: FeedLinks;
  /** The run of this AI going on now (null: it is not running). */
  runId?: string | null;
  onOpenRun?: (line: FeedLine) => void;
}) {
  const [hover, setHover] = useState(false);
  const [telling, setTelling] = useState(false);
  const board = g.memberId == null;
  const tint = board ? GREY : g.color || GREY;
  const joined = !!links?.onHoverLine;
  return (
    <li
      className={`lf-group${fresh.has(g.lines[0].id) ? ' lf-in' : ''}${lit ? ' lf-lit' : ''}`}
      data-speaker={g.speaker}
      onMouseEnter={() => {
        setHover(true);
        links?.onHoverLine?.({ memberId: g.memberId, ticketId: g.ticketId });
      }}
      onMouseLeave={() => {
        setHover(false);
        links?.onHoverLine?.(null);
      }}
      onFocus={() => setTelling(true)}
    >
      <FeedAvatar name={g.memberName} glyph={g.glyph} color={g.color} board={board} />
      <div className="lf-body">
        <div className="lf-head">
          <span className="lf-name" style={{ color: board ? undefined : tint }}>
            {g.memberName}
          </span>
          {g.roleLabel ? (
            <span className="lf-role" style={{ color: tint, background: `${tint}17`, borderColor: `${tint}38` }}>
              {g.roleLabel}
            </span>
          ) : null}
          {g.ticketId ? (
            <button
              type="button"
              className="lf-tkt"
              onClick={() => onOpenTicket?.(g.ticketId!)}
              title={g.ticketTitle ? `${g.ticketId} · ${g.ticketTitle}` : `Open ${g.ticketId}`}
            >
              {g.ticketId}
            </button>
          ) : null}
        </div>
        <ul className="lf-lines">
          {g.lines.map((l) => (
            <Line
              key={l.id}
              line={l}
              now={now}
              fresh={fresh.has(l.id) && l.id !== g.lines[0].id}
              onOpenRun={onOpenRun}
            />
          ))}
        </ul>
        {joined && hover && !board ? (
          <div className="lf-linkhint" aria-hidden="true">
            Lit up on the map and the timeline{onOpenRun ? ' · click to open the run' : ''}
          </div>
        ) : null}
        {links && !board && (hover || telling) ? <TellBox g={g} runId={runId ?? null} /> : null}
      </div>
    </li>
  );
}

/** What a Needs you row says, and its answer button (the same rows as the Now tab's Needs you). */
function NeedRow({
  item,
  onOpenTicket,
  onOpenDocsPage,
}: {
  item: NeedsItem;
  onOpenTicket?: (id: string) => void;
  onOpenDocsPage?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: async (v: { id: string; approve: boolean }) => {
      if (!v.approve) return safetyApi.deny(v.id);
      const out = await safetyApi.approve(v.id);
      if (out.error) throw new Error(out.error);
      return out;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai'] });
    },
    onError: (e) => setErr(extractError(e)),
  });
  const who = item.memberName ?? 'An AI';
  const wait = item.waitingS != null ? `waiting ${fmtWait(item.waitingS)}` : '';
  const ticket = item.ticketId ?? null;
  let title: string;
  let buttons: ReactNode = null;
  const openTicket = ticket ? (
    <button type="button" className="st-btn st-btn-sm" onClick={() => onOpenTicket?.(ticket)}>
      Open ticket
    </button>
  ) : null;
  switch (item.kind) {
    case 'question':
      title = item.text || `${who} asks a question`;
      buttons = (
        <>
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            onClick={() => ticket && onOpenTicket?.(ticket)}
          >
            Answer
          </button>
          {openTicket}
        </>
      );
      break;
    case 'approval':
      title = `${who} asks to ${item.actionLabel.toLowerCase()}`;
      buttons = (
        <>
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: item.approvalId, approve: true })}
          >
            Allow
          </button>
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: item.approvalId, approve: false })}
          >
            Deny
          </button>
        </>
      );
      break;
    case 'docs_proposal':
      title = `${item.changes} change${item.changes === 1 ? '' : 's'} proposed to ${item.pageTitle ?? 'a page'}`;
      buttons = (
        <button type="button" className="st-btn st-btn-sm" onClick={() => onOpenDocsPage?.(item.pageId)}>
          Review changes
        </button>
      );
      break;
    case 'canvas_proposal':
      title = `${item.changes} change${item.changes === 1 ? '' : 's'} proposed to ${item.canvasTitle ?? 'a canvas'}`;
      buttons = item.pageId ? (
        <button type="button" className="st-btn st-btn-sm" onClick={() => onOpenDocsPage?.(item.pageId!)}>
          Review changes
        </button>
      ) : (
        openTicket
      );
      break;
    case 'offline':
      title = `${who} is offline: ${item.label}`;
      buttons = openTicket;
      break;
    case 'memory_stop':
      title = `${who}’s run was stopped: memory`;
      buttons = openTicket;
      break;
  }
  return (
    <div className="lf-need" data-testid={`live-feed-need-${item.kind}`}>
      <FeedAvatar name={who} glyph={null} color={null} size={24} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="lf-need-t">{title}</div>
        <div className="lf-need-sub">{[who, ticket, wait].filter(Boolean).join(' · ')}</div>
        {err ? <div className="lf-need-err">{err}</div> : null}
        <div className="lf-need-acts">{buttons}</div>
      </div>
    </div>
  );
}

function fmtWait(s: number): string {
  if (s < 60) return 'under a minute';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** Needs you, pinned at the top of the column whatever the scroll (design K, 5). */
function NeedsYou({
  items,
  onOpenTicket,
  onOpenDocsPage,
}: {
  items: NeedsItem[];
  onOpenTicket?: (id: string) => void;
  onOpenDocsPage?: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="lf-needs" aria-label="Needs you" data-testid="live-feed-needs">
      <div className="lf-needs-h">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2 6-5 6-3 0-4-1.5-5.5-4L4 12a1.5 1.5 0 0 1 2.5-1.5L8 12" />
        </svg>
        <b>Needs you</b>
        <span className="lf-needs-n">{items.length}</span>
      </div>
      {items.map((it, k) => (
        <NeedRow
          key={`${it.kind}-${it.memberId}-${it.ticketId ?? ''}-${k}`}
          item={it}
          onOpenTicket={onOpenTicket}
          onOpenDocsPage={onOpenDocsPage}
        />
      ))}
    </section>
  );
}

/**
 * AI Team › Flow › Live commentary: what each AI is doing right now, as a live chat. Newest at the bottom; it follows
 * the live edge until the person scrolls up, then counts what came in ("3 new · Jump to live").
 */
export function LiveFeed({
  projectId,
  onOpenTicket,
  links,
}: {
  projectId: string;
  onOpenTicket?: (ticketId: string) => void;
  /** Flow's scope and the link to its drawing (design K). Without it the column is the feed of main. */
  links?: FeedLinks;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [detail, setDetail] = useState<FeedDetail>(readDetail);
  const [paused, setPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedFilter>({ speaker: null, ticketId: null });
  const [atEdge, setAtEdge] = useState(true);
  const [seenId, setSeenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const known = useRef<Set<string> | null>(null);
  // the newest line the person had seen when the rail was folded; what came after is "unread"
  const [baseId, setBaseId] = useState<string | null | undefined>(undefined);
  const [chipEdges, setChipEdges] = useState({ start: false, end: false });
  const chipsRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scope = links?.scope;
  const q = useLiveFeed(projectId, { scope: { story: scope?.story ?? null, ticket: scope?.ticket ?? null } });
  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const working = useMemo(() => q.data?.working ?? [], [q.data]);
  const needs = useMemo(() => q.data?.needsYou ?? [], [q.data]);
  // a new scope is a new feed: the filter of the old one would hide it
  const scopeKey = `${scope?.story ?? ''}|${scope?.ticket ?? ''}`;
  const [seenScope, setSeenScope] = useState(scopeKey);
  if (seenScope !== scopeKey) {
    setSeenScope(scopeKey);
    setFilter({ speaker: null, ticketId: null });
  }

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  // lines that arrive after the first load slide in; the first load is already there
  useEffect(() => {
    if (!q.data) return;
    if (known.current == null) {
      known.current = new Set(all.map((i) => i.id));
      return;
    }
    const born = all.filter((i) => !known.current!.has(i.id)).map((i) => i.id);
    if (!born.length) return;
    born.forEach((id) => known.current!.add(id));
    setNow(Date.now());
    setFresh(new Set(born));
    const t = window.setTimeout(() => setFresh(new Set()), 900);
    return () => window.clearTimeout(t);
  }, [all, q.data]);

  // paused: the feed holds still at the last line it showed
  const held = useMemo(() => {
    if (!paused || !pausedAt) return all;
    const at = all.findIndex((i) => i.id === pausedAt);
    return at >= 0 ? all.slice(0, at + 1) : all;
  }, [all, paused, pausedAt]);
  const lines = useMemo(() => foldDense(toLines(held, filter, detail)), [held, filter, detail]);
  const groups = useMemo(() => toGroups(lines), [lines]);
  const allLines = useMemo(() => foldDense(toLines(all, filter, detail)), [all, filter, detail]);
  const counts = useMemo(() => linesBySpeaker(toLines(all, { speaker: null, ticketId: null }, detail)), [all, detail]);
  // the runs going on now: to tell the AI of a line, and to open the run a line came from
  const runs = useMemo(() => links?.liveRuns ?? [], [links?.liveRuns]);
  const knownRuns = useMemo(() => new Set(runs.map((r) => r.runId)), [runs]);
  const runFor = (g: FeedGroup): string | null => {
    if (!g.memberId) return null;
    const mine = runs.filter((r) => r.memberId === g.memberId && r.state !== 'queued');
    const hit = mine.find((r) => r.ticketId === g.ticketId) ?? (g.ticketId ? null : mine[0]);
    if (hit) return hit.runId;
    // the server says which run a line is from; trust it while the AI is working
    if (!working.includes(g.memberId)) return null;
    const last = [...g.lines].reverse().find((l) => l.runId);
    return last?.runId ?? null;
  };
  const openRunOf = links?.onOpenRun
    ? (l: FeedLine) => {
        const id = runOf(l.folded?.[0] ?? l, knownRuns);
        if (id) links.onOpenRun!(id);
        else if (l.ticketId) onOpenTicket?.(l.ticketId);
      }
    : undefined;
  const isLit = (g: FeedGroup) =>
    !!links?.lit?.memberId &&
    links.lit.memberId === g.memberId &&
    (!links.lit.ticketId || !g.ticketId || links.lit.ticketId === g.ticketId);
  const chooseDetail = (d: FeedDetail) => {
    setDetail(d);
    try {
      window.localStorage.setItem(DETAIL_KEY, d);
    } catch {
      /* a private window: the choice is not kept */
    }
  };
  const lastId = lines.length ? lines[lines.length - 1].id : null;

  const heldBack = paused ? Math.max(0, allLines.length - lines.length) : 0;
  const unseen = useMemo(() => {
    if (atEdge || !seenId) return 0;
    const at = lines.findIndex((l) => l.id === seenId);
    return at >= 0 ? lines.length - at - 1 : 0;
  }, [atEdge, seenId, lines]);

  // at the live edge: follow it
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !atEdge) return;
    el.scrollTop = el.scrollHeight;
    setSeenId(lastId);
  }, [lastId, atEdge, collapsed]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const edge = el.scrollHeight - el.scrollTop - el.clientHeight <= LIVE_EDGE_PX;
    if (edge !== atEdge) setAtEdge(edge);
    if (edge) setSeenId(lastId);
  };

  const jumpToLive = () => {
    const el = scroller.current;
    if (paused) {
      setPaused(false);
      setPausedAt(null);
    }
    setAtEdge(true);
    if (el?.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
    else if (el) el.scrollTop = el.scrollHeight;
  };

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setPausedAt(null);
    } else {
      setPaused(true);
      setPausedAt(all.length ? all[all.length - 1].id : null);
    }
  };

  const toggleCollapsed = () => {
    setBaseId(!collapsed && all.length ? all[all.length - 1].id : null);
    writeCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };

  // a rail restored from storage: whatever is there on the first load counts as seen
  useEffect(() => {
    if (collapsed && baseId === undefined && q.data) setBaseId(all.length ? all[all.length - 1].id : null);
  }, [collapsed, baseId, q.data, all]);

  const speakers = useMemo(() => speakersIn(all), [all]);
  const workingLook = useMemo(() => {
    const look = new Map<string, LiveFeedItem>();
    for (const i of all) if (i.memberId) look.set(i.memberId, i);
    return working.map((id) => ({ id, item: look.get(id) ?? null }));
  }, [all, working]);
  const live = !q.isError;

  // chip row: fade only on the side that has more to scroll to
  const measureChips = () => {
    const el = chipsRef.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    setChipEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  };
  useLayoutEffect(measureChips, [speakers, collapsed]);

  if (collapsed) {
    const at = baseId ? all.findIndex((i) => i.id === baseId) : -1;
    const unread = baseId === undefined ? 0 : baseId === null ? all.length : at >= 0 ? all.length - at - 1 : 0;
    const newest = all.length ? all[all.length - 1] : null;
    const speaker = newest?.memberId && working.includes(newest.memberId) ? newest.memberId : null;
    const shown = workingLook.slice(0, 4);
    const more = workingLook.length - shown.length;
    const tip = newest ? `${newest.memberName}: ${newest.text}` : 'Live commentary';
    return (
      <aside className="lf-root lf-rail" aria-label="Live commentary">
        <button
          type="button"
          className="lf-rail-btn"
          onClick={toggleCollapsed}
          aria-label={`Show live commentary${unread ? `, ${unread} new` : ''}${needs.length ? `, ${needs.length} need you` : ''}`}
          title={tip}
        >
          <span className={`lf-rail-dot${live ? '' : ' off'}`} aria-hidden="true" />
          {workingLook.length ? (
            <span className="lf-rail-av" aria-hidden="true" data-testid="live-feed-rail-working">
              {shown.map(({ id, item }) => (
                <span key={id} className={`lf-rail-one${id === speaker ? ' spoke' : ''}`}>
                  <FeedAvatar
                    name={item?.memberName ?? 'AI'}
                    glyph={item?.glyph ?? null}
                    color={item?.color ?? null}
                    size={26}
                  />
                </span>
              ))}
              {more > 0 ? <span className="lf-rail-more">+{more}</span> : null}
            </span>
          ) : null}
          {needs.length > 0 ? (
            <span className="lf-rail-count lf-rail-needs" data-testid="live-feed-rail-needs" aria-hidden="true">
              {needs.length}
            </span>
          ) : null}
          {unread > 0 ? (
            <span className="lf-rail-count" data-testid="live-feed-rail-unread" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
          <span className="lf-rail-label" aria-hidden="true">
            Live commentary
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="lf-root" aria-label="Live commentary" data-testid="live-feed">
      <header className="lf-top">
        <div className="lf-top-row">
          <span className={`lf-live${live && !paused ? '' : ' off'}`} title={live ? 'Live' : 'Reconnecting'}>
            <span className="lf-live-dot" />
            {paused ? 'PAUSED' : 'LIVE'}
          </span>
          <h2 className="lf-title">Live commentary</h2>
          <span style={{ flex: 1 }} />
          <IconBtn label={paused ? 'Resume the feed' : 'Pause the feed'} onClick={togglePause} pressed={paused}>
            {paused ? <path d="M8 5.5V18.5L19 12Z" fill="currentColor" /> : <path d="M9 5V19M15 5V19" />}
          </IconBtn>
          <IconBtn label="Hide live commentary" onClick={toggleCollapsed}>
            <path d="M9 6L15 12L9 18" />
          </IconBtn>
        </div>
        {links?.scopeLabel ? (
          <div className="lf-scope" data-testid="live-feed-scope">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth="2.2"
              aria-hidden="true"
              stroke={links.scopeLabel.kind === 'story' ? '#1B3A6B' : '#2F6FB0'}
            >
              <path
                d={
                  links.scopeLabel.kind === 'story'
                    ? 'M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.2L5.5 21V4a1 1 0 0 1 1-1z'
                    : 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l3 3 5-6'
                }
              />
            </svg>
            <span>
              {links.scopeLabel.kind === 'story' ? 'Story' : 'Ticket'} {links.scopeLabel.id}
              {links.scopeLabel.title ? ` · ${links.scopeLabel.title}` : ''}
            </span>
          </div>
        ) : null}
        <div className="lf-watch" aria-live="polite">
          <span className="lf-stack" aria-hidden="true">
            {workingLook.slice(0, 4).map(({ id, item }) => (
              <FeedAvatar
                key={id}
                name={item?.memberName ?? 'AI'}
                glyph={item?.glyph ?? null}
                color={item?.color ?? null}
                size={20}
              />
            ))}
          </span>
          <svg
            className="lf-eye"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            aria-hidden="true"
          >
            <path d="M2 12C5 6 9 4 12 4S19 6 22 12C19 18 15 20 12 20S5 18 2 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span data-testid="live-feed-working">
            {working.length
              ? `${working.length} AI${working.length === 1 ? '' : 's'} working now`
              : 'No AI working right now'}
          </span>
        </div>
        <div className="lf-detail" role="group" aria-label="Detail">
          <button
            type="button"
            className={detail === 'highlights' ? 'on' : ''}
            aria-pressed={detail === 'highlights'}
            onClick={() => chooseDetail('highlights')}
          >
            Highlights
          </button>
          <button
            type="button"
            className={detail === 'everything' ? 'on' : ''}
            aria-pressed={detail === 'everything'}
            onClick={() => chooseDetail('everything')}
          >
            Everything
          </button>
        </div>
        {speakers.length ? (
          <div
            className={`lf-chips${chipEdges.start ? ' fade-start' : ''}${chipEdges.end ? ' fade-end' : ''}`}
            role="toolbar"
            aria-label="Filter the feed"
            ref={chipsRef}
            onScroll={measureChips}
          >
            <button
              type="button"
              className={`lf-chip${filter.speaker == null ? ' on' : ''}`}
              aria-pressed={filter.speaker == null}
              onClick={() => setFilter({ speaker: null, ticketId: null })}
            >
              All
            </button>
            {speakers.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`lf-chip${filter.speaker === s.key ? ' on' : ''}`}
                aria-pressed={filter.speaker === s.key}
                onClick={() => setFilter((f) => ({ ...f, speaker: f.speaker === s.key ? null : s.key }))}
                style={filter.speaker === s.key && !s.board ? { borderColor: s.color || GREY } : undefined}
              >
                <span className="lf-chip-dot" style={{ background: s.board ? GREY : s.color || GREY }} />
                {s.name}
                {(counts.get(s.key) ?? 0) > 1 ? <span className="lf-chip-n"> · {counts.get(s.key)}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <NeedsYou items={needs} onOpenTicket={onOpenTicket} onOpenDocsPage={links?.onOpenDocsPage} />
      <div className="lf-scroll" ref={scroller} onScroll={onScroll}>
        {q.isLoading ? (
          <div className="lf-empty">
            <span className="lf-live-dot lf-big" />
            Tuning in…
          </div>
        ) : !groups.length ? (
          <div className="lf-empty">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M4 5H20V16H9L5 19.5V16H4Z" strokeLinejoin="round" />
              <path d="M8 9.5H16M8 12.5H13" strokeLinecap="round" />
            </svg>
            {filter.speaker || filter.ticketId ? (
              <span>Nothing from this filter yet.</span>
            ) : (
              <EmptyScope
                links={links}
                last={all.length ? all[all.length - 1] : null}
                anyLines={all.length > 0}
                working={working.length > 0}
                detail={detail}
                now={now}
                onEverything={() => chooseDetail('everything')}
              />
            )}
          </div>
        ) : (
          <ol
            className="lf-list"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="What the AIs are doing"
          >
            {groups.map((g) => (
              <Group
                key={g.key}
                g={g}
                now={now}
                fresh={fresh}
                onOpenTicket={onOpenTicket}
                lit={isLit(g)}
                links={links}
                runId={links ? runFor(g) : null}
                onOpenRun={openRunOf}
              />
            ))}
          </ol>
        )}
      </div>

      {q.isError ? <div className="lf-note">Can't reach the board. Trying again…</div> : null}
      {paused && heldBack > 0 ? (
        <button type="button" className="lf-jump" onClick={jumpToLive} data-testid="live-feed-jump">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            aria-hidden="true"
          >
            <path d="M12 5V19M6 13L12 19L18 13" />
          </svg>
          {heldBack} held · Resume
        </button>
      ) : unseen > 0 || heldBack > 0 ? (
        <button type="button" className="lf-jump" onClick={jumpToLive} data-testid="live-feed-jump">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            aria-hidden="true"
          >
            <path d="M12 5V19M6 13L12 19L18 13" />
          </svg>
          {unseen + heldBack} new · Jump to live
        </button>
      ) : !atEdge ? (
        <button type="button" className="lf-jump lf-jump-quiet" onClick={jumpToLive}>
          Jump to live
        </button>
      ) : null}
    </aside>
  );
}

/**
 * The column with nothing to show (design K2): quiet is a state, not an error, and says what the last thing was; a
 * ticket that has not started says what it waits for and offers its Story.
 */
function EmptyScope({
  links,
  last,
  anyLines,
  working,
  detail,
  now,
  onEverything,
}: {
  links?: FeedLinks;
  last: LiveFeedItem | null;
  anyLines: boolean;
  working: boolean;
  detail: FeedDetail;
  now: number;
  onEverything: () => void;
}) {
  const label = links?.scopeLabel;
  if (label?.kind === 'ticket' && !anyLines) {
    const waits = links?.waitsFor ?? [];
    return (
      <span data-testid="live-feed-empty-scope">
        <b className="lf-empty-t">Nothing yet for {label.id}.</b>
        {waits.length ? ` It waits for ${waits.join(', ')}.` : ' No AI has worked on it yet.'}{' '}
        {links?.onShowStory ? (
          <button type="button" className="lf-linkbtn" onClick={links.onShowStory}>
            Show the Story instead
          </button>
        ) : null}
      </span>
    );
  }
  if (label && !working) {
    const ago = last ? relTime(last.at, now) : '';
    return (
      <span data-testid="live-feed-quiet">
        <b className="lf-empty-t">Nothing is running in this {label.kind === 'story' ? 'Story' : 'ticket'}.</b>
        {last
          ? ` The last thing was ${last.ticketId ? `${last.ticketId}: ` : ''}${last.text}, ${ago === 'now' ? 'just now' : `${ago} ago`}.`
          : ''}{' '}
        When an AI picks up work here, it shows up in this column.
      </span>
    );
  }
  if (anyLines && detail === 'highlights') {
    return (
      <span>
        Nothing to highlight yet.{' '}
        <button type="button" className="lf-linkbtn" onClick={onEverything}>
          Show everything
        </button>
      </span>
    );
  }
  return (
    <span>It's quiet. When an AI picks up work, what it reads, edits, runs and says shows up here as it happens.</span>
  );
}

/**
 * The Flow tab's views with the live feed as a right-hand column (below them at phone width). `show` false keeps the
 * column out and the views as they were. `feed` joins the column to Flow's scope and drawing.
 */
export function LiveFeedSplit({
  show,
  projectId,
  onOpenTicket,
  feed,
  children,
}: {
  show: boolean;
  projectId: string;
  onOpenTicket?: (ticketId: string) => void;
  feed?: FeedLinks;
  children: ReactNode;
}) {
  return (
    <div className={`lf-split${show ? '' : ' lf-split-off'}`}>
      <div className="lf-main">{children}</div>
      {show ? <LiveFeed projectId={projectId} onOpenTicket={onOpenTicket} links={feed} /> : null}
    </div>
  );
}
