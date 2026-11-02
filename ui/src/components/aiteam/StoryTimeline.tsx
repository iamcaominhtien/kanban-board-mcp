import { useMemo } from 'react';
import { useTimeline, type FlowStory, type ScopedTimeline } from '../../api/aiTeam';
import type { TeamRange } from '../../types/aiTeam';
import type { LitMark } from './StoryMap';

const DAY = 86_400_000;

/** The window the Timeline of a Story asks for: its whole life (`all`), or the range that was picked. */
export function storyWindow(
  range: TeamRange | null,
  now: number,
): { range: 'all' | 'custom' | 'today' | '7d'; since?: string; until?: string } {
  if (range === 'today' || range === '7d') return { range };
  if (range === '30d')
    return { range: 'custom', since: new Date(now - 30 * DAY).toISOString(), until: new Date(now).toISOString() };
  return { range: 'all' };
}

/** Ticks on a time axis: a step of 5 min to a day, at most about seven. */
export function axisTicks(t0: number, t1: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60000);
  const step = steps.find((s) => (t1 - t0) / s <= 7) ?? steps[steps.length - 1];
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}

function tickText(t: number, span: number): string {
  const d = new Date(t);
  if (span > 2 * DAY) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * The Timeline inside a Story (design/screens/ai-story-flow.md, I2): one row per child ticket with the PM on top. Bars
 * keep the colour of the AI that held the ticket, hatched amber is waiting for you, a blue diamond is a decision the
 * PM took for you, an amber diamond is you stepping in, the black line is now.
 */
export function StoryTimeline({
  projectId,
  storyId,
  story,
  range,
  lit = null,
  onHover,
  onOpenTicket,
  onOpenRun,
}: {
  projectId: string;
  storyId: string;
  story: FlowStory | null;
  range: TeamRange | null;
  lit?: LitMark | null;
  onHover?: (m: LitMark | null) => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenRun?: (runId: string) => void;
}) {
  // a picked month is fixed when it is picked, so the query key holds still
  const win = useMemo(() => storyWindow(range, Date.now()), [range]);
  const q = useTimeline(projectId, { ...win, story: storyId });
  const data = q.data as ScopedTimeline | undefined;
  if (!data) {
    return <div className="at-hint">{q.isError ? "Couldn't load the Timeline." : 'Drawing the Timeline…'}</div>;
  }
  return (
    <StoryTimelineView
      data={data}
      storyId={storyId}
      story={story}
      lit={lit}
      onHover={onHover}
      onOpenTicket={onOpenTicket}
      onOpenRun={onOpenRun}
    />
  );
}

/** The drawing of the Timeline inside a Story, from the answer (apart from the query, for the tests). */
export function StoryTimelineView({
  data,
  storyId,
  story,
  lit = null,
  onHover,
  onOpenTicket,
  onOpenRun,
}: {
  data: ScopedTimeline;
  storyId: string;
  story: FlowStory | null;
  lit?: LitMark | null;
  onHover?: (m: LitMark | null) => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const people = new Map(data.lifelines.map((l) => [l.id, l]));
  const pmId = story?.pm?.id ?? null;
  // the rows: the server's, else the tickets in the order their first run started; the PM first either way
  const rows = (
    data.rows?.length
      ? data.rows
      : [...new Set(data.bars.map((b) => b.ticketId))].map((id) => ({
          ticketId: id,
          title: data.tickets[id]?.title ?? '',
          status: data.tickets[id]?.status ?? '',
        }))
  ).filter((r) => r.ticketId !== storyId);
  const now = ms(data.now) || Date.now();
  const times = [
    ms(data.since),
    ...data.bars.flatMap((b) => [ms(b.startedAt ?? b.queuedAt), ms(b.endedAt)]),
    ...(data.decisions ?? []).map((d) => ms(d.at)),
  ].filter((t) => !Number.isNaN(t));
  const t0 = Math.min(...times, now);
  const t1 = Math.max(Math.min(ms(data.until) || now, now), ...times, t0 + 3_600_000);
  const span = t1 - t0;
  const pct = (t: number) => 1 + ((t - t0) / span) * 97;
  const nowPct = pct(Math.min(now, t1));
  const ended = !!story?.closedAt;

  const after = new Map((story?.plan?.items ?? []).map((i) => [i.ticketId, i.after]));
  const live = new Map(data.live.map((x) => [x.ticketId, x]));
  const sub = (r: { ticketId: string; status: string }) => {
    const x = live.get(r.ticketId);
    if (x)
      return `${x.memberName} is ${x.state === 'waiting_you' ? 'waiting for you' : x.state === 'queued' ? 'queued' : 'building'}`;
    const waits = after.get(r.ticketId) ?? [];
    const runs = data.bars.some((b) => b.ticketId === r.ticketId);
    if (!runs && waits.length) return `waits for ${waits.join(', ')}`;
    const answered = data.touches.filter((t) => t.ticketId === r.ticketId).length;
    const status = r.status ? r.status[0].toUpperCase() + r.status.slice(1).replace(/[_-]/g, ' ') : '';
    return [status, answered ? `you stepped in ${answered}` : ''].filter(Boolean).join(' · ');
  };

  // a second run of one AI on one ticket says "#2"
  const nth = new Map<string, number>();
  const label = (memberId: string, ticketId: string) => {
    const k = `${memberId}|${ticketId}`;
    const n = (nth.get(k) ?? 0) + 1;
    nth.set(k, n);
    const name = people.get(memberId)?.name ?? 'AI';
    return n > 1 ? `${name} #${n}` : name;
  };

  const bars = (ticketId: string | null, member?: string | null) => (
    <>
      {data.bars
        .filter((b) =>
          ticketId
            ? b.ticketId === ticketId
            : b.ticketId === storyId ||
              (member && b.memberId === member && !rows.some((r) => r.ticketId === b.ticketId)),
        )
        .map((b) => {
          const s = ms(b.startedAt ?? b.queuedAt);
          if (Number.isNaN(s)) return null;
          const e = ms(b.endedAt) || now;
          const color = people.get(b.memberId)?.color ?? '#5B6B60';
          const left = pct(s);
          const w = Math.max(pct(e) - left, 0.6);
          const text = label(b.memberId, b.ticketId);
          const isLit = !!lit && lit.memberId === b.memberId && (!lit.ticketId || lit.ticketId === b.ticketId);
          const bad = b.endKind === 'failed' || b.state === 'failed';
          return (
            <i
              key={b.id}
              className={`fs-stl-bar${isLit ? ' lit' : ''}`}
              style={{
                left: `${left}%`,
                width: `${w}%`,
                background: bad ? '#FDECE8' : `${color}22`,
                borderColor: bad ? '#C4432A' : color,
                color: bad ? '#A5321E' : color,
              }}
              title={`${text}${b.summary ? ` · ${b.summary}` : ''}`}
              onMouseEnter={() => onHover?.({ memberId: b.memberId, ticketId: b.ticketId })}
              onMouseLeave={() => onHover?.(null)}
              onClick={() => onOpenRun?.(b.id)}
              data-testid="story-bar"
            >
              {w > 5 ? (ticketId ? text : 'plan') : ''}
            </i>
          );
        })}
      {data.waits
        .filter((x) => (ticketId ? x.ticketId === ticketId : x.ticketId === storyId))
        .map((x) => {
          const s = ms(x.from);
          const e = ms(x.to) || now;
          if (Number.isNaN(s)) return null;
          return (
            <span
              key={x.id}
              className="fs-stl-wait"
              style={{ left: `${pct(s)}%`, width: `${Math.max(pct(e) - pct(s), 0.5)}%` }}
              title={x.text}
            />
          );
        })}
    </>
  );

  const ticks = axisTicks(t0, t1);
  const pmName = pmId ? (people.get(pmId)?.name ?? story?.pm?.name ?? 'PM') : (story?.pm?.name ?? 'PM');
  const touchesOn = (ticketId: string | null) =>
    data.touches.filter((t) =>
      ticketId ? t.ticketId === ticketId : t.ticketId === storyId || !rows.some((r) => r.ticketId === t.ticketId),
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="fs-stl" data-testid="story-timeline">
        <div className="fs-stl-head">
          <div className="fs-stl-left fs-h" style={{ padding: '8px 12px' }}>
            Held by, in time
          </div>
          <div className="fs-stl-axis">
            {ticks.map((t) => (
              <span key={t} style={{ left: `${pct(t)}%` }}>
                {tickText(t, span)}
              </span>
            ))}
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <div
            className={`fs-stl-row${lit?.memberId && lit.memberId === pmId ? ' lit' : ''}`}
            data-testid="story-row-pm"
          >
            <div className="fs-stl-left">
              <b style={{ fontSize: 12.5 }}>{pmName}</b>
              <span className="fs-hint" style={{ fontSize: 11 }}>
                plans, decides, closes
              </span>
            </div>
            <div className="fs-stl-lane">
              {bars(null, pmId)}
              {(data.decisions ?? []).map((d, k) => (
                <span
                  key={`d-${d.at}-${k}`}
                  className="fs-stl-dia"
                  style={{ left: `${pct(ms(d.at))}%`, background: '#2F6FB0' }}
                  title={`${pmName} decided for you: ${d.title}`}
                  data-testid="story-decision"
                />
              ))}
              {touchesOn(null).map((t) => (
                <span
                  key={t.id}
                  className="fs-stl-dia"
                  style={{ left: `${pct(ms(t.at))}%`, background: '#E8B93A' }}
                  title={`${t.who}: ${t.what}`}
                  data-testid="story-touch"
                />
              ))}
            </div>
          </div>
          {rows.map((r) => (
            <div
              key={r.ticketId}
              className={`fs-stl-row${lit?.ticketId === r.ticketId ? ' lit' : ''}`}
              data-testid={`story-row-${r.ticketId}`}
            >
              <div className="fs-stl-left">
                <button
                  type="button"
                  onClick={() => onOpenTicket(r.ticketId)}
                  style={{
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    textAlign: 'left',
                    font: 'inherit',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    minWidth: 0,
                  }}
                  title={`Open ${r.ticketId}`}
                >
                  <span className="fs-code" style={{ color: '#3A4A3E', fontSize: 11 }}>
                    {r.ticketId}
                  </span>
                  <b>{r.title}</b>
                </button>
                <span className="fs-hint" style={{ fontSize: 11 }}>
                  {sub(r)}
                </span>
              </div>
              <div className="fs-stl-lane">
                {bars(r.ticketId)}
                {touchesOn(r.ticketId).map((t) => (
                  <span
                    key={t.id}
                    className="fs-stl-dia"
                    style={{ left: `${pct(ms(t.at))}%`, background: '#E8B93A' }}
                    title={`${t.who}: ${t.what}`}
                    data-testid="story-touch"
                  />
                ))}
              </div>
            </div>
          ))}
          {!ended && (
            <i
              className="fs-stl-now"
              style={{ left: `calc(190px + (100% - 190px) * ${nowPct / 100})` }}
              data-testid="story-now"
            />
          )}
        </div>
      </div>
      <div className="fs-stl-legend">
        <span>Bars: who held the ticket, in their colour</span>
        <span>
          <b style={{ color: '#7A5A06' }}>Hatched amber</b>: waiting for you
        </span>
        <span>Blue diamond: a PM decision</span>
        <span>
          <b style={{ color: '#7A5A06' }}>Amber diamond</b>: you stepped in
        </span>
        <span>Black line: now</span>
      </div>
    </div>
  );
}
