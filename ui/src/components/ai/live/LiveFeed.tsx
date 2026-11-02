import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveFeed, type LiveFeedItem } from '../../../api/aiLiveFeed';
import { AI_GLYPHS, GlyphIcon } from '../aiUi';
import {
  clockOf,
  codeParts,
  relTime,
  speakersIn,
  ticketsIn,
  toGroups,
  toLines,
  type FeedFilter,
  type FeedGroup,
  type FeedLine,
} from './liveFeedModel';
import './liveFeed.css';

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

function Line({ line, now, fresh }: { line: FeedLine; now: number; fresh: boolean }) {
  // a command's line takes its result's colour once the result is in
  const tone = line.result && line.tone === 'info' ? line.result.tone : line.tone;
  return (
    <li className={`lf-line lf-t-${tone}${fresh ? ' lf-in' : ''}`} data-kind={line.kind} title={clockOf(line.at)}>
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

function Group({
  g,
  now,
  fresh,
  onOpenTicket,
}: {
  g: FeedGroup;
  now: number;
  fresh: Set<string>;
  onOpenTicket?: (id: string) => void;
}) {
  const board = g.memberId == null;
  const tint = board ? GREY : g.color || GREY;
  return (
    <li className={`lf-group${fresh.has(g.lines[0].id) ? ' lf-in' : ''}`} data-speaker={g.speaker}>
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
            <Line key={l.id} line={l} now={now} fresh={fresh.has(l.id) && l.id !== g.lines[0].id} />
          ))}
        </ul>
      </div>
    </li>
  );
}

/**
 * AI Team › Flow › Live commentary: what each AI is doing right now, as a live chat. Newest at the bottom; it follows
 * the live edge until the person scrolls up, then counts what came in ("3 new · Jump to live").
 */
export function LiveFeed({
  projectId,
  onOpenTicket,
}: {
  projectId: string;
  onOpenTicket?: (ticketId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
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
  const q = useLiveFeed(projectId);
  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const working = useMemo(() => q.data?.working ?? [], [q.data]);

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
  const lines = useMemo(() => toLines(held, filter), [held, filter]);
  const groups = useMemo(() => toGroups(lines), [lines]);
  const allLines = useMemo(() => toLines(all, filter), [all, filter]);
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
  const tickets = useMemo(() => ticketsIn(all), [all]);
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
  useLayoutEffect(measureChips, [speakers, tickets, collapsed]);

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
          aria-label={`Show live commentary${unread ? `, ${unread} new` : ''}`}
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
        {speakers.length || tickets.length ? (
          <div
            className={`lf-chips${chipEdges.start ? ' fade-start' : ''}${chipEdges.end ? ' fade-end' : ''}`}
            role="toolbar"
            aria-label="Filter the feed"
            ref={chipsRef}
            onScroll={measureChips}
          >
            <button
              type="button"
              className={`lf-chip${filter.speaker == null && filter.ticketId == null ? ' on' : ''}`}
              aria-pressed={filter.speaker == null && filter.ticketId == null}
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
              </button>
            ))}
            {tickets.length ? (
              <select
                className={`lf-chip lf-chip-sel${filter.ticketId ? ' on' : ''}`}
                aria-label="Only one ticket"
                value={filter.ticketId ?? ''}
                onChange={(e) => setFilter((f) => ({ ...f, ticketId: e.target.value || null }))}
              >
                <option value="">Any ticket</option>
                {tickets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title ? `${t.id} · ${t.title.slice(0, 40)}` : t.id}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ) : null}
      </header>

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
              <span>
                It's quiet. When an AI picks up work, what it reads, edits, runs and says shows up here as it happens.
              </span>
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
              <Group key={g.key} g={g} now={now} fresh={fresh} onOpenTicket={onOpenTicket} />
            ))}
          </ol>
        )}
      </div>

      {q.isError ? <div className="lf-note">Can't reach the board. Trying again…</div> : null}
      {unseen > 0 || heldBack > 0 ? (
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
 * The Flow tab's views with the live feed as a right-hand column (below them at phone width). `show` false (One
 * ticket) keeps the column out and the views as they were.
 */
export function LiveFeedSplit({
  show,
  projectId,
  onOpenTicket,
  children,
}: {
  show: boolean;
  projectId: string;
  onOpenTicket?: (ticketId: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={`lf-split${show ? '' : ' lf-split-off'}`}>
      <div className="lf-main">{children}</div>
      {show ? <LiveFeed projectId={projectId} onOpenTicket={onOpenTicket} /> : null}
    </div>
  );
}
