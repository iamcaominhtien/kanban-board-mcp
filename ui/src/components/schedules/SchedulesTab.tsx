import { useMemo, useState } from 'react';
import { extractError } from '../../api/extractError';
import {
  scheduleApi,
  useScheduleHistory,
  useScheduleList,
  useScheduleMutation,
  useScheduleWeek,
} from '../../api/schedules';
import type { Ticket } from '../../types';
import type { Schedule, ScheduleRun, ScheduleWeek, WeekItem } from '../../types/schedules';
import { AiAvatar, Toggle, useAiBoardState } from '../ai/aiUi';
import { useToast } from '../Toast';
import { TicketLine } from './MemberSelect';
import { useSchedules } from './SchedulesContext';
import {
  CalendarIcon,
  CheckChips,
  ChevronIcon,
  GridIcon,
  InfoIcon,
  ListIcon,
  PlusIcon,
  ReviewIcon,
  SlotChip,
  WarnIcon,
  clock,
  dayName,
  fmtDuration,
  fmtNext,
  fmtSlot,
  zoneLabel,
} from './schedulesUi';

type View = 'list' | 'week';
type Tab = 'upcoming' | 'paused' | 'history';

const GRID = 'sc-grid';

/** Local midnight of the Monday of the week `offset` weeks from now. */
function weekStart(offset: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="sc-empty" data-testid="schedules-empty">
      <div className="sc-empty-icon">
        <CalendarIcon size={22} />
      </div>
      <h3>No schedules yet</h3>
      <p>Let an AI work on a ticket at night or on a regular day, and have another AI check it.</p>
      <button type="button" className="ai-btn ai-btn-primary" onClick={onNew}>
        <PlusIcon size={13} /> New schedule
      </button>
    </div>
  );
}

function ListRow({ s, criteria, risk, onOpen }: { s: Schedule; criteria?: number; risk?: string; onOpen: () => void }) {
  const toast = useToast();
  const { members } = useAiBoardState();
  const ai = members.get(s.memberId);
  const reviewer = s.review.reviewerId ? members.get(s.review.reviewerId) : undefined;
  const toggle = useScheduleMutation((on: boolean) => (on ? scheduleApi.resume(s.id) : scheduleApi.pause(s.id)));
  const dim = s.state !== 'active';
  const last = s.lastRun;
  return (
    <div
      className={`${GRID} sc-row-item ${dim ? 'sc-dim' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid="schedule-row"
      data-ticket={s.ticketId}
    >
      <div className="sc-cell-main">
        <div className="sc-inline" style={{ gap: 8, minWidth: 0 }}>
          <TicketLine id={s.ticketId} status={s.ticketStatus} />
          <span className="sc-ttitle sc-strong">{s.ticketTitle}</span>
        </div>
        <div className="ai-muted sc-when">
          {s.kind === 'repeat' ? '↻' : '▫'} {s.when}
        </div>
      </div>
      <div className="sc-inline" style={{ gap: 8, minWidth: 0 }}>
        {ai ? <AiAvatar provider={ai.provider} size={24} /> : null}
        <span className="sc-strong sc-ellipsis">{s.memberName}</span>
      </div>
      <div>
        {s.state === 'active' && s.nextRunAt ? (
          <>
            <div className="sc-strong">{fmtNext(s.nextRunAt)}</div>
            <div className="ai-hint">{s.nextIn}</div>
            {risk && (
              <div className="sc-risk">
                <WarnIcon size={12} /> {risk}
              </div>
            )}
          </>
        ) : s.state === 'paused' ? (
          <>
            <div className="sc-strong">{s.failuresInRow >= 3 ? `Paused after ${s.failuresInRow} fails` : 'Paused'}</div>
            <div className="ai-hint">Resume to continue</div>
          </>
        ) : (
          <>
            <div className="sc-strong">Finished</div>
            <div className="ai-hint">{last ? fmtSlot(last.slotAt) : ''}</div>
          </>
        )}
      </div>
      <div className="sc-chips">
        <CheckChips schedule={s} criteria={criteria} />
      </div>
      <div className="sc-inline" style={{ gap: 7 }}>
        {s.review.on && s.review.reviewerName ? (
          <>
            {reviewer ? <AiAvatar provider={reviewer.provider} size={20} /> : <ReviewIcon size={14} />}
            <span className="sc-ellipsis">{s.review.reviewerName}</span>
          </>
        ) : (
          <span className="ai-muted" style={{ fontSize: 12.5 }}>
            Off
          </span>
        )}
      </div>
      <div>
        {last ? (
          <SlotChip state={last.state} failures={last.state === 'failed' ? s.failuresInRow : undefined} />
        ) : (
          <span className="ai-muted" style={{ fontSize: 12.5 }}>
            Never run
          </span>
        )}
      </div>
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Toggle
          on={s.state === 'active'}
          disabled={s.state === 'ended' || toggle.isPending}
          label={
            s.state === 'active' ? `Pause the schedule for ${s.ticketId}` : `Resume the schedule for ${s.ticketId}`
          }
          testId="row-toggle"
          onChange={async (on) => {
            try {
              await toggle.mutateAsync(on);
            } catch (err) {
              toast.error("Couldn't change the schedule", extractError(err));
            }
          }}
        />
      </div>
    </div>
  );
}

function ListHeader() {
  return (
    <div className={`${GRID} sc-head`}>
      <span>SCHEDULE</span>
      <span>AI</span>
      <span>NEXT RUN</span>
      <span>DONE WHEN</span>
      <span>AI REVIEW</span>
      <span>LAST RUN</span>
      <span />
    </div>
  );
}

function LocalNote({ items }: { items: Schedule[] }) {
  const local = items.filter((s) => s.connection === 'local' && s.state !== 'ended');
  if (!local.length) return null;
  const hours = [...new Set(local.filter((s) => s.catchUp === 'run').map((s) => s.catchUpHours))];
  const owners = [...new Set(local.map((s) => s.createdBy))];
  return (
    <div className="ai-notice ai-notice-slate sc-local" data-testid="local-note">
      <InfoIcon size={16} />
      <div>
        <b>Local runners only run while the desktop app is open</b>
        <div>
          {local.length} of these schedules use a local runner. If it is offline at the time, the run starts when it is
          back{hours.length === 1 ? ` (up to ${hours[0]} hour${hours[0] === 1 ? '' : 's'})` : ''}, then{' '}
          {owners.length === 1 ? owners[0] : 'its owner'} is told.
        </div>
      </div>
    </div>
  );
}

function HistoryTable({
  runs,
  schedules,
  onOpen,
}: {
  runs: ScheduleRun[];
  schedules: Map<string, Schedule>;
  onOpen: (scheduleId: string) => void;
}) {
  if (!runs.length)
    return (
      <div className="ai-card sc-empty" style={{ margin: 0 }} data-testid="history-empty">
        <h3>No runs yet</h3>
        <p>Every planned start shows up here, with how it ended.</p>
      </div>
    );
  return (
    <div className="ai-card sc-table" data-testid="history-table">
      <div className="sc-hgrid sc-head">
        <span>TIME</span>
        <span>SCHEDULE</span>
        <span>AI</span>
        <span>RESULT</span>
        <span>NOTE</span>
        <span style={{ textAlign: 'right' }}>TIME TAKEN</span>
      </div>
      {runs.map((r) => {
        const s = schedules.get(r.scheduleId);
        return (
          <div
            key={r.id}
            className="sc-hgrid sc-row-item"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(r.scheduleId)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(r.scheduleId)}
            data-testid="history-row"
          >
            <b>{fmtSlot(r.slotAt)}</b>
            <span className="sc-inline" style={{ gap: 8, minWidth: 0 }}>
              <TicketLine id={r.ticketId} title={s?.ticketTitle} status={s?.ticketStatus} />
            </span>
            <span className="sc-ellipsis">{r.memberName ?? s?.memberName ?? ''}</span>
            <span>
              <SlotChip state={r.state} verbose />
            </span>
            <span className="ai-hint sc-ellipsis" title={r.note ?? ''}>
              {r.note}
            </span>
            <span className="ai-hint" style={{ textAlign: 'right' }}>
              {fmtDuration(r.durationS)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const PAST_TONE: Record<string, string> = {
  passed: 'sc-wi-ok',
  partly: 'sc-wi-warn',
  failed: 'sc-wi-bad',
};

/** One chip in the week grid. */
function WeekChip({ item, onOpen }: { item: WeekItem; onOpen: () => void }) {
  const tone = item.paused
    ? 'sc-wi-paused'
    : item.kind === 'past'
      ? (PAST_TONE[item.state ?? ''] ?? 'sc-wi-paused')
      : item.overlap || item.risk
        ? 'sc-wi-warn'
        : 'sc-wi-ok';
  const label: Record<string, string> = {
    passed: 'Finished',
    partly: 'Partly done',
    failed: 'Failed',
    skipped: 'Skipped',
    cancelled: 'Cancelled',
    running: 'Running',
    reviewing: 'In review',
    fixing: 'Fixing',
    waiting: 'Waiting for runner',
    ask: 'Late: run it?',
  };
  return (
    <button type="button" className={`sc-wi ${tone}`} onClick={onOpen} data-testid="week-item" data-kind={item.kind}>
      {item.kind === 'review' ? (
        <span>
          <span className="ai-mono">after run</span> Review {item.ticketId}
        </span>
      ) : (
        <span>
          <span className="ai-mono">{clock(item.at)}</span> {item.ticketId}
        </span>
      )}
      {item.paused && <span className="sc-wi-sub">Paused</span>}
      {!item.paused && item.overlap && <span className="sc-wi-sub">Overlaps: will queue</span>}
      {!item.paused && item.risk && <span className="sc-wi-sub">{item.risk}</span>}
      {!item.paused && item.kind === 'past' && item.state && <span className="sc-wi-sub">{label[item.state]}</span>}
    </button>
  );
}

/** Slots of the week that are worth drawing: the plan from now on, and what really ran (no double entries). */
function weekItems(week: ScheduleWeek, now: number): WeekItem[] {
  const past = week.items.filter((i) => i.kind === 'past');
  const ranAt = new Set(past.map((i) => `${i.scheduleId}|${new Date(i.at).getTime()}`));
  return week.items.filter((i) => {
    if (i.kind === 'past') return true;
    const at = new Date(i.at).getTime();
    if (at < now - 60000) return false;
    if (i.kind === 'run') return !ranAt.has(`${i.scheduleId}|${at}`);
    // a review follows its run by up to 30 min: hide it when that run already has a record
    return !past.some(
      (p) =>
        p.scheduleId === i.scheduleId && at - new Date(p.at).getTime() <= 31 * 60000 && at >= new Date(p.at).getTime(),
    );
  });
}

function WeekView({
  projectId,
  offset,
  aiFilter,
  ticketFilter,
  onOpen,
}: {
  projectId: string;
  offset: number;
  aiFilter: string;
  ticketFilter: string | null;
  onOpen: (scheduleId: string) => void;
}) {
  const start = weekStart(offset);
  const q = useScheduleWeek(projectId, start.toISOString(), 7);
  const { members: aiMap } = useAiBoardState();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const todayKey = new Date().toDateString();
  const items = useMemo(
    () => (q.data ? weekItems(q.data, Date.now()) : []).filter((i) => !ticketFilter || i.ticketId === ticketFilter),
    [q.data, ticketFilter],
  );
  const rows = (q.data?.members ?? [])
    .filter((m) => !aiFilter || m.id === aiFilter)
    .filter((m) => items.some((i) => i.memberId === m.id));
  if (q.isLoading) return <span className="ai-spin" />;
  if (!rows.length)
    return (
      <div className="ai-card sc-empty" data-testid="week-empty">
        <h3>Nothing planned this week</h3>
        <p>Runs show here one row per AI. Use the arrows to look at another week.</p>
      </div>
    );
  return (
    <div className="ai-card sc-week" data-testid="week-view">
      <div className="sc-wgrid sc-head">
        <span>AI</span>
        {days.map((d) => {
          const today = d.toDateString() === todayKey;
          return (
            <span key={d.toISOString()} className={today ? 'sc-today' : ''}>
              {dayName(d)} {d.getDate()}
              {today ? ' · today' : ''}
            </span>
          );
        })}
      </div>
      {rows.map((m) => {
        const ai = aiMap.get(m.id);
        const reviewerOnly = !items.some((i) => i.memberId === m.id && i.kind !== 'review');
        return (
          <div key={m.id} className="sc-wgrid sc-wrow" data-testid="week-row">
            <div className="sc-wlabel">
              <span className="sc-inline" style={{ gap: 8, alignItems: 'flex-start' }}>
                {ai && <AiAvatar provider={ai.provider} size={24} />}
                <b>{m.name}</b>
              </span>
              <span className="ai-hint">
                {m.connection === 'local' ? 'Local runner' : m.connection === 'api_key' ? 'API key' : ''}
                {reviewerOnly ? ' · reviewer' : ''}
              </span>
            </div>
            {days.map((d) => (
              <div key={d.toISOString()} className={`sc-wcell ${d.toDateString() === todayKey ? 'sc-wtoday' : ''}`}>
                {items
                  .filter((i) => i.memberId === m.id && new Date(i.at).toDateString() === d.toDateString())
                  .map((i) => (
                    <WeekChip key={`${i.scheduleId}-${i.at}-${i.kind}`} item={i} onOpen={() => onOpen(i.scheduleId)} />
                  ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Schedules tab (B): a list of what runs next and how the last run went, a week view with one row per AI,
 * and the history of every planned start.
 */
export function SchedulesTab({ projectId, tickets }: { projectId: string; tickets: Ticket[] }) {
  const { openEditor, openDetail, ticketFilter, setTicketFilter } = useSchedules();
  const { members: aiMap } = useAiBoardState();
  const list = useScheduleList(projectId);
  const [view, setView] = useState<View>('list');
  const [tab, setTab] = useState<Tab>('upcoming');
  const [aiFilter, setAiFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const history = useScheduleHistory(projectId, view === 'list' && tab === 'history');
  // Offline risks of the next two weeks, shown under a run time
  const horizon = useMemo(() => weekStart(0).toISOString(), []);
  const risks = useScheduleWeek(projectId, horizon, 14, view === 'list');

  const all = list.data?.items ?? [];
  const items = all
    .filter((s) => !aiFilter || s.memberId === aiFilter)
    .filter((s) => !ticketFilter || s.ticketId === ticketFilter);
  const ticketMap = new Map(tickets.map((t) => [t.id, t]));
  const riskOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of risks.data?.items ?? []) if (i.risk && !m.has(i.scheduleId)) m.set(i.scheduleId, i.risk);
    return m;
  }, [risks.data]);
  const active = items.filter((s) => s.state === 'active');
  const paused = items.filter((s) => s.state === 'paused');
  const ended = items.filter((s) => s.state === 'ended');
  const shown = tab === 'upcoming' ? [...active, ...ended] : paused;
  const historyRuns = (history.data ?? [])
    .filter((r) => !aiFilter || r.memberId === aiFilter)
    .filter((r) => !ticketFilter || r.ticketId === ticketFilter);
  const scheduleMap = new Map(all.map((s) => [s.id, s]));
  const ticketOptions = [...new Map(all.map((s) => [s.ticketId, s.ticketTitle])).entries()];
  const aiOptions = [...new Map(all.map((s) => [s.memberId, s.memberName])).entries()];
  const tzNote = zoneLabel(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const end = new Date(weekStart(offset));
  end.setDate(end.getDate() + 6);
  const range = (() => {
    const s = weekStart(offset);
    const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return s.getMonth() === end.getMonth() ? `${f(s)} – ${end.getDate()}` : `${f(s)} – ${f(end)}`;
  })();
  const filtersOn = !!aiFilter || !!ticketFilter;

  if (list.isLoading)
    return (
      <div className="ai-root sc-page">
        <span className="ai-spin" />
      </div>
    );
  const empty = !all.length;

  return (
    <div className="ai-root sc-page" data-testid="schedules-tab">
      <div className="sc-bar">
        <div className="sc-seg" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            className={view === 'list' ? 'sc-seg-on' : ''}
            onClick={() => setView('list')}
            data-testid="view-list"
          >
            <ListIcon size={14} /> List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'week'}
            className={view === 'week' ? 'sc-seg-on' : ''}
            onClick={() => setView('week')}
            data-testid="view-week"
          >
            <GridIcon size={14} /> Week
          </button>
        </div>
        {view === 'list' && !empty && (
          <div className="sc-seg" role="tablist" aria-label="Show">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'upcoming'}
              className={tab === 'upcoming' ? 'sc-seg-on' : ''}
              onClick={() => setTab('upcoming')}
              data-testid="tab-upcoming"
            >
              Upcoming · {filtersOn ? active.length : list.data?.counts.upcoming}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'paused'}
              className={tab === 'paused' ? 'sc-seg-on' : ''}
              onClick={() => setTab('paused')}
              data-testid="tab-paused"
            >
              Paused · {filtersOn ? paused.length : list.data?.counts.paused}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={tab === 'history' ? 'sc-seg-on' : ''}
              onClick={() => setTab('history')}
              data-testid="tab-history"
            >
              History · {list.data?.counts.history}
            </button>
          </div>
        )}
        {view === 'week' && (
          <div className="sc-inline" style={{ gap: 8 }}>
            <button
              type="button"
              className="ai-icobtn"
              aria-label="Previous week"
              onClick={() => setOffset(offset - 1)}
              data-testid="week-prev"
            >
              <ChevronIcon size={15} dir="left" />
            </button>
            <b data-testid="week-range">{range}</b>
            <button
              type="button"
              className="ai-icobtn"
              aria-label="Next week"
              onClick={() => setOffset(offset + 1)}
              data-testid="week-next"
            >
              <ChevronIcon size={15} dir="right" />
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => setOffset(0)}
              disabled={offset === 0}
              data-testid="week-today"
            >
              Today
            </button>
          </div>
        )}
        <span className="sc-grow" />
        {view === 'week' && (
          <span className="ai-hint sc-tznote">One row per AI. Times are in your time zone ({tzNote}).</span>
        )}
        {!empty && (
          <>
            <select
              className="ai-select sc-filter"
              value={aiFilter}
              onChange={(e) => setAiFilter(e.target.value)}
              aria-label="Filter by AI"
              data-testid="filter-ai"
            >
              <option value="">All AI</option>
              {aiOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name ?? aiMap.get(id)?.name}
                </option>
              ))}
            </select>
            <select
              className="ai-select sc-filter"
              value={ticketFilter ?? ''}
              onChange={(e) => setTicketFilter(e.target.value || null)}
              aria-label="Filter by ticket"
              data-testid="filter-ticket"
            >
              <option value="">All tickets</option>
              {ticketOptions.map(([id, title]) => (
                <option key={id} value={id}>
                  {id} · {title ?? ticketMap.get(id)?.title}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          onClick={() => openEditor(ticketFilter ? { ticketId: ticketFilter } : {})}
          data-testid="new-schedule"
        >
          <PlusIcon size={13} /> New schedule
        </button>
      </div>

      {empty ? (
        <EmptyState onNew={() => openEditor()} />
      ) : view === 'week' ? (
        <WeekView
          projectId={projectId}
          offset={offset}
          aiFilter={aiFilter}
          ticketFilter={ticketFilter}
          onOpen={openDetail}
        />
      ) : tab === 'history' ? (
        history.isLoading ? (
          <span className="ai-spin" />
        ) : (
          <HistoryTable runs={historyRuns} schedules={scheduleMap} onOpen={openDetail} />
        )
      ) : (
        <>
          {shown.length ? (
            <div className="ai-card sc-table" data-testid="schedule-table">
              <ListHeader />
              {shown.map((s) => (
                <ListRow
                  key={s.id}
                  s={s}
                  criteria={ticketMap.get(s.ticketId)?.acceptanceCriteria?.length}
                  risk={riskOf.get(s.id)}
                  onOpen={() => openDetail(s.id)}
                />
              ))}
            </div>
          ) : (
            <div className="ai-card sc-empty" data-testid="tab-empty">
              <h3>{tab === 'paused' ? 'Nothing is paused' : 'Nothing upcoming'}</h3>
              <p>{filtersOn ? 'No schedule matches these filters.' : 'New schedules show here.'}</p>
            </div>
          )}
          <LocalNote items={items} />
        </>
      )}
    </div>
  );
}
