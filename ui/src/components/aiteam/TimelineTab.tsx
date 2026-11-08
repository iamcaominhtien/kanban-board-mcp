import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi, useAiRun } from '../../api/ai';
import { useTimeline } from '../../api/aiTeam';
import { extractError } from '../../api/extractError';
import { openRun } from './runLink';
import type { Timeline, TimelineBar, TimelineLifeline, TimelineRange } from '../../types/aiTeam';
import { useToast } from '../Toast';
import { PAUSE_COLOR, clockTime } from '../ai/pausedUi';
import { AUTO_RESTARTS, fmtMb } from './resourcesFormat';
import { fmtShort } from './teamFormat';
import { CalendarIcon, ICONS, Icon } from './teamUi';
import { MenuSelect } from '../ui/MenuSelect';
import {
  GUTTER,
  NowPill,
  TimelineBody,
  TimelineGutter,
  TimelineHeader,
  arrowColor,
  arrowGlyph,
  arrowStroke,
  arrowWord,
  lanesWidth,
  columnFor,
  lookOf,
  pickKey,
  type Pick,
} from './timelineDraw';
import { buildAxis, clock, lengthText, type AxisMode } from './timelineLayout';
import { TimelineStrip } from './TimelineStrip';
import { TimelineGroups } from './TimelineGroups';
import { buildTimelineLink, type TimelineLink } from './timelineLink';
import './timeline.css';
import { LineIcon } from '../ui/LineIcon';

export interface TimelineActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenDocsPage: (pageId: string) => void;
  /** Back to the team map. */
  onSeeMap?: () => void;
  /** Open a ticket's flow (the ticket scope of Flow). */
  onOpenStory?: (ticketId: string) => void;
}

type Preset = Exclude<TimelineRange, 'custom'>;
/** What the range button can pick: a preset, the day or window already open, or a custom range. */
type RangeChoice = Preset | 'day' | 'custom';
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'hour', label: 'Last hour' },
  { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 h' },
  { id: '7d', label: '7 days' },
];

const SLOW_WORDS: Record<Preset, string> = {
  hour: 'the last hour',
  today: 'today',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
};

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

const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** A local date as the value of a date input (yyyy-mm-dd). */
function dateValue(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a date input's value, in ms (NaN when empty). */
function midnightOf(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).getTime() : Number.NaN;
}

/**
 * The "Custom…" range (design/screens/ai-team-timeline-cases.md, E4): two days, from the start of the first to the
 * end of the last.
 */
function CustomRange({
  initial,
  now,
  onApply,
  onClose,
}: {
  initial: { since: string; until: string } | null;
  now: number;
  onApply: (since: string, until: string) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(() => dateValue(initial ? (ms(initial.since) ?? now) : now - 2 * 86400000));
  const [to, setTo] = useState(() => dateValue(initial ? (ms(initial.until) ?? now) - 1 : now));
  const a = midnightOf(from);
  const b = midnightOf(to);
  const error =
    Number.isNaN(a) || Number.isNaN(b) ? 'Pick both days.' : a > b ? 'The first day is after the last.' : '';
  return (
    <div
      className="tl-menu tl-custom"
      role="dialog"
      aria-label="Custom range"
      data-testid="tl-custom-range"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="tl-menu-h">Custom range</div>
      <div className="tl-custom-row">
        <label>
          From
          <input type="date" value={from} max={dateValue(now)} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} max={dateValue(now)} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {error && (
        <div className="tl-custom-error" role="alert">
          {error}
        </div>
      )}
      <div className="tl-custom-foot">
        <button type="button" className="tl-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="tl-btn primary"
          disabled={!!error}
          onClick={() => onApply(new Date(a).toISOString(), new Date(b + 86400000).toISOString())}
        >
          Show this range
        </button>
      </div>
    </div>
  );
}

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
 * Flow › Timeline: a sequence diagram of the AI teams. You, each team's lead and each role it called is a lifeline, time
 * runs down, a bar is a run or one call of a role and an arrow is a hand-off, a question or an answer
 * (design/screens/ai-team-timeline.md).
 * @param props.projectId - The project to draw.
 * @param props.actions - Open a ticket or a Docs page; go back to the team map.
 * @param props.scopeTicketId - Draw only this ticket (and its children): the ticket modal's AI activity tab.
 * @param props.compactChrome - Hide the controls that only make sense for the whole team (the modal uses it).
 * @param props.scopeBar - Flow's scope bar says what is drawn and copies the link: no scope menu, scope head or link.
 */
export function TimelineTab({
  projectId,
  actions,
  scopeTicketId = null,
  compactChrome = false,
  scopeBar = false,
  initial = null,
  teamId = null,
  groups = false,
  scopeLabel = null,
}: {
  projectId: string;
  actions: TimelineActions;
  /** State to open with (from a link). */
  initial?: TimelineLink | null;
  scopeTicketId?: string | null;
  compactChrome?: boolean;
  scopeBar?: boolean;
  /** Draw only this team (and the teams that wrote to it): Flow's scope "one team". */
  teamId?: string | null;
  /** A header per team over its lead and roles, foldable (Flow). */
  groups?: boolean;
  /** What the scope is called, for the empty state ("Team Alpha", "KBM-7"). */
  scopeLabel?: string | null;
}) {
  const [preset, setPreset] = useState<Preset>(() => initial?.range ?? readRange(projectId));
  const [day, setDay] = useState<{ since: string; until: string } | null>(
    initial?.since && initial.until ? { since: initial.since, until: initial.until } : null,
  );
  const [scope, setScope] = useState<string | null>(scopeTicketId ?? initial?.scope ?? null);
  const [detailed, setDetailed] = useState(!!initial?.detailed);
  const [mode, setMode] = useState<AxisMode>(initial?.real ? 'real' : 'compact');
  const [hidden, setHidden] = useState<Set<string>>(new Set(initial?.hidden ?? []));
  const [table, setTable] = useState(false);
  const [selected, setSelected] = useState<Pick | null>(null);
  const [hover, setHover] = useState<{ pick: Pick; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<'scope' | 'show' | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [openQuiet, setOpenQuiet] = useState(false);
  // Flow: the teams whose roles are folded away under the team's header
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [width, setWidth] = useState(1100);
  const [pinned, setPinned] = useState(true);
  const [missed, setMissed] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  // the scroller is mounted anew when the range empties and fills again or the view changes: watch each one
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    setScrollEl(el);
  }, []);
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
    // a ticket asked for (the modal's tab) wins; the team view keeps the scope it opened on (a link) or was given
    if (scopeTicketId) setScope(scopeTicketId);
  }, [scopeTicketId]);

  const query = useMemo(
    () =>
      day
        ? { range: 'custom' as const, since: day.since, until: day.until, ticketId: scope, teamId }
        : { range: preset, ticketId: scope, teamId },
    [preset, day, scope, teamId],
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
  // After 3 s without data the loading state says it is still reading (design I, Loading)
  const [slow, setSlow] = useState(false);
  const loaded = !!data;
  useEffect(() => {
    if (loaded) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [loaded]);

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
    const el = scrollEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [scrollEl]);

  // Lifelines to draw: on a narrow window, AIs with nothing in the range fold into one strip
  const all = useMemo(() => data?.lifelines ?? [], [data]);
  const narrow = width - GUTTER < lanesWidth(all.length) && width < 900;
  const quiet = narrow && !openQuiet ? all.filter((l) => l.kind === 'ai' && l.quiet) : [];
  const foldedLanes = useMemo(
    () => new Set(groups ? all.filter((l) => !l.lead && l.teamId && folded.has(l.teamId)).map((l) => l.id) : []),
    [all, folded, groups],
  );
  const lifelines: TimelineLifeline[] = all.filter((l) => !quiet.includes(l) && !foldedLanes.has(l.id));
  // a folded team draws its lead only: the roles' bars and every arrow that touches a role are left out
  const drawn = useMemo(
    () =>
      data && foldedLanes.size
        ? {
            ...data,
            bars: data.bars.filter((b) => !foldedLanes.has(b.memberId)),
            arrows: data.arrows.filter((a) => !foldedLanes.has(a.from) && !foldedLanes.has(a.to)),
          }
        : data,
    [data, foldedLanes],
  );
  // the lanes fill the window (to a limit) instead of leaving the right half empty
  const col = columnFor(lifelines.length, width - GUTTER - (quiet.length ? 100 : 0));
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
  const people = useMemo(() => new Map(all.map((l) => [l.id, l])), [all]);

  // Esc closes the inspector
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setMenu(null);
        setCustomOpen(false);
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
        {slow && !q.isError && (
          <div className="at-hint" role="status" data-testid="tl-slow">
            Still loading {day ? 'this day' : SLOW_WORDS[preset]}
          </div>
        )}
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
      : (ms(day.until) ?? 0) - (ms(day.since) ?? 0) > 86400000 + 3600000
        ? `${shortDate(day.since)} – ${shortDate(new Date((ms(day.until) ?? 0) - 1).toISOString())}`
        : new Date(day.since).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : '';

  return (
    <div className="tl-root" data-testid="timeline-tab" ref={rootRef}>
      {paused && (
        <div className="at-now idle" data-testid="tl-paused-chip">
          <b>Right now</b> <b style={{ color: PAUSE_COLOR }}>No AI is running</b> · paused since{' '}
          {clockTime(data.pausedAt)}
        </div>
      )}
      {!paused && (
        // the server already drew only the scope (a Story's runs are its children's): nothing to filter here
        <LiveStripLite live={data.live} onPick={focusRun} />
      )}

      <div className="tl-toolbar">
        {!compactChrome && !scopeBar && (
          <div className="tl-menuwrap">
            <button
              type="button"
              className="tl-btn"
              onClick={() => setMenu(menu === 'scope' ? null : 'scope')}
              aria-haspopup="menu"
            >
              <Icon size={14} color="currentColor">
                {scope ? ICONS.page : PEOPLE}
              </Icon>
              {scope ? `One ticket: ${scope}` : 'Whole team'}
            </button>
            {menu === 'scope' && (
              <div className="tl-menu" role="menu" data-testid="tl-scope-menu">
                <div className="tl-menu-h">Scope</div>
                <button
                  type="button"
                  role="menuitem"
                  className={!scope ? 'on' : ''}
                  onClick={() => {
                    setScope(null);
                    setMenu(null);
                  }}
                >
                  <Icon size={15} color="currentColor">
                    {PEOPLE}
                  </Icon>
                  <span style={{ flex: 1 }}>Whole team</span>
                  {!scope && <Check />}
                </button>
                <div className="tl-menu-h">One ticket</div>
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
                      {isLive(data, id) ? (
                        <span className="at-live-dot working" />
                      ) : (
                        <Icon size={15} color="currentColor">
                          {ICONS.page}
                        </Icon>
                      )}
                      <span style={{ flex: 1 }}>
                        <b>{id}</b> {t.title}
                      </span>
                      {scope === id && <Check />}
                    </button>
                  ))}
                <div className="tl-menu-foot">Only the lifelines that took part are shown.</div>
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
            <Icon size={14} color="currentColor">
              <path d="M4 5h16l-6 7.5V19l-4-2v-4.5L4 5z" />
            </Icon>
            Show: {hidden.size ? 'some' : 'all'}
          </button>
          {menu === 'show' && (
            <div className="tl-menu" role="menu" data-testid="tl-show-menu">
              {[
                ['handoffs', 'Hand-offs'],
                ['questions', 'Questions and answers'],
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
          hidden={scopeBar}
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
        <div className="tl-menuwrap">
          <MenuSelect<RangeChoice>
            variant="button"
            label="Range"
            testId="tl-range"
            icon={<CalendarIcon />}
            value={day ? 'day' : preset}
            options={[
              ...PRESETS.map((p) => ({ value: p.id as RangeChoice, label: p.label })),
              ...(day ? [{ value: 'day' as const, label: dayLabel }] : []),
              { value: 'custom', label: 'Custom…' },
            ]}
            onChange={(v) => {
              if (v === 'custom') setCustomOpen(true);
              else if (v !== 'day') choose(v);
            }}
          />
          {customOpen && (
            <CustomRange
              initial={day}
              now={now}
              onClose={() => setCustomOpen(false)}
              onApply={(since, until) => {
                setDay({ since, until });
                setZoomWindow(false);
                setSelected(null);
                setCustomOpen(false);
              }}
            />
          )}
        </div>
        {paused ? (
          <span className="tl-follow paused">AI paused since {clockTime(data.pausedAt)}</span>
        ) : following && pinned ? (
          <span className="tl-follow on" data-testid="tl-following">
            <span className="at-live-dot working" /> Following live
          </span>
        ) : following ? (
          <button type="button" className="tl-follow back" onClick={toBottom} data-testid="tl-scrolled-back">
            Scrolled back{missed ? `: ${missed} new event${missed === 1 ? '' : 's'}` : ''}{' '}
            <LineIcon name="chevronDown" size={12} />
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
        <EmptyRange
          data={data}
          lifelines={lifelines}
          who={scopeLabel}
          onWiden={() => choose('7d')}
          onMap={actions.onSeeMap}
        />
      ) : (
        <div className="tl-stage">
          {scope && !scopeBar && (
            <div className="tl-scope-head" data-testid="tl-scope-head">
              <span className="tl-tchip">
                <i />
                <span>{scope}</span>
              </span>
              <b>{data.tickets[scope]?.title ?? ''}</b>
              <span className="at-hint">scoped timeline · {scopedWho(lifelines)}</span>
              <span style={{ flex: 1 }} />
              {actions.onOpenStory && (
                <button type="button" className="tl-btn" onClick={() => actions.onOpenStory?.(scope)}>
                  Open ticket flow
                </button>
              )}
            </div>
          )}
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
            ref={attachScroller}
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
              {groups && (
                <TimelineGroups
                  lifelines={lifelines}
                  all={all}
                  col={col}
                  folded={folded}
                  onToggle={(id) =>
                    setFolded((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                />
              )}
              <TimelineHeader
                // under a team's header a role's box says the role only ("Dev", not "Dev (Core team)")
                lifelines={
                  groups
                    ? lifelines.map((l) =>
                        l.teamId && !l.lead ? { ...l, name: l.name.replace(/\s*\(.*\)\s*$/, '') } : l,
                      )
                    : lifelines
                }
                folded={quiet.length}
                col={col}
                onOpenFolded={() => setOpenQuiet(true)}
                paused={paused}
              />
            </div>
            <div className="tl-gutter" style={{ width: GUTTER }}>
              <TimelineGutter axis={axis} now={now} />
              <NowPill axis={axis} now={now} paused={paused} />
            </div>
            <div className="tl-bodywrap">
              <TimelineBody
                data={drawn ?? data}
                axis={axis}
                lifelines={lifelines}
                col={col}
                now={now}
                detailed={detailed}
                selected={selected}
                onPick={setSelected}
                onHover={(p, at) => setHover(p && at ? { pick: p, x: at.x, y: at.y } : null)}
                hidden={hidden}
                ticketOf={ticketOf}
                scoped={!!scope}
                fresh={fresh}
              />
            </div>
          </div>
          {hover && !selected && (
            <HoverCard data={data} pick={hover.pick} x={hover.x} y={hover.y} people={people} now={now} />
          )}
          {selected && (
            <Inspector
              key={JSON.stringify(selected)}
              data={data}
              pick={selected}
              people={people}
              now={now}
              actions={actions}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      )}
      <Legend />
      <span className="tl-keyhint at-hint-sm">Tab moves between marks · Enter opens the inspector · Esc closes it</span>
    </div>
  );
}

const PEOPLE = (
  <path d="M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.5 3-6 6-6s6 2.5 6 6M16 5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3 2.6 3 5" />
);

function Check() {
  return (
    <Icon size={14} color="#2E6F40">
      {ICONS.check}
    </Icon>
  );
}

/** "Dev, Tester, Reviewer and you": the lifelines of a scoped Timeline, in words. */
function scopedWho(lifelines: TimelineLifeline[]): string {
  const ais = lifelines.filter((l) => l.kind === 'ai').map((l) => l.name);
  const you = lifelines.some((l) => l.kind === 'you');
  const all = you ? [...ais, 'you'] : ais;
  if (all.length <= 1) return all.join('');
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
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
  who,
  onWiden,
  onMap,
}: {
  data: Timeline;
  lifelines: TimelineLifeline[];
  /** What the scope is called: the empty state says whose work is missing. */
  who?: string | null;
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
      <b>
        {who ? `No work by ${who}` : 'No AI work'} between {clock(ms(data.since) ?? 0)} and now
      </b>
      <span className="at-hint">
        The lifelines stay so you can see who is on the team, all idle.
        {data.lastEndedAt ? ` The last run ended at ${clock(ms(data.lastEndedAt) ?? 0)}.` : ''}
      </span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="tl-btn primary" onClick={onWiden}>
          Widen to 7 days
        </button>
        {onMap && (
          <button type="button" className="tl-btn" onClick={onMap}>
            Open the map
          </button>
        )}
      </span>
    </div>
  );
}

/** Seven days: a band per day with what ran, what failed and what waited long; a click opens that day. */
function DayBands({ data, onPick }: { data: Timeline; onPick: (since: string, until: string) => void }) {
  type Day = { start: Date; runs: number; failed: number; long: number; hours: number[] };
  const days = new Map<string, Day>();
  const from = new Date(data.since);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (d.getTime() > (ms(data.until) ?? Date.now())) break;
    days.set(d.toDateString(), { start: d, runs: 0, failed: 0, long: 0, hours: new Array(24).fill(0) });
  }
  for (const b of data.bars) {
    const at = new Date(ms(b.queuedAt) ?? 0);
    const d = days.get(at.toDateString());
    if (!d) continue;
    d.runs += 1;
    d.hours[at.getHours()] += 1;
    if (b.endKind === 'failed' || b.endKind === 'memory' || b.endKind === 'timeout') d.failed += 1;
  }
  for (const w of data.waits) {
    const d = days.get(new Date(ms(w.from) ?? 0).toDateString());
    if (d && ((ms(w.to) ?? Date.now()) - (ms(w.from) ?? 0)) / 60000 > 10) d.long += 1;
  }
  // Newest first, seven days as drawn (design E5); the part-day at the start of the range shows only when it ran
  const list = [...days.values()].reverse().filter((d, i) => i < 7 || d.runs > 0);
  const peak = Math.max(1, ...list.flatMap((d) => d.hours));
  return (
    <div className="tl-days" data-testid="tl-days">
      <div className="tl-days-list">
        {list.map((d) => {
          const end = new Date(d.start.getFullYear(), d.start.getMonth(), d.start.getDate() + 1);
          const label = d.start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          const cells = (
            <>
              <b className="tl-day-date">{label}</b>
              <span className="tl-day-hours" aria-hidden={d.runs > 0}>
                {d.runs === 0 ? (
                  <span className="at-hint">nothing ran</span>
                ) : (
                  d.hours.map((n, h) => <i key={h} style={{ height: n ? Math.max(3, (n / peak) * 18) : 0 }} />)
                )}
              </span>
              <span className="tl-day-runs">
                {d.runs} run{d.runs === 1 ? '' : 's'}
              </span>
              <span className="tl-day-chips">
                {d.failed > 0 && <span className="tl-day-chip bad">{d.failed} failed</span>}
                {d.long > 0 && <span className="tl-day-chip wait">{d.long} waited long</span>}
              </span>
            </>
          );
          return d.runs === 0 ? (
            <div key={d.start.toISOString()} className="tl-day quiet">
              {cells}
            </div>
          ) : (
            <button
              key={d.start.toISOString()}
              type="button"
              className="tl-day"
              onClick={() => onPick(d.start.toISOString(), end.toISOString())}
            >
              {cells}
            </button>
          );
        })}
      </div>
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
      kind: `${b.label ?? `run #${b.number}`} ${b.state.replace('_', ' ')}`,
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
// Detail on demand: hover card and inspector (the same facts, one at a glance, one in full; ai-team-timeline.md, D)
// ---------------------------------------------------------------------------

type Tone = 'live' | 'done' | 'bad' | 'wait' | 'plain';
const TONE: Record<Tone, { bg: string; fg: string; dot: string }> = {
  live: { bg: '#E6F2EA', fg: '#1F5A31', dot: '#2E6F40' },
  done: { bg: '#F1F3F1', fg: '#5B6B60', dot: '#C7D2CB' },
  bad: { bg: '#FDECE8', fg: '#A5321E', dot: '#C4432A' },
  wait: { bg: '#FEF3D9', fg: '#7A5A06', dot: '#8A6A12' },
  plain: { bg: '#F1F5F2', fg: '#3A4A3E', dot: '#9AA8A0' },
};

interface Facts {
  /** The AI the card is about (an avatar), or an icon. */
  who?: TimelineLifeline;
  icon?: ReactNode;
  iconColor?: string;
  title: string;
  chip?: { text: string; tone: Tone };
  ticketId?: string | null;
  /** The words after the ticket chip: the ticket's title, or what the hand-off said. */
  ticketText?: string;
  lines: { text: string; strong?: string }[];
  /** What a click opens. */
  hint: string;
  pageId?: string;
  /** A Docs proposal still waiting for a person: the page opens to review it. */
  review?: boolean;
  bar?: TimelineBar;
  question?: { runId: string; text: string; options: string[]; from: number; to: number | null; open: boolean };
  note?: string;
}

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function barTone(b: TimelineBar): Tone {
  if (!b.endedAt && ['running', 'starting'].includes(b.state)) return 'live';
  if (b.state === 'needs_input' || b.state === 'queued') return 'wait';
  if (b.endKind && b.endKind !== 'ok') return 'bad';
  return 'done';
}

function tokensLine(b: TimelineBar): { text: string; strong?: string }[] {
  if (b.role) return []; // a role's tokens are part of the run's
  if (!b.tokensIn && !b.tokensOut)
    return b.metered ? [] : [{ strong: 'Not metered', text: ': a local runner reports no cost' }];
  const t = `${Math.round(b.tokensIn / 1000)}k tokens in, ${Math.round(b.tokensOut / 1000)}k out`;
  return b.metered
    ? [{ text: `${t} · $${b.costUsd.toFixed(2)}` }]
    : [{ text: t }, { strong: 'Not metered', text: ': a local runner reports no cost' }];
}

function factsOf(data: Timeline, pick: Pick, people: Map<string, TimelineLifeline>, now: number): Facts | null {
  const who = (id: string) => people.get(id)?.name ?? (id === 'you' ? 'You' : id);
  const ticketTitle = (id: string | null | undefined) => (id ? data.tickets[id]?.title : undefined);
  if (pick.type === 'bar') {
    const b = data.bars.find((x) => x.id === pick.id);
    if (!b) return null;
    const start = ms(b.startedAt);
    const end = ms(b.endedAt) ?? now;
    const lines: Facts['lines'] = [
      {
        text:
          b.state === 'queued'
            ? `Queued at ${clock(ms(b.queuedAt) ?? 0)} · ${lengthText(now - (ms(b.queuedAt) ?? now))} so far${b.heldByPause ? ' · held until resume' : ''}`
            : `Started ${clock(start ?? 0)} · ${lengthText(end - (start ?? end))}${b.endedAt ? '' : ' so far'} · ${b.endedAt ? `${b.steps} steps` : `step ${b.steps}`}`,
      },
    ];
    if (b.summary) lines.push({ text: b.summary });
    lines.push(...tokensLine(b));
    if (b.peakRssMb)
      lines.push({
        text: `Peak RAM ${fmtMb(b.peakRssMb)}${b.lastRssMb ? ` · ${b.endedAt ? 'last' : 'now'} ${fmtMb(b.lastRssMb)}` : ''}`,
      });
    for (const r of b.restarts) {
      const when = clock(ms(r.at) ?? 0);
      lines.push({
        text:
          r.by === 'system'
            ? `Restarted at ${when}${r.rssMb && r.limitMb ? `, ${fmtMb(r.rssMb)} over the ${fmtMb(r.limitMb)} limit` : ''}, restart ${r.n} of ${AUTO_RESTARTS}`
            : `Restarted at ${when} by ${r.by}`,
      });
    }
    if (b.endedReason && b.endKind !== 'ok') lines.push({ text: b.endedReason });
    return {
      who: people.get(b.memberId),
      title: `${who(b.memberId)} · ${b.label ?? `run #${b.number}`}`,
      chip: { text: cap1(endWord(b)), tone: barTone(b) },
      ticketId: b.ticketId,
      ticketText: ticketTitle(b.ticketId),
      lines,
      hint: 'Click for the steps',
      bar: b,
    };
  }
  if (pick.type === 'wait') {
    const w = data.waits.find((x) => x.id === pick.id);
    if (!w) return null;
    const from = ms(w.from) ?? now;
    const to = ms(w.to) ?? now;
    const open = !w.to;
    const q = w.kind === 'question';
    return {
      who: q ? people.get(w.memberId) : undefined,
      icon: q ? undefined : ICONS.lock,
      iconColor: '#B8860B',
      title: q
        ? `${who(w.memberId)} · ${open ? 'waiting for you' : 'question answered'}`
        : `${open ? 'Waiting for you' : cap1(w.status ?? 'decided')} · ${lengthText(to - from)}`,
      ticketId: w.ticketId,
      ticketText: ticketTitle(w.ticketId),
      lines: q
        ? [
            { text: `Asked at ${clock(from)} · ${lengthText(to - from)}${open ? ' so far' : ''}` },
            { text: `“${w.text}”` },
          ]
        : [
            { text: `${who(w.memberId)} asked: ${w.text}` },
            ...(w.risk ? [{ text: `Risk ${w.risk}${open ? ' · the run keeps going, this step waits' : ''}` }] : []),
          ],
      hint: q && open ? 'Click for the full question and Answer' : 'Click for details',
      question:
        q && w.runId ? { runId: w.runId, text: w.text, options: w.options ?? [], from, to: ms(w.to), open } : undefined,
    };
  }
  if (pick.type === 'arrow') {
    const a = data.arrows.find((x) => x.id === pick.id);
    if (!a) return null;
    const at = ms(a.at) ?? 0;
    const landed = ms(a.toAt);
    const waitMin = a.waitS != null ? a.waitS / 60 : landed ? (landed - at) / 60000 : 0;
    const lines: Facts['lines'] = [];
    lines.push({
      text:
        landed && landed - at > 60000 ? `Sent ${clock(at)} · ${who(a.to)} started ${clock(landed)}` : `At ${clock(at)}`,
    });
    if (waitMin >= 1) lines.push({ strong: `Waited ${lengthText(waitMin * 60000)}`, text: '' });
    if (a.summary && a.summary !== a.label) lines.push({ text: a.summary });
    if (a.by) lines.push({ text: `By ${a.by}` });
    if (a.count > 1) {
      const tickets = [...new Set(a.items.map((i) => i.ticketId).filter(Boolean))];
      lines.push({
        text: `${a.count} close events grouped${a.parentId ? ` (children of ${a.parentId})` : ''}${tickets.length ? `: ${tickets.join(', ')}` : ''}`,
      });
    }
    lines.push({ text: `Kind: ${arrowWord(a.kind)}` });
    if (a.skipped?.length) lines.push({ text: `Skipped: ${a.skipped.join(', ')}` });
    if (a.via === 'checks') lines.push({ text: 'The checks failed the work and sent it back' });
    return {
      icon: ICONS.arrow,
      iconColor: arrowStroke(a),
      title: `${cap1(arrowWord(a.kind))} · ${who(a.from)} to ${who(a.to)}`,
      ticketId: a.ticketId,
      ticketText: a.label ?? ticketTitle(a.ticketId),
      lines,
      hint: 'Click for details',
    };
  }
  if (pick.type === 'touch') {
    const t = data.touches.find((x) => x.id === pick.id);
    if (!t) return null;
    return {
      icon: <rect x="6" y="6" width="12" height="12" rx="2" transform="rotate(45 12 12)" />,
      iconColor: '#B8860B',
      title: t.what,
      chip: {
        text: t.mark.replace('_', ' '),
        tone: t.mark === 'avoidable' ? 'bad' : t.mark === 'needed' ? 'wait' : 'plain',
      },
      lines: [{ text: `${t.who}${t.via ? ` via ${t.via}` : ''} · ${clock(ms(t.at) ?? 0)}` }],
      ticketId: t.ticketId,
      ticketText: ticketTitle(t.ticketId),
      hint: 'Click for details',
    };
  }
  if (pick.type === 'doc') {
    const n = data.docs.find((x) => x.id === pick.id);
    if (!n) return null;
    return {
      icon: ICONS.page,
      iconColor: '#5B6B60',
      title: `Docs · ${n.title || 'a page'}`,
      lines: [
        {
          text:
            n.kind === 'proposal'
              ? `${who(n.memberId)} proposed ${n.changes ?? ''} change${n.changes === 1 ? '' : 's'} (v${n.version})`.replace(
                  '  ',
                  ' ',
                )
              : `${who(n.memberId)} wrote v${n.version} · ${clock(ms(n.at) ?? 0)}`,
        },
        ...(n.kind === 'proposal' && n.status === 'waiting'
          ? [{ text: `Waiting for you ${lengthText(now - (ms(n.at) ?? now))}` }]
          : []),
        ...(n.summary ? [{ text: n.summary }] : []),
      ],
      pageId: n.pageId,
      review: n.kind === 'proposal' && n.status === 'waiting',
      hint: 'Click to open the page',
    };
  }
  const p = data.pauses.find((x) => x.from === pick.id);
  if (!p) return null;
  return {
    icon: ICONS.pause,
    iconColor: PAUSE_COLOR,
    title: 'AI paused',
    lines: [
      {
        text: `By ${p.by ?? 'someone'} at ${clock(ms(p.from) ?? 0)}${p.to ? ` · resumed ${clock(ms(p.to) ?? 0)}${p.resumedBy ? ` by ${p.resumedBy}` : ''}` : ''}`,
      },
      ...(p.reason ? [{ text: `Reason: “${p.reason}”` }] : []),
      { text: 'The time inside the band is counted as paused: it is not waiting for you and not a bottleneck.' },
    ],
    hint: 'Click for details',
  };
}

function endWord(b: TimelineBar): string {
  if (b.heldByPause) return 'held until resume';
  if (!b.endedAt && b.state === 'running') return 'working';
  switch (b.endKind) {
    case 'ok':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'memory':
      return 'stopped: out of memory';
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

/** The small square with an AI's initials and colours. */
function Avatar({ l, size = 18 }: { l: TimelineLifeline; size?: number }) {
  const look = lookOf(l);
  const words = l.name.trim().split(/\s+/);
  const ini = (words.length > 1 ? words[0][0] + words[1][0] : l.name.slice(0, 2)).toUpperCase();
  return (
    <span
      className="tl-avatar"
      title={l.name}
      style={{
        width: size,
        height: size,
        borderRadius: size > 18 ? 6 : 5,
        background: look.fill,
        color: look.text,
        borderColor: look.stroke,
        fontSize: size > 18 ? 7 : 6,
      }}
    >
      {ini}
    </span>
  );
}

function CardHead({ f, size }: { f: Facts; size?: number }) {
  return (
    <>
      {f.who ? (
        <Avatar l={f.who} size={size} />
      ) : f.icon ? (
        <Icon color={f.iconColor} size={size && size > 18 ? 16 : 14}>
          {f.icon}
        </Icon>
      ) : null}
      <span>{f.title}</span>
      {f.chip && (
        <span className="tl-chip" style={{ background: TONE[f.chip.tone].bg, color: TONE[f.chip.tone].fg }}>
          <i style={{ background: TONE[f.chip.tone].dot }} />
          {f.chip.text}
        </span>
      )}
    </>
  );
}

function TicketLine({ id, text }: { id: string; text?: string }) {
  return (
    <div className="tl-card-line">
      <span className="tl-tchip">
        <i />
        <span>{id}</span>
      </span>{' '}
      {text}
    </div>
  );
}

function HoverCard({
  data,
  pick,
  x,
  y,
  people,
  now,
}: {
  data: Timeline;
  pick: Pick;
  x: number;
  y: number;
  people: Map<string, TimelineLifeline>;
  now: number;
}) {
  const f = factsOf(data, pick, people, now);
  if (!f) return null;
  return (
    <div
      className="tl-hover"
      role="tooltip"
      style={{ left: Math.min(x + 14, window.innerWidth - 316), top: Math.min(y + 14, window.innerHeight - 180) }}
    >
      <div className="tl-hover-head">
        <CardHead f={f} />
      </div>
      {f.ticketId && <TicketLine id={f.ticketId} text={f.ticketText} />}
      {f.lines.slice(0, 4).map((l, i) => (
        <div key={i} className="tl-card-line">
          {l.strong && <b style={l.strong.startsWith('Waited') ? { color: '#7A5A06' } : undefined}>{l.strong}</b>}
          {l.text}
        </div>
      ))}
      <span className="tl-hover-hint">{f.hint}</span>
    </div>
  );
}

/** A step's time is stored as hh:mm:ss in UTC without a date: put it on the run's day, in the person's time zone. */
function stepClock(at: string, runStart: number | null): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(at)) return clock(ms(at) ?? 0); // v2 writes the whole time
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(at);
  if (!m || runStart == null) return at.slice(0, 5);
  const d = new Date(runStart);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +m[1], +m[2], +(m[3] ?? 0));
  if (t < runStart - 60000) t += 86400000;
  return clock(t);
}

/** The newest steps of a run, read when the inspector opens (they are not part of the Timeline's data). */
function LatestSteps({ bar }: { bar: TimelineBar }) {
  const q = useAiRun(bar.runId);
  const run = q.data;
  if (!run) return q.isLoading ? <div className="at-hint">Reading the steps…</div> : null;
  const steps = run.steps
    .filter((s) => s.kind !== 'role')
    .reverse()
    .slice(0, 5);
  if (!steps.length) return null;
  const start = ms(bar.startedAt);
  return (
    <>
      <div className="tl-insp-h">Latest steps</div>
      <div>
        {steps.map((s, i) => (
          <div key={i} className="tl-step">
            <span className="at-hint">{stepClock(s.at, start)}</span>
            <span>{s.title}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Inspector({
  data,
  pick,
  people,
  now,
  actions,
  onClose,
}: {
  data: Timeline;
  pick: Pick;
  people: Map<string, TimelineLifeline>;
  now: number;
  actions: TimelineActions;
  onClose: () => void;
}) {
  const f = factsOf(data, pick, people, now);
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
  const b = f.bar;
  const started = b
    ? data.arrows.find((a) => a.runId === b.id && a.to === b.memberId && (a.kind === 'assign' || a.kind === 'handoff'))
    : undefined;
  const who = (id: string) => people.get(id)?.name ?? (id === 'you' ? 'You' : id);
  const q = f.question;
  return (
    <aside className="tl-inspector" aria-label="Details" data-testid="tl-inspector">
      <div className="tl-insp-head">
        <b>
          {q ? (
            <>
              <Icon color="#B8860B" size={16}>
                <path d="M12 4l9 16H3L12 4z" />
                <path d="M12 10v4M12 17v.5" />
              </Icon>
              Question from {people.get(data.waits.find((w) => w.id === pick.id)?.memberId ?? '')?.name ?? 'an AI'}
            </>
          ) : b ? (
            <>
              {f.who && <Avatar l={f.who} size={22} />}
              {f.title} on{' '}
              <span className="tl-tchip">
                <i />
                <span>{b.ticketId}</span>
              </span>
            </>
          ) : (
            <CardHead f={f} size={22} />
          )}
        </b>
        <button type="button" className="tl-x" onClick={onClose} aria-label="Close">
          <Icon size={14}>
            <path d="M6 6l12 12M18 6L6 18" />
          </Icon>
        </button>
      </div>
      {b ? (
        <>
          <div className="tl-insp-chips">
            {f.chip && (
              <span className="tl-chip" style={{ background: TONE[f.chip.tone].bg, color: TONE[f.chip.tone].fg }}>
                <i style={{ background: TONE[f.chip.tone].dot }} />
                {f.chip.text}
              </span>
            )}
            {b.startedAt && (
              <span className="tl-fact">
                <Icon size={12} color="#5B6B60">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3.5 2" />
                </Icon>
                {lengthText((ms(b.endedAt) ?? now) - (ms(b.startedAt) ?? now))}
              </span>
            )}
            <span className="tl-fact">
              <Icon size={12} color="#5B6B60">
                <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
              </Icon>
              step {b.steps}
            </span>
            {!b.role && (b.tokensIn > 0 || b.tokensOut > 0) && (
              <span className="tl-fact">
                <Icon size={12} color="#5B6B60">
                  <path d="M13 3L5 13h6l-1 8 8-10h-6z" />
                </Icon>
                {Math.round(b.tokensIn / 1000)}k in / {Math.round(b.tokensOut / 1000)}k out
              </span>
            )}
            <span className="tl-fact" hidden={!!b.role}>
              <Icon size={12} color="#5B6B60">
                <path d="M3 12V4h8l10 10-8 8z" />
                <circle cx="7.5" cy="8.5" r="1.2" />
              </Icon>
              {b.metered ? `$${b.costUsd.toFixed(2)}` : 'Not metered'}
            </span>
          </div>
          {data.tickets[b.ticketId] && <div className="at-hint">{data.tickets[b.ticketId].title}</div>}
          {f.lines
            .slice(1)
            .filter((l) => !l.strong && !/tokens in/.test(l.text))
            .map((l, i) => (
              <div key={i} className="tl-insp-line">
                {l.text}
              </div>
            ))}
          {f.note && <div className="at-hint">{f.note}</div>}
          <LatestSteps bar={b} />
          {(started || b.queuedAt) && (
            <>
              <div className="tl-insp-h">Started by</div>
              <div className="tl-insp-line">
                {started
                  ? `${who(started.from)}, ${arrowWord(started.kind)} at ${clock(ms(started.at) ?? 0)}`
                  : `${cap1(b.trigger.replace('_', ' '))} at ${clock(ms(b.queuedAt) ?? 0)}`}
                {b.startedAt && b.queuedAt && (ms(b.startedAt) ?? 0) - (ms(b.queuedAt) ?? 0) >= 60000
                  ? ` · queued ${lengthText((ms(b.startedAt) ?? 0) - (ms(b.queuedAt) ?? 0))}`
                  : ''}
              </div>
            </>
          )}
        </>
      ) : q ? (
        <>
          <div className="tl-question">“{q.text}”</div>
          <div className="at-hint">
            Asked {clock(q.from)} · {q.open ? 'waiting' : 'waited'} {lengthText((q.to ?? now) - q.from)}
            {f.ticketId ? (
              <>
                {' '}
                · blocks{' '}
                <span className="tl-tchip">
                  <i />
                  <span>{f.ticketId}</span>
                </span>
              </>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {f.ticketId && <TicketLine id={f.ticketId} text={f.ticketText} />}
          {f.lines.map((l, i) => (
            <div key={i} className="tl-insp-line">
              {l.strong && <b>{l.strong}</b>}
              {l.text}
            </div>
          ))}
          {f.note && <div className="at-hint">{f.note}</div>}
        </>
      )}
      {q?.open && (
        <div className="tl-answer">
          {q.options.length > 0 && (
            <>
              <div className="tl-insp-h">Suggested answers (from the AI)</div>
              <div className="tl-options">
                {q.options.map((o) => (
                  <button key={o} type="button" className="tl-option" disabled={busy} onClick={() => setText(o)}>
                    {o}
                  </button>
                ))}
              </div>
            </>
          )}
          <textarea
            className="tl-input"
            value={text}
            placeholder="Type an answer…"
            aria-label="Answer"
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void answer(text);
              }
            }}
          />
        </div>
      )}
      <div className="tl-insp-actions">
        {q?.open && (
          <button
            type="button"
            className="tl-btn primary"
            disabled={busy || !text.trim()}
            onClick={() => void answer(text)}
          >
            <Icon size={14}>
              <path d="M4 12l16-8-6 16-3-7-7-1z" />
            </Icon>
            Answer
          </button>
        )}
        {b && (
          <button type="button" className="tl-btn primary" onClick={() => openRun(b.runId)} data-testid="tl-open-run">
            Open the run
          </button>
        )}
        {f.ticketId && (
          <button type="button" className="tl-btn" onClick={() => actions.onOpenTicket(f.ticketId as string)}>
            Open the ticket
          </button>
        )}
        {f.ticketId && actions.onOpenStory && (
          <button type="button" className="tl-btn" onClick={() => actions.onOpenStory?.(f.ticketId as string)}>
            Open ticket flow
          </button>
        )}
        {f.pageId && (
          <button type="button" className="tl-btn primary" onClick={() => actions.onOpenDocsPage(f.pageId as string)}>
            {f.review ? 'Review changes' : 'Open the page'}
          </button>
        )}
      </div>
    </aside>
  );
}

function Legend() {
  // the glyph takes the colour the design gives it in the legend (report back is the darker grey here)
  const items: { k: Parameters<typeof arrowColor>[0]; t: string; c?: string }[] = [
    { k: 'assign', t: 'assigned' },
    { k: 'handoff', t: 'hand-off (dashed and moving while under way)' },
    { k: 'note', t: 'note from one team to another' },
    { k: 'report', t: 'report back (dotted)', c: '#5B6B60' },
    { k: 'ask', t: 'asks you' },
    { k: 'answer', t: 'your answer' },
  ];
  return (
    <div className="tl-legend" data-testid="tl-legend">
      {items.map((i) => (
        <span key={i.k}>
          <b style={{ color: i.c ?? arrowColor(i.k) }}>{arrowGlyph(i.k)}</b> {i.t}
        </span>
      ))}
      <span>Hatched amber: waiting for you · hatched grey: waiting for an AI or a runner</span>
      <span>
        <b style={{ color: '#E8821A' }}>●</b> restarted by the system (memory) · <b style={{ color: '#C4432A' }}>RAM</b>{' '}
        stopped by the system
      </span>
    </div>
  );
}
