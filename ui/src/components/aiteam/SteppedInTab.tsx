import { useEffect, useRef, useState } from 'react';
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
import { extractError } from '../../api/extractError';
import { LoadError } from '../ai/aiUi';
import { openRun } from './runLink';
import { CalendarIcon, Icon, TicketChip } from './teamUi';
import './touches.css';

const FILTER_MENU = { minHeight: 30, height: 30, padding: '0 10px', fontSize: 12 } as const;

const LESSON_MAX = 600;

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
  // A cell that starts with = + - @ (or a tab or return) would run as a formula in a spreadsheet: an apostrophe first
  const cell = (v: string | null) => {
    const text = v ?? '';
    return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const rows = items.map((t) =>
    [t.at, t.who, t.label, t.teamName, t.ticketId, t.details, t.mark ? MARK_LOOK[t.mark].label : '']
      .map((v) => cell(v as string | null))
      .join(','),
  );
  return ['When,Who,What,Team,Ticket,Details,Mark', ...rows].join('\n');
}

function download(items: Touch[], range: string): void {
  const url = URL.createObjectURL(new Blob([csv(items)], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-touches-${range}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The draft of the lesson a person writes from an avoidable touch. */
function draft(t: Touch): string {
  const head = `${t.label}${t.ticketId ? ` on ${t.ticketId}` : ''}: `;
  const tail = ' Next time, do this without a person.';
  let details = t.details.split(/\s+/).filter(Boolean).join(' ');
  const room = LESSON_MAX - head.length - tail.length - 1; // one for the full stop
  // Too long: the middle is shortened, the ending stays
  if (details.length > room) details = `${details.slice(0, Math.max(room - 1, 0)).trimEnd()}…`;
  // Only . ! ? end a sentence: a closing quote is followed by the full stop
  if (details && !/[.!?…]$/.test(details)) details += '.';
  return `${head}${details}${tail}`;
}

/** The funnel before the Team and Kind filters (AiTeamReview A3). */
const FUNNEL = (
  <Icon size={12} color="#5B6B60">
    <path d="M4 5h16l-6 7.5V19l-4-2v-4.5L4 5z" />
  </Icon>
);

/** One colour per person, from their name (the design draws purple, blue and amber avatars). */
const AVATARS = [
  { bg: '#EFEAFB', fg: '#5B4BB5' },
  { bg: '#E1EEFB', fg: '#1F5A8E' },
  { bg: '#FDF3E3', fg: '#8A5A00' },
  { bg: '#E3F3EA', fg: '#1F5A31' },
  { bg: '#FBE9EE', fg: '#9C2F4A' },
];

function Person({ name }: { name: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = (
    words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '').slice(0, 2)
  ).toUpperCase();
  const look = AVATARS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATARS.length];
  return (
    <span className="st-person">
      <span className="st-avatar" style={{ background: look.bg, color: look.fg }} aria-hidden="true">
        {initials}
      </span>
      <span>{name}</span>
    </span>
  );
}

/** The text box of the lesson: takes the focus when it opens and grows with what is written. */
function LessonBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <>
      <textarea
        ref={ref}
        rows={1}
        maxLength={LESSON_MAX}
        aria-label="The lesson"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="lesson-text"
      />
      <span className="st-count" aria-hidden="true">
        {value.length}/{LESSON_MAX}
      </span>
    </>
  );
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
  // One request at a time: a second click before the first answer must not send a second one
  const flight = useRef(false);
  const linkRef = useRef<HTMLButtonElement>(null);
  const madeRef = useRef<HTMLDivElement>(null);
  const back = useRef<'link' | 'made' | null>(null);
  const send = (go: (done: () => void) => void) => {
    if (flight.current) return;
    flight.current = true;
    go(() => {
      flight.current = false;
    });
  };
  const pick = (m: TouchMark) =>
    send((done) => mark.mutate({ key: t.id, mark: t.mark === m ? null : m }, { onSettled: done }));
  const busy = mark.isPending || lesson.isPending;
  const open = () => {
    lesson.reset();
    mark.reset();
    setText(draft(t));
    setWriting(true);
  };
  const close = (to: 'link' | 'made' | null) => {
    lesson.reset();
    back.current = to;
    setWriting(false);
  };
  // After the panel closes the focus goes back to what opened it (or to the note that the lesson was proposed)
  useEffect(() => {
    if (writing || !back.current) return;
    const el = back.current === 'made' ? madeRef.current : linkRef.current;
    if (el) {
      el.focus();
      back.current = null;
    }
  }, [writing, t.lessonId, t.mark]);
  return (
    <div className="st-row" data-testid="touch-row" data-touch={t.id}>
      <div className="st-grid">
        <span className="at-hint" title={new Date(t.at).toLocaleString()}>
          {when(t.at)}
        </span>
        <span>
          <Person name={t.who} />
          {t.via === 'mcp' && <span className="st-tag">via MCP</span>}
        </span>
        <span className="st-kind">{t.label}</span>
        <span className="st-where">
          <span className="st-team" title={t.teamName}>
            {t.teamName}
          </span>
          {t.ticketId && <TicketChip id={t.ticketId} onOpen={onOpenTicket} />}
          {t.runId && (
            <button type="button" className="st-open" onClick={() => openRun(t.runId as string)}>
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
                disabled={busy || !!t.lessonId}
                title={
                  m === 'needed' ? 'Only a person could supply this' : 'A rule, a note or a setting could remove it'
                }
                onClick={() => pick(m)}
              >
                {MARK_LOOK[m].label}
              </button>
            ))}
          </div>
          {mark.isError && (
            <div className="st-error" role="alert">
              {extractError(mark.error)}
            </div>
          )}
          {t.mark === 'avoidable' &&
            (t.lessonId ? (
              <div
                ref={madeRef}
                tabIndex={-1}
                className="at-hint-sm st-made"
                style={{ marginTop: 4 }}
                data-testid="lesson-made"
              >
                Lesson proposed. It waits in Memory.
              </div>
            ) : (
              !writing && (
                <button
                  ref={linkRef}
                  type="button"
                  className="st-open st-lesson-link"
                  data-testid="make-lesson"
                  onClick={open}
                >
                  Make a lesson
                </button>
              )
            ))}
        </span>
      </div>
      {t.mark === 'avoidable' && !t.lessonId && writing && (
        <div className="st-lesson">
          <LessonBox value={text} onChange={setText} />
          {lesson.isError && (
            <span className="st-error" role="alert">
              {extractError(lesson.error)}
            </span>
          )}
          <span style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              disabled={busy || !text.trim()}
              data-testid="lesson-propose"
              onClick={() =>
                send((done) =>
                  lesson.mutate({ key: t.id, text: text.trim() }, { onSuccess: () => close('made'), onSettled: done }),
                )
              }
            >
              Propose to Memory
            </button>
            <button type="button" className="st-btn st-btn-sm" onClick={() => close('link')}>
              Cancel
            </button>
          </span>
        </div>
      )}
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
  // A failed fetch for a new range or filter keeps the last good numbers on screen, with the notice above them
  const last = useRef<SteppedIn>();
  if (q.data) last.current = q.data;
  const d: SteppedIn | undefined = q.data ?? last.current;
  if (!d) {
    return q.isError ? (
      <div className="st-err">
        <LoadError what="the touches" error={q.error} onRetry={() => void q.refetch()} />
      </div>
    ) : (
      <div className="st-center">
        <span className="ai-spin" />
      </div>
    );
  }
  const t = d.totals;
  const stale = q.isError ? (
    <div className="st-err">
      <LoadError what="the touches" error={q.error} onRetry={() => void q.refetch()} />
    </div>
  ) : null;
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
      {label} {count != null && <b style={{ color: '#1E2A22' }}>{count}</b>}
    </button>
  );
  return (
    <div
      className="st-root"
      style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 24 }}
      data-testid="at-stepped"
    >
      {stale}
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
          <div className="at-hint-sm">mark them: the marks feed What to fix and Memory</div>
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
              className={`at-barrow st-kindrow${filters.kind === k.key ? ' on' : ''}`}
              style={{ gridTemplateColumns: '262px 1fr 26px' }}
              onClick={() => setFilters({ ...filters, kind: filters.kind === k.key ? undefined : k.key })}
              aria-pressed={filters.kind === k.key}
            >
              <span style={{ fontWeight: filters.kind === k.key ? 700 : 400 }}>{k.label}</span>
              <div className="at-bar" style={{ height: 10, borderRadius: 5 }}>
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
              <div className="at-bar" style={{ height: 8, borderRadius: 4 }}>
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
          variant="button"
          label="Team"
          icon={FUNNEL}
          style={FILTER_MENU}
          prefix="Team:"
          testId="stepped-team-filter"
          value={filters.teamId ?? ''}
          options={[{ value: '', label: 'all' }, ...d.teams.map((r) => ({ value: r.id, label: r.name }))]}
          onChange={(v) => setFilters({ ...filters, teamId: v || undefined })}
        />
        <MenuSelect<string>
          variant="button"
          label="Kind"
          icon={FUNNEL}
          style={FILTER_MENU}
          menuWidth={280}
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
          style={FILTER_MENU}
          testId="stepped-range"
          value={range}
          options={RANGES}
          onChange={onRange}
        />
        <button
          type="button"
          className="st-btn st-btn-sm"
          disabled={!d.items.length}
          onClick={() => download(d.items, range)}
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
            {t.touches === 0 ? `Nobody had to step in during the ${rangeLabel}.` : 'No touch matches these filters.'}
            {t.touches === 0 && range !== '90d' && (
              <>
                {' '}
                <button
                  type="button"
                  className="st-open"
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
          <div className="at-hint-sm" style={{ padding: '8px 16px', borderTop: '1px solid #EEF3EF' }}>
            Showing the newest 500.
          </div>
        )}
      </div>
    </div>
  );
}
