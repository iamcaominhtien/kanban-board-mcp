import { useState } from 'react';
import { MenuSelect } from '../ui/MenuSelect';
import {
  useTouchActions,
  useTouches,
  type SteppedIn,
  type Touch,
  type TouchFilters,
  type TouchKind,
  type TouchMark,
  type TouchRange,
} from '../../api/aiTouches';
import { LoadError } from '../ai/aiUi';
import { openRun } from './runLink';
import { CalendarIcon, TicketChip } from './teamUi';
import './touches.css';

const RANGES: { value: TouchRange; label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

const MARK_LOOK: Record<TouchMark, { bg: string; fg: string; label: string; bar: string }> = {
  needed: { bg: '#FEF3D9', fg: '#7A5A06', label: 'Needed', bar: '#E8B93A' },
  avoidable: { bg: '#FDECE8', fg: '#A5321E', label: 'Avoidable', bar: '#C4432A' },
};

/** "Today 09:20", "Yesterday 17:40", "Oct 28 14:03". */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}

function csv(items: Touch[]): string {
  const cell = (v: string | null) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const rows = items.map((t) =>
    [t.at, t.who, t.label, t.teamName, t.ticketId, t.details, t.mark ? MARK_LOOK[t.mark].label : '']
      .map((v) => cell(v as string | null))
      .join(','),
  );
  return ['When,Who,What,Team,Ticket,Details,Mark', ...rows].join('\n');
}

/** The draft of the lesson a person writes from an avoidable touch. */
function draft(t: Touch): string {
  const on = t.ticketId ? ` on ${t.ticketId}` : '';
  return `${t.label}${on}: ${t.details} Next time, do this without a person.`.slice(0, 600);
}

function Row({
  t,
  projectId,
  onOpenTicket,
}: {
  t: Touch;
  projectId: string;
  onOpenTicket: (ticketId: string) => void;
}) {
  const { mark, lesson } = useTouchActions(projectId);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const pick = (m: TouchMark) => mark.mutate({ key: t.id, mark: t.mark === m ? null : m });
  const busy = mark.isPending || lesson.isPending;
  return (
    <div className="st-grid" data-testid="touch-row" data-touch={t.id}>
      <span className="at-hint" title={new Date(t.at).toLocaleString()}>
        {when(t.at)}
      </span>
      <span>
        {t.who}
        {t.via === 'mcp' && <span className="st-tag">via MCP</span>}
      </span>
      <span className="st-kind">{t.label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#244E78' }} title={t.teamName}>
          {t.teamName}
        </span>
        {t.ticketId && <TicketChip id={t.ticketId} onOpen={onOpenTicket} />}
        {t.runId && (
          <button type="button" className="ai-link" onClick={() => openRun(t.runId as string)}>
            Open run
          </button>
        )}
      </span>
      <span className="st-details">{t.details}</span>
      <span>
        <div className="st-mark" role="group" aria-label={`Mark this touch (${t.label})`}>
          {(['needed', 'avoidable'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={m}
              aria-pressed={t.mark === m}
              disabled={busy}
              title={m === 'needed' ? 'Only a person could supply this' : 'A rule, a note or a setting could remove it'}
              onClick={() => pick(m)}
            >
              {MARK_LOOK[m].label}
            </button>
          ))}
        </div>
        {t.mark === 'avoidable' &&
          (t.lessonId ? (
            <div className="at-hint-sm" style={{ marginTop: 4 }} data-testid="lesson-made">
              Lesson proposed. It waits in Memory.
            </div>
          ) : writing ? (
            <div className="st-lesson">
              <textarea
                aria-label="The lesson"
                value={text}
                onChange={(e) => setText(e.target.value)}
                data-testid="lesson-text"
              />
              <span style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  disabled={busy || !text.trim()}
                  data-testid="lesson-propose"
                  onClick={() =>
                    lesson.mutate({ key: t.id, text: text.trim() }, { onSuccess: () => setWriting(false) })
                  }
                >
                  Propose to Memory
                </button>
                <button type="button" className="st-btn st-btn-sm" onClick={() => setWriting(false)}>
                  Cancel
                </button>
              </span>
              {lesson.isError && (
                <span className="at-hint-sm" style={{ color: '#A5321E' }} role="alert">
                  Could not make the lesson. A lesson with this text may exist.
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="ai-link"
              style={{ marginTop: 4, display: 'block' }}
              data-testid="make-lesson"
              onClick={() => {
                setText(draft(t));
                setWriting(true);
              }}
            >
              Make a lesson
            </button>
          ))}
      </span>
    </div>
  );
}

/** You stepped in: every time a person touched the work of the project's AI teams, and whether it was needed. */
export function SteppedInTab({
  projectId,
  onOpenTicket,
  initialMark,
}: {
  projectId: string;
  onOpenTicket: (ticketId: string) => void;
  /** The mark the tab opens on (Health sends a person to the avoidable touches). */
  initialMark?: TouchMark;
}) {
  const [range, onRange] = useState<TouchRange>('7d');
  const [filters, setFilters] = useState<TouchFilters>(initialMark ? { mark: initialMark } : {});
  const q = useTouches(projectId, range, filters);
  const d: SteppedIn | undefined = q.data;
  if (!d) {
    return q.isError ? (
      <LoadError what="the touches" error={q.error} onRetry={() => void q.refetch()} />
    ) : (
      <span className="ai-spin" />
    );
  }
  const t = d.totals;
  const maxKind = Math.max(...d.kinds.map((k) => k.total), 1);
  const maxPer = Math.max(...d.teams.map((r) => r.per10Runs ?? 0), 1);
  const rangeLabel = RANGES.find((r) => r.value === range)?.label.toLowerCase() ?? '';
  const markOpt = (label: string, count: number | null, mark: TouchFilters['mark']) => (
    <button
      key={label}
      type="button"
      className={`at-opt${filters.mark === mark ? ' on' : ''}`}
      aria-pressed={filters.mark === mark}
      onClick={() => setFilters({ ...filters, mark })}
    >
      {label} {count != null && <b>{count}</b>}
    </button>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 24 }} data-testid="at-stepped">
      <div className="at-tiles">
        <div className="at-tile">
          <div className="at-label">Touches</div>
          <span className="at-total-n" data-testid="touch-total">
            {t.touches}
          </span>
          <div className="at-hint-sm">
            {t.tickets} ticket{t.tickets === 1 ? '' : 's'} with AI work, {rangeLabel}
            {t.perTicket != null ? ` · ${t.perTicket} per ticket` : ''}
          </div>
        </div>
        <div className="at-tile">
          <div className="at-label">Needed</div>
          <span className="at-total-n" style={{ color: '#7A5A06' }}>
            {t.needed}
          </span>
          <div className="at-hint-sm">only a person could supply it</div>
        </div>
        <div className="at-tile">
          <div className="at-label">Avoidable</div>
          <span className="at-total-n" style={{ color: '#A5321E' }}>
            {t.avoidable}
          </span>
          <div className="at-hint-sm">a rule, a note or a setting could remove it</div>
        </div>
        <div className="at-tile">
          <div className="at-label">Not marked yet</div>
          <span className="at-total-n" style={{ color: '#5B6B60' }}>
            {t.unmarked}
          </span>
          <div className="at-hint-sm">mark them: the marks teach the rules</div>
        </div>
      </div>

      <div className="at-two">
        <div className="at-box" style={{ flex: 1.3 }}>
          <b style={{ fontSize: 13.5, display: 'block', marginBottom: 6 }}>What you did</b>
          {d.kinds.length === 0 && <div className="at-hint">No touches in this range.</div>}
          {d.kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              className="at-barrow st-kindrow"
              style={{ gridTemplateColumns: '250px 1fr 26px' }}
              onClick={() => setFilters({ ...filters, kind: filters.kind === k.key ? undefined : k.key })}
              aria-pressed={filters.kind === k.key}
            >
              <span style={{ fontWeight: filters.kind === k.key ? 700 : 400 }}>{k.label}</span>
              <div className="at-bar" style={{ height: 10 }}>
                <i style={{ width: `${(k.total / maxKind) * 100}%`, background: '#2E6F40' }} />
              </div>
              <b style={{ textAlign: 'right' }}>{k.total}</b>
            </button>
          ))}
        </div>
        <div className="at-box" style={{ flex: 1 }}>
          <b style={{ fontSize: 13.5, display: 'block', marginBottom: 6 }}>Touches per 10 runs, by team</b>
          {d.teams.length === 0 && <div className="at-hint">No team yet.</div>}
          {d.teams.map((r) => (
            <div key={r.id} className="at-barrow" style={{ gridTemplateColumns: '120px 1fr 40px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>
                {r.name}
              </span>
              <div className="at-bar" style={{ height: 8 }}>
                <i
                  style={{
                    width: `${((r.per10Runs ?? 0) / maxPer) * 100}%`,
                    background: (r.per10Runs ?? 0) >= 3 ? '#C4432A' : '#9AA8A0',
                  }}
                />
              </div>
              <b style={{ textAlign: 'right' }} title={`${r.touches} touches on ${r.runs} runs`}>
                {r.per10Runs ?? '–'}
              </b>
            </div>
          ))}
        </div>
      </div>

      <div className="st-filters">
        {markOpt('All', t.touches, undefined)}
        {markOpt('Not marked', t.unmarked, 'unmarked')}
        {markOpt('Needed', t.needed, 'needed')}
        {markOpt('Avoidable', t.avoidable, 'avoidable')}
        <span style={{ flex: 1 }} />
        <MenuSelect<string>
          variant="chip"
          label="Team"
          prefix="Team:"
          testId="stepped-team-filter"
          value={filters.teamId ?? ''}
          options={[{ value: '', label: 'all' }, ...d.teams.map((r) => ({ value: r.id, label: r.name }))]}
          onChange={(v) => setFilters({ ...filters, teamId: v || undefined })}
        />
        <MenuSelect<string>
          variant="chip"
          label="Kind"
          prefix="Kind:"
          testId="stepped-kind-filter"
          value={filters.kind ?? ''}
          options={[{ value: '', label: 'all' }, ...d.allKinds.map((k) => ({ value: k.key, label: k.label }))]}
          onChange={(v) => setFilters({ ...filters, kind: (v || undefined) as TouchKind | undefined })}
        />
        <MenuSelect<TouchRange>
          variant="button"
          label="Range"
          icon={<CalendarIcon />}
          testId="stepped-range"
          value={range}
          options={RANGES}
          onChange={onRange}
        />
        <button
          type="button"
          className="st-btn st-btn-sm"
          disabled={!d.items.length}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([csv(d.items)], { type: 'text/csv' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `ai-touches-${range}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export CSV
        </button>
      </div>

      <div className="st-table" data-testid="touch-table">
        <div className="st-grid head">
          {['When', 'Who', 'What they did', 'Team and ticket', 'Details', 'Was it needed?'].map((h) => (
            <span key={h} className="at-label" style={{ fontSize: 11 }}>
              {h}
            </span>
          ))}
        </div>
        {d.items.length === 0 ? (
          <div className="at-hint" style={{ padding: 16 }} data-testid="touch-empty">
            {t.touches === 0 ? `Nobody had to step in ${rangeLabel}.` : 'No touch matches these filters.'}
            {t.touches === 0 && range !== '90d' && (
              <>
                {' '}
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => onRange(range === '24h' ? '7d' : range === '7d' ? '30d' : '90d')}
                >
                  Widen the range
                </button>
              </>
            )}
          </div>
        ) : (
          d.items.map((x) => <Row key={x.id} t={x} projectId={projectId} onOpenTicket={onOpenTicket} />)
        )}
        {d.truncated && (
          <div className="at-hint-sm" style={{ padding: '8px 16px' }}>
            Showing the newest 500.
          </div>
        )}
      </div>
    </div>
  );
}
