import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi } from '../../api/ai';
import { useTimeline } from '../../api/aiTeam';
import { extractError } from '../../api/extractError';
import type { Timeline, TimelineBar, TimelineLifeline, TimelineRange } from '../../types/aiTeam';
import { useToast } from '../Toast';
import { PAUSE_COLOR, PauseGlyph, clockTime } from '../ai/pausedUi';
import { fmtShort } from './teamFormat';
import {
  COL,
  GUTTER,
  NowPill,
  TimelineBody,
  TimelineGutter,
  TimelineHeader,
  arrowColor,
  arrowGlyph,
  arrowWord,
  pickKey,
  type Pick,
} from './timelineDraw';
import { buildAxis, clock, lengthText, type AxisMode } from './timelineLayout';
import { TimelineStrip } from './TimelineStrip';
import { buildTimelineLink, type TimelineLink } from './timelineLink';
import './timeline.css';

export interface TimelineActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenDocsPage: (pageId: string) => void;
  /** Back to the team map. */
  onSeeMap?: () => void;
  /** Open a ticket's story (One ticket). */
  onOpenStory?: (ticketId: string) => void;
}

type Preset = Exclude<TimelineRange, 'custom'>;
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'hour', label: 'Last hour' },
  { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 h' },
  { id: '7d', label: '7 days' },
];

/** How long a chosen range is, in ms. */
function presetSpan(p: Preset, now: number): number {
  if (p === 'hour') return 3600000;
  if (p === '24h') return 86400000;
  if (p === '7d') return 7 * 86400000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Math.max(now - midnight.getTime(), 3600000);
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

function rangeKey(projectId: string) {
  return `kanban.timeline.range.${projectId}`;
}
function readRange(projectId: string): Preset {
  try {
    const v = localStorage.getItem(rangeKey(projectId));
    if (v === 'hour' || v === 'today' || v === '24h' || v === '7d') return v;
  } catch {
    /* a remembered range is only a convenience */
  }
  return 'today';
}

/**
 * Flow › Timeline: a sequence diagram of the AI team. Each AI (and you, Autopilot and Docs) is a lifeline, time runs
 * down, a bar is a run and an arrow is a hand-off, a question, an approval or a decision
 * (design/screens/ai-team-timeline.md).
 * @param props.projectId - The project to draw.
 * @param props.actions - Open a ticket or a Docs page; go back to the team map.
 * @param props.scopeTicketId - Draw only this ticket (and its children): the ticket modal's AI activity tab.
 * @param props.compactChrome - Hide the controls that only make sense for the whole team (the modal uses it).
 */
export function TimelineTab({
  projectId,
  actions,
  scopeTicketId = null,
  compactChrome = false,
  initial = null,
}: {
  projectId: string;
  actions: TimelineActions;
  /** State to open with (from a link). */
  initial?: TimelineLink | null;
  scopeTicketId?: string | null;
  compactChrome?: boolean;
}) {
  const [preset, setPreset] = useState<Preset>(() => initial?.range ?? readRange(projectId));
  const [day, setDay] = useState<{ since: string; until: string } | null>(
    initial?.since && initial.until ? { since: initial.since, until: initial.until } : null,
  );
  const [scope, setScope] = useState<string | null>(scopeTicketId);
  const [detailed, setDetailed] = useState(!!initial?.detailed);
  const [mode, setMode] = useState<AxisMode>(initial?.real ? 'real' : 'compact');
  const [hidden, setHidden] = useState<Set<string>>(new Set(initial?.hidden ?? []));
  const [table, setTable] = useState(false);
  const [selected, setSelected] = useState<Pick | null>(null);
  const [hover, setHover] = useState<{ pick: Pick; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<'scope' | 'show' | null>(null);
  const [openQuiet, setOpenQuiet] = useState(false);
  const [width, setWidth] = useState(1100);
  const [pinned, setPinned] = useState(true);
  const [missed, setMissed] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Runs and arrows that arrived since the last read are drawn in, once; the first read draws everything still
  const known = useRef<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() });
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // The strip's zoom sets a custom window, a day opened from the bands sets one too: only the first has "Reset zoom"
  const [zoomWindow, setZoomWindow] = useState(false);
  const [view, setView] = useState({ top: 0, height: 400 });
  const seen = useRef(0);
  const toast = useToast();

  useEffect(() => {
    setScope(scopeTicketId);
  }, [scopeTicketId]);

  const query = useMemo(
    () =>
      day
        ? { range: 'custom' as const, since: day.since, until: day.until, ticketId: scope }
        : { range: preset, ticketId: scope },
    [preset, day, scope],
  );
  const q = useTimeline(projectId, query);
  const data = q.data;
  const stale = q.isError && !!data;
  const following = !!data?.following && !stale;
  const dataNow = ms(data?.now) ?? Date.now();
  // The live edge moves with the clock while following; behind the server it stands still
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!following) return;
    const t = setInterval(() => setTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, [following]);
  const now = following ? Math.max(tick, dataNow) : dataNow;

  const choose = (p: Preset) => {
    setPreset(p);
    setDay(null);
    setZoomWindow(false);
    setSelected(null);
    try {
      localStorage.setItem(rangeKey(projectId), p);
    } catch {
      /* ignore */
    }
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [data == null]);

  // Lifelines to draw: on a narrow window, AIs with nothing in the range fold into one strip
  const all = data?.lifelines ?? [];
  const narrow = width - GUTTER < all.length * COL && width < 900;
  const quiet = narrow && !openQuiet ? all.filter((l) => l.kind === 'ai' && l.quiet) : [];
  const lifelines: TimelineLifeline[] = all.filter((l) => !quiet.includes(l));
  const axis = useMemo(() => (data ? buildAxis(data, mode, now) : null), [data, mode, now]);

  // Following: stay at the bottom unless the person scrolled up, and count what arrived meanwhile
  const total = (data?.bars.length ?? 0) + (data?.arrows.length ?? 0);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !data) return;
    if (pinned && following) {
      el.scrollTo({ top: el.scrollHeight, behavior: seen.current ? 'smooth' : 'auto' });
      seen.current = total;
      setMissed(0);
    } else if (seen.current) setMissed(Math.max(total - seen.current, 0));
    else seen.current = total;
  }, [total, pinned, following, data, mode, axis?.height]);

  useEffect(() => {
    if (!data) return;
    const key = JSON.stringify(query);
    const ids = new Set<string>([
      ...data.bars.map((b) => b.id),
      ...data.arrows.flatMap((a) => [a.id, `${a.id}:n${a.count}`]),
    ]);
    if (known.current.key !== key) {
      known.current = { key, ids };
      setFresh(new Set());
      return;
    }
    const added = new Set([...ids].filter((i) => !known.current.ids.has(i)));
    known.current = { key, ids };
    if (!added.size) return;
    setFresh(added);
    const t = setTimeout(() => setFresh(new Set()), 1500);
    return () => clearTimeout(t);
  }, [data, query]);

  // A hidden tab stops every animation and resumes without replaying
  useEffect(() => {
    const onVisible = () => {
      const root = rootRef.current;
      if (!root) return;
      root.classList.toggle('tl-hidden', document.hidden);
      root.querySelectorAll('svg').forEach((svg) => {
        const s = svg as SVGSVGElement;
        if (document.hidden) s.pauseAnimations?.();
        else s.unpauseAnimations?.();
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // What the strip's box shows: the visible part below the header
  useEffect(() => {
    const el = scroller.current;
    if (el) setView({ top: el.scrollTop, height: Math.max(el.clientHeight - 46, 40) });
  }, [axis?.height, width, data == null]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setView({ top: el.scrollTop, height: Math.max(el.clientHeight - 46, 40) });
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setPinned(bottom);
    if (bottom) setMissed(0);
  };
  const toBottom = () => {
    setPinned(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  };

  const ticketOf = useCallback((id: string | null | undefined) => id ?? '', []);
  const names = useMemo(() => new Map(all.map((l) => [l.id, l.name])), [all]);

  // Esc closes the inspector
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!data || !axis) {
    return (
      <div className="tl-root" data-testid="tl-loading">
        <div className="tl-toolbar">
          <span className="at-hint tl-shim">{q.isError ? "Couldn't load the Timeline." : 'Drawing the Timeline…'}</span>
        </div>
        <div className="tl-skeleton" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="tl-shim" />
          ))}
        </div>
      </div>
    );
  }

  const empty = data.bars.length === 0 && data.arrows.length === 0 && data.waits.length === 0;
  const focusRun = (ticketId: string) => {
    const bar =
      data.bars.find((b) => b.ticketId === ticketId && !b.endedAt) ?? data.bars.find((b) => b.ticketId === ticketId);
    if (!bar) return actions.onOpenTicket(ticketId);
    const y = axis.y(ms(bar.startedAt ?? bar.queuedAt) ?? now);
    scroller.current?.scrollTo({ top: Math.max(y - 120, 0), behavior: 'smooth' });
    setSelected({ type: 'bar', id: bar.id });
  };
  const scopeTickets = Object.entries(data.tickets);
  const paused = data.pausedAll;
  const dayLabel = day
    ? zoomWindow
      ? `${clock(ms(day.since) ?? 0)} – ${clock(ms(day.until) ?? 0)}`
      : new Date(day.since).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : '';

  return (
    <div className="tl-root" data-testid="timeline-tab" ref={rootRef}>
      {paused && (
        <div
          className="at-now idle"
          data-testid="tl-paused-chip"
          style={{ borderColor: '#F0CDB0', background: '#FDF0E6' }}
        >
          <PauseGlyph size={12} color={PAUSE_COLOR} />
          <b style={{ color: PAUSE_COLOR }}>No AI is running</b> · paused since {clockTime(data.pausedAt)}
        </div>
      )}
      {!paused && (
        <LiveStripLite live={scope ? data.live.filter((x) => x.ticketId === scope) : data.live} onPick={focusRun} />
      )}

      <div className="tl-toolbar">
        {!compactChrome && (
          <div className="tl-menuwrap">
            <button
              type="button"
              className="tl-btn"
              onClick={() => setMenu(menu === 'scope' ? null : 'scope')}
              aria-haspopup="menu"
            >
              {scope ? `One ticket: ${scope}` : 'Whole team'}
            </button>
            {menu === 'scope' && (
              <div className="tl-menu" role="menu" data-testid="tl-scope-menu">
                <button
                  type="button"
                  role="menuitem"
                  className={!scope ? 'on' : ''}
                  onClick={() => {
                    setScope(null);
                    setMenu(null);
                  }}
                >
                  Whole team
                </button>
                <div className="tl-menu-h">Tickets in this range</div>
                {scopeTickets.length === 0 && <div className="tl-menu-empty">No ticket yet.</div>}
                {scopeTickets
                  .sort((a, b) => Number(isLive(data, b[0])) - Number(isLive(data, a[0])))
                  .map(([id, t]) => (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      className={scope === id ? 'on' : ''}
                      onClick={() => {
                        setScope(id);
                        setMenu(null);
                      }}
                    >
                      {isLive(data, id) && <span className="at-live-dot working" />}
                      <b>{id}</b> {t.title}
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
        <div className="tl-menuwrap">
          <button
            type="button"
            className="tl-btn"
            onClick={() => setMenu(menu === 'show' ? null : 'show')}
            aria-haspopup="menu"
          >
            Show: {hidden.size ? 'some' : 'all'}
          </button>
          {menu === 'show' && (
            <div className="tl-menu" role="menu" data-testid="tl-show-menu">
              {[
                ['handoffs', 'Hand-offs'],
                ['questions', 'Questions and approvals'],
                ['touches', 'Your marks'],
              ].map(([key, label]) => (
                <label key={key} className="tl-check">
                  <input
                    type="checkbox"
                    checked={!hidden.has(key)}
                    onChange={(e) => {
                      const next = new Set(hidden);
                      if (e.target.checked) next.delete(key);
                      else next.add(key);
                      setHidden(next);
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>
        <span className="tl-sep" />
        <div className="at-seg" style={{ margin: 0 }} role="group" aria-label="Detail">
          <button type="button" className={!detailed ? 'on' : ''} onClick={() => setDetailed(false)}>
            Compact
          </button>
          <button type="button" className={detailed ? 'on' : ''} onClick={() => setDetailed(true)}>
            Detailed
          </button>
        </div>
        <div className="at-seg" style={{ margin: 0 }} role="group" aria-label="Time">
          <button type="button" className={mode === 'compact' ? 'on' : ''} onClick={() => setMode('compact')}>
            Compact time
          </button>
          <button type="button" className={mode === 'real' ? 'on' : ''} onClick={() => setMode('real')}>
            Real time
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="tl-btn"
          data-testid="tl-copy-link"
          onClick={() => {
            const url = buildTimelineLink(projectId, {
              range: day ? undefined : preset,
              since: day?.since,
              until: day?.until,
              scope,
              detailed,
              real: mode === 'real',
              hidden: [...hidden],
            });
            navigator.clipboard
              ?.writeText(url)
              .then(() => toast.success('Link copied', 'It restores the range, the scope and the switches.'))
              .catch(() => toast.error("Couldn't copy the link"));
          }}
        >
          Copy link
        </button>
        <button
          type="button"
          className={`tl-btn ${table ? 'on' : ''}`}
          onClick={() => setTable(!table)}
          aria-pressed={table}
        >
          Table
        </button>
        <select
          className="at-range"
          aria-label="Range"
          value={day ? 'day' : preset}
          onChange={(e) => choose(e.target.value as Preset)}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {day && <option value="day">{dayLabel}</option>}
        </select>
        {paused ? (
          <span className="tl-follow paused">AI paused since {clockTime(data.pausedAt)}</span>
        ) : following && pinned ? (
          <span className="tl-follow on" data-testid="tl-following">
            <span className="at-live-dot working" /> Following live
          </span>
        ) : following ? (
          <button type="button" className="tl-follow back" onClick={toBottom} data-testid="tl-scrolled-back">
            Scrolled back{missed ? `: ${missed} new event${missed === 1 ? '' : 's'}` : ''} ↓
          </button>
        ) : null}
      </div>

      {stale && (
        <div className="at-now idle" role="status" data-testid="tl-behind" style={{ borderColor: '#F0CDB0' }}>
          <b>Showing events up to {clock(dataNow)}</b> · Can’t reach the server. The now line stops and it catches up by
          itself.
        </div>
      )}
      {data.truncated && (
        <div className="at-hint">
          Showing the newest 500 hand-offs. Narrow the range or pick one ticket to see the rest.
        </div>
      )}
      {data.groupedHarder && !data.truncated && (
        <div className="at-hint">
          Many events in this range: close ones are grouped (×N). Click a grouped arrow to see them.
        </div>
      )}

      {data.range === '7d' && !day && !scope ? (
        <DayBands data={data} onPick={(since, until) => setDay({ since, until })} />
      ) : table ? (
        <EventTable data={data} names={names} onPick={(p) => setSelected(p)} />
      ) : empty ? (
        <EmptyRange data={data} lifelines={lifelines} onWiden={() => choose('7d')} onMap={actions.onSeeMap} />
      ) : (
        <div className="tl-stage">
          <TimelineStrip
            data={data}
            axis={axis}
            view={view}
            onScrollTo={(y) => scroller.current?.scrollTo({ top: y, behavior: 'smooth' })}
            zoomed={!!day && !!zoomWindow}
            onZoom={(win) => {
              setSelected(null);
              // zooming out to the whole range (or past it) is going back to the range
              if (!win || win.until - win.since >= presetSpan(preset, now)) {
                setDay(null);
                setZoomWindow(false);
                return;
              }
              setZoomWindow(true);
              setDay({ since: new Date(win.since).toISOString(), until: new Date(win.until).toISOString() });
            }}
          />
          <div
            className="tl-scroll"
            ref={scroller}
            onScroll={onScroll}
            tabIndex={0}
            aria-label="Timeline diagram"
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Home') scroller.current?.scrollTo({ top: 0 });
              if (e.key === 'End') toBottom();
            }}
            data-testid="tl-scroll"
          >
            <div className="tl-corner" style={{ width: GUTTER }} />
            <div className="tl-head">
              <TimelineHeader lifelines={lifelines} folded={quiet.length} onOpenFolded={() => setOpenQuiet(true)} />
            </div>
            <div className="tl-gutter" style={{ width: GUTTER }}>
              <TimelineGutter axis={axis} />
              <NowPill axis={axis} now={now} paused={paused} />
            </div>
            <div className="tl-bodywrap">
              <TimelineBody
                data={data}
                axis={axis}
                lifelines={lifelines}
                now={now}
                detailed={detailed}
                selected={selected}
                onPick={setSelected}
                onHover={(p, at) => setHover(p && at ? { pick: p, x: at.x, y: at.y } : null)}
                hidden={hidden}
                ticketOf={ticketOf}
                fresh={fresh}
              />
            </div>
          </div>
          {hover && !selected && (
            <HoverCard data={data} pick={hover.pick} x={hover.x} y={hover.y} names={names} now={now} />
          )}
          {selected && (
            <Inspector
              data={data}
              pick={selected}
              names={names}
              now={now}
              actions={actions}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      )}
      <Legend />
      <span className="tl-keyhint at-hint-sm">
        Tab moves between marks · Enter opens the inspector · Esc closes it
        {pickKey(selected) ? '' : ''}
      </span>
    </div>
  );
}

function isLive(data: Timeline, ticketId: string): boolean {
  return data.live.some((x) => x.ticketId === ticketId);
}

/** The strip of what is happening now, one chip per live run; a click scrolls to the run. */
function LiveStripLite({ live, onPick }: { live: Timeline['live']; onPick: (ticketId: string) => void }) {
  if (!live.length)
    return (
      <div className="at-now idle" data-testid="live-strip">
        <b>Right now</b> Nobody is working.
      </div>
    );
  const word: Record<string, string> = { working: 'working', waiting_you: 'waiting for you', queued: 'queued' };
  const color: Record<string, string> = { working: '#2E6F40', waiting_you: '#8A6A12', queued: '#5B6B60' };
  return (
    <div className="at-now" data-testid="live-strip">
      <b>Right now</b>
      {live.map((x) => (
        <button
          key={x.runId}
          type="button"
          className="at-now-chip"
          onClick={() => onPick(x.ticketId)}
          title={x.step || x.ticketTitle}
        >
          <span className={`at-live-dot ${x.state}`} />
          <b>{x.memberName}</b>
          <span style={{ color: color[x.state] }}>
            {word[x.state]} · {x.ticketId}
            {x.elapsedS != null ? ` · ${fmtShort(x.elapsedS)}` : ''}
          </span>
        </button>
      ))}
      <span className="at-hint-sm">A click scrolls the diagram to that run</span>
    </div>
  );
}

function EmptyRange({
  data,
  lifelines,
  onWiden,
  onMap,
}: {
  data: Timeline;
  lifelines: TimelineLifeline[];
  onWiden: () => void;
  onMap?: () => void;
}) {
  return (
    <div className="tl-empty" data-testid="tl-empty">
      <div className="tl-empty-heads">
        {lifelines.map((l) => (
          <span key={l.id} className="tl-empty-head" style={{ borderColor: l.color ?? '#C7D2CB' }}>
            {l.name}
          </span>
        ))}
      </div>
      <b>No AI work between {clock(ms(data.since) ?? 0)} and now</b>
      <span className="at-hint">
        The lifelines stay so you can see who is on the team, all idle.
        {data.lastEndedAt ? ` The last run ended at ${clock(ms(data.lastEndedAt) ?? 0)}.` : ''}
      </span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="tl-btn" onClick={onWiden}>
          Widen to 7 days
        </button>
        {onMap && (
          <button type="button" className="tl-btn" onClick={onMap}>
            Open the team map
          </button>
        )}
      </span>
    </div>
  );
}

/** Seven days: a band per day with what ran, what failed and what waited long; a click opens that day. */
function DayBands({ data, onPick }: { data: Timeline; onPick: (since: string, until: string) => void }) {
  const days = new Map<string, { start: Date; runs: number; failed: number; long: number }>();
  const from = new Date(data.since);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (d.getTime() > (ms(data.until) ?? Date.now())) break;
    days.set(d.toDateString(), { start: d, runs: 0, failed: 0, long: 0 });
  }
  for (const b of data.bars) {
    const d = days.get(new Date(ms(b.queuedAt) ?? 0).toDateString());
    if (!d) continue;
    d.runs += 1;
    if (b.endKind === 'failed' || b.endKind === 'timeout') d.failed += 1;
  }
  for (const w of data.waits) {
    const d = days.get(new Date(ms(w.from) ?? 0).toDateString());
    if (d && ((ms(w.to) ?? Date.now()) - (ms(w.from) ?? 0)) / 60000 > 10) d.long += 1;
  }
  const max = Math.max(1, ...[...days.values()].map((d) => d.runs));
  return (
    <div className="tl-days" data-testid="tl-days">
      {[...days.values()].map((d) => {
        const end = new Date(d.start.getFullYear(), d.start.getMonth(), d.start.getDate() + 1);
        return d.runs === 0 ? (
          <div key={d.start.toISOString()} className="tl-day quiet">
            <b>{d.start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</b>
            <span className="at-hint">nothing ran</span>
          </div>
        ) : (
          <button
            key={d.start.toISOString()}
            type="button"
            className="tl-day"
            onClick={() => onPick(d.start.toISOString(), end.toISOString())}
          >
            <b>{d.start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</b>
            <span className="tl-day-bar">
              <i style={{ width: `${Math.max((d.runs / max) * 100, 4)}%` }} />
            </span>
            <span>{d.runs} runs</span>
            {d.failed > 0 && <span className="tl-day-chip bad">{d.failed} failed</span>}
            {d.long > 0 && <span className="tl-day-chip wait">{d.long} waited long</span>}
          </button>
        );
      })}
      <span className="at-hint">Over a day the diagram would be unreadable. Click a day to open it as a timeline.</span>
    </div>
  );
}

/** The same events as a table, for a screen reader or to copy. */
function EventTable({
  data,
  names,
  onPick,
}: {
  data: Timeline;
  names: Map<string, string>;
  onPick: (p: Pick) => void;
}) {
  const rows = [
    ...data.arrows.map((a) => ({
      at: a.at,
      from: names.get(a.from) ?? a.from,
      to: names.get(a.to) ?? a.to,
      kind: arrowWord(a.kind),
      ticket: a.ticketId ?? '',
      dur: a.waitS != null ? lengthText(a.waitS * 1000) : '',
      pick: { type: 'arrow', id: a.id } as Pick,
    })),
    ...data.bars.map((b) => ({
      at: b.startedAt ?? b.queuedAt ?? '',
      from: names.get(b.memberId) ?? b.memberId,
      to: '',
      kind: `run #${b.number} ${b.state.replace('_', ' ')}`,
      ticket: b.ticketId,
      dur: durationOf(b),
      pick: { type: 'bar', id: b.id } as Pick,
    })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  return (
    <div className="tl-tablewrap">
      <table className="at-table" data-testid="tl-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>From</th>
            <th>To</th>
            <th>Kind</th>
            <th>Ticket</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={pickKey(r.pick)} onClick={() => onPick(r.pick)} style={{ cursor: 'pointer' }}>
              <td>{clock(ms(r.at) ?? 0)}</td>
              <td>{r.from}</td>
              <td>{r.to}</td>
              <td>{r.kind}</td>
              <td>{r.ticket}</td>
              <td>{r.dur}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function durationOf(b: TimelineBar): string {
  const a = ms(b.startedAt);
  const z = ms(b.endedAt) ?? Date.now();
  return a ? lengthText(z - a) : '';
}

// ---------------------------------------------------------------------------
// Detail on demand: hover card and inspector (the same facts, one at a glance, one in full)
// ---------------------------------------------------------------------------

interface Facts {
  title: string;
  chip?: string;
  lines: string[];
  ticketId?: string | null;
  pageId?: string;
  bar?: TimelineBar;
  question?: { runId: string; text: string; options: string[] };
  note?: string;
}

function factsOf(data: Timeline, pick: Pick, names: Map<string, string>, now: number): Facts | null {
  const who = (id: string) => names.get(id) ?? id;
  if (pick.type === 'bar') {
    const b = data.bars.find((x) => x.id === pick.id);
    if (!b) return null;
    const start = ms(b.startedAt);
    const end = ms(b.endedAt) ?? now;
    const lines = [
      b.state === 'queued'
        ? `Queued at ${clock(ms(b.queuedAt) ?? 0)}${b.heldByPause ? ' · held until resume' : ''}`
        : `Started ${clock(start ?? 0)} · ${lengthText(end - (start ?? end))}${b.endedAt ? '' : ' so far'} · step ${b.steps}`,
    ];
    if (b.tokensIn || b.tokensOut)
      lines.push(
        `${Math.round(b.tokensIn / 1000)}k tokens in, ${Math.round(b.tokensOut / 1000)}k out${b.metered ? ` · $${b.costUsd.toFixed(2)}` : ' · Not metered'}`,
      );
    if (b.summary) lines.push(b.summary);
    if (b.endedReason && b.endKind !== 'ok') lines.push(b.endedReason);
    return {
      title: `${who(b.memberId)} · run #${b.number}`,
      chip: endWord(b),
      lines,
      ticketId: b.ticketId,
      bar: b,
      note: b.trigger === 'autopilot' ? 'A short run by the Autopilot delegate to look at a request.' : undefined,
    };
  }
  if (pick.type === 'wait') {
    const w = data.waits.find((x) => x.id === pick.id);
    if (!w) return null;
    const from = ms(w.from) ?? now;
    const to = ms(w.to) ?? now;
    return {
      title: w.kind === 'question' ? `Question from ${who(w.memberId)}` : `${who(w.memberId)} needs a permission`,
      chip: w.to ? 'answered' : 'waiting for you',
      lines: [
        `“${w.text}”`,
        `${w.to ? 'Waited' : 'Waiting'} ${lengthText(to - from)} · asked ${clock(from)}`,
        ...(w.risk ? [`Risk ${w.risk}`] : []),
      ],
      ticketId: w.ticketId,
      question:
        w.kind === 'question' && !w.to && w.runId
          ? { runId: w.runId, text: w.text, options: w.options ?? [] }
          : undefined,
    };
  }
  if (pick.type === 'arrow') {
    const a = data.arrows.find((x) => x.id === pick.id);
    if (!a) return null;
    const lines = [`${who(a.from)} → ${who(a.to)} · ${clock(ms(a.at) ?? 0)}`];
    if (a.waitS != null) lines.push(`Waited ${lengthText(a.waitS * 1000)}`);
    if (a.label) lines.push(a.label);
    if (a.summary) lines.push(a.summary);
    if (a.by) lines.push(`By ${a.by}`);
    if (a.count > 1) {
      const tickets = [...new Set(a.items.map((i) => i.ticketId).filter(Boolean))];
      lines.push(
        `${a.count} close events grouped${a.parentId ? ` (children of ${a.parentId})` : ''}${tickets.length ? `: ${tickets.join(', ')}` : ''}`,
      );
    }
    return {
      title: arrowWord(a.kind),
      chip: arrowGlyph(a.kind).length === 1 ? arrowGlyph(a.kind) : undefined,
      lines,
      ticketId: a.ticketId,
    };
  }
  if (pick.type === 'touch') {
    const t = data.touches.find((x) => x.id === pick.id);
    if (!t) return null;
    return {
      title: t.what,
      chip: t.mark.replace('_', ' '),
      lines: [`${t.who}${t.via ? ` via ${t.via}` : ''} · ${clock(ms(t.at) ?? 0)}`],
      ticketId: t.ticketId,
    };
  }
  if (pick.type === 'doc') {
    const n = data.docs.find((x) => x.id === pick.id);
    if (!n) return null;
    return {
      title: n.title || 'Docs page',
      chip: n.kind === 'proposal' ? (n.status ?? 'proposal') : `v${n.version}`,
      lines: [`${who(n.memberId)} · ${clock(ms(n.at) ?? 0)}`, ...(n.summary ? [n.summary] : [])],
      pageId: n.pageId,
    };
  }
  const p = data.pauses.find((x) => x.from === pick.id);
  if (!p) return null;
  return {
    title: 'AI paused',
    lines: [
      `By ${p.by ?? 'someone'} at ${clock(ms(p.from) ?? 0)}${p.to ? ` · resumed ${clock(ms(p.to) ?? 0)}${p.resumedBy ? ` by ${p.resumedBy}` : ''}` : ''}`,
      ...(p.reason ? [`Reason: “${p.reason}”`] : []),
      'The time inside the band is counted as paused: it is not waiting for you and not a bottleneck.',
    ],
  };
}

function endWord(b: TimelineBar): string {
  if (b.heldByPause) return 'held until resume';
  switch (b.endKind) {
    case 'ok':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'timeout':
      return 'timed out';
    case 'stopped':
      return 'stopped by a person';
    case 'pause_all':
      return 'stopped by the pause';
    case 'budget':
      return 'held back by a budget';
    default:
      return b.state.replace('_', ' ');
  }
}

function HoverCard({
  data,
  pick,
  x,
  y,
  names,
  now,
}: {
  data: Timeline;
  pick: Pick;
  x: number;
  y: number;
  names: Map<string, string>;
  now: number;
}) {
  const f = factsOf(data, pick, names, now);
  if (!f) return null;
  return (
    <div
      className="tl-hover"
      role="tooltip"
      style={{ left: Math.min(x + 14, window.innerWidth - 300), top: Math.min(y + 14, window.innerHeight - 160) }}
    >
      <b>{f.title}</b>
      {f.chip && <span className="tl-chip">{f.chip}</span>}
      {f.lines.slice(0, 3).map((l) => (
        <div key={l}>{l}</div>
      ))}
      <span className="tl-hover-hint">Click for details</span>
    </div>
  );
}

function Inspector({
  data,
  pick,
  names,
  now,
  actions,
  onClose,
}: {
  data: Timeline;
  pick: Pick;
  names: Map<string, string>;
  now: number;
  actions: TimelineActions;
  onClose: () => void;
}) {
  const f = factsOf(data, pick, names, now);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  if (!f) return null;
  const answer = async (value: string) => {
    if (!f.question || !value.trim()) return;
    setBusy(true);
    try {
      await aiApi.answer(f.question.runId, value.trim());
      toast.success('Answer sent');
      setText('');
      void qc.invalidateQueries({ queryKey: ['ai', 'team'] });
      onClose();
    } catch (err) {
      toast.error("Couldn't send the answer", extractError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="tl-inspector" aria-label="Details" data-testid="tl-inspector">
      <div className="tl-insp-head">
        <b>{f.title}</b>
        {f.chip && <span className="tl-chip">{f.chip}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="tl-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {f.ticketId && (
        <div className="at-hint">
          {f.ticketId}
          {data.tickets[f.ticketId] ? ` · ${data.tickets[f.ticketId].title}` : ''}
        </div>
      )}
      {f.lines.map((l) => (
        <div key={l} className="tl-insp-line">
          {l}
        </div>
      ))}
      {f.note && <div className="at-hint">{f.note}</div>}
      {f.question && (
        <div className="tl-answer">
          {f.question.options.length > 0 && (
            <>
              <span className="at-label">Suggested answers (from the AI)</span>
              {f.question.options.map((o) => (
                <button key={o} type="button" className="tl-btn" disabled={busy} onClick={() => void answer(o)}>
                  {o}
                </button>
              ))}
            </>
          )}
          <input
            className="tl-input"
            value={text}
            placeholder="Type an answer…"
            aria-label="Answer"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void answer(text);
            }}
          />
          <button
            type="button"
            className="tl-btn primary"
            disabled={busy || !text.trim()}
            onClick={() => void answer(text)}
          >
            Answer
          </button>
        </div>
      )}
      <div className="tl-insp-actions">
        {f.ticketId && (
          <button type="button" className="tl-btn" onClick={() => actions.onOpenTicket(f.ticketId as string)}>
            Open the ticket
          </button>
        )}
        {f.ticketId && actions.onOpenStory && (
          <button type="button" className="tl-btn" onClick={() => actions.onOpenStory?.(f.ticketId as string)}>
            Open ticket story
          </button>
        )}
        {f.pageId && (
          <button type="button" className="tl-btn" onClick={() => actions.onOpenDocsPage(f.pageId as string)}>
            Open the page
          </button>
        )}
      </div>
    </aside>
  );
}

function Legend() {
  const items: { k: Parameters<typeof arrowColor>[0]; t: string }[] = [
    { k: 'assign', t: 'assigned' },
    { k: 'mention', t: '@mention' },
    { k: 'handoff', t: 'hand-off (dashed and moving while under way)' },
    { k: 'report', t: 'report back (dotted)' },
    { k: 'sent_back', t: 'sent back (red dashed)' },
    { k: 'ask', t: 'asks you' },
    { k: 'auto', t: 'Autopilot decided' },
  ];
  return (
    <div className="tl-legend" data-testid="tl-legend">
      {items.map((i) => (
        <span key={i.k}>
          <b style={{ color: arrowColor(i.k) }}>{arrowGlyph(i.k)}</b> {i.t}
        </span>
      ))}
      <span>Hatched amber: waiting for you · hatched grey: waiting for an AI or a runner</span>
    </div>
  );
}
