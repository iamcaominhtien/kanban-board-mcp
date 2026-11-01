import { Fragment, useEffect, useState } from 'react';
import {
  PAGE_SIZE,
  DEFAULT_FILTERS,
  useHistory,
  useHistoryCounts,
  useSkillUsage,
  useTranscriptUsage,
} from '../../api/aiHistory';
import { useNotificationSettings } from '../../api/notificationSettings';
import type { TeamCard } from '../../types/aiTeam';
import type { HistoryFilters, HistoryRow } from '../../types/aiHistory';
import { END_LOOK, endWords, fmtBytes, fmtTook, fmtWhen, whoOf } from './historyFormat';
import { RunDetail } from './RunDetail';
import { Badge } from './teamUi';
import './history.css';

interface Props {
  projectId: string;
  members: TeamCard[];
  /** The run whose detail is open (null: the list). */
  runId: string | null;
  onRunChange: (runId: string | null) => void;
  onOpenTicket: (ticketId: string) => void;
}

const VIEWS: { id: HistoryFilters['view']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'failed', label: 'Failed' },
  { id: 'needs', label: 'Needed you' },
  { id: 'pinned', label: 'Pinned' },
];

const DAYS: { days: number; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 0, label: 'All time' },
];

/** The part of a search snippet that matched, shown marked. The server may wrap matches in <mark>; nothing else is trusted as markup. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<mark>|<\/mark>)/);
  let on = false;
  return (
    <div className="hs-snippet" data-testid="hs-snippet">
      {parts.map((p, i) => {
        if (p === '<mark>') {
          on = true;
          return null;
        }
        if (p === '</mark>') {
          on = false;
          return null;
        }
        return on ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>;
      })}
    </div>
  );
}

function Row({ r, onOpen }: { r: HistoryRow; onOpen: () => void }) {
  const end = endWords(r);
  const look = END_LOOK[r.state];
  return (
    <button type="button" className="hs-row" onClick={onOpen} data-testid="hs-row">
      <span title={r.startedAt ?? r.queuedAt ?? ''}>{fmtWhen(r.startedAt ?? r.queuedAt)}</span>
      <span className="hs-who">
        <Badge name={whoOf(r)} size={22} />
        <span className="hs-trunc">{whoOf(r)}</span>
      </span>
      <span className="hs-ticket">
        <b>{r.ticketId}</b>
        <span>{r.ticketTitle}</span>
      </span>
      <span>
        <span className="at-chip" style={{ background: look.bg, color: look.fg }}>
          {end.label}
        </span>
        {end.why ? <span className="hs-note"> {end.why}</span> : null}
      </span>
      <span>{r.transcript ? `${r.transcript.events} steps` : '—'}</span>
      <span>{fmtTook(r.durationS)}</span>
      <span className="hs-trunc">
        {r.skills.map((s) => (
          <span key={s} className="hs-skill">
            {s}
          </span>
        ))}
        {r.transcript?.pinned ? (
          <span className="hs-pin" title="Pinned: never deleted">
            ●
          </span>
        ) : null}
      </span>
      {r.snippet ? <Snippet text={r.snippet} /> : null}
    </button>
  );
}

/** AI Team › Run history: finding the run you mean, then opening it (design/screens/ai-operations.md, F and G). */
export function HistoryTab({ projectId, members, runId, onRunChange, onOpenTicket }: Props) {
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [typed, setTyped] = useState('');
  const [page, setPage] = useState(0);
  const [showRetention, setShowRetention] = useState(false);

  // The search waits for a pause in typing, then starts again from the first page
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === typed ? f : { ...f, q: typed }));
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const change = (patch: Partial<HistoryFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  const list = useHistory(projectId, filters, page);
  const counts = useHistoryCounts(projectId, filters);
  const skills = useSkillUsage(projectId);
  const usage = useTranscriptUsage();
  const settings = useNotificationSettings();
  const retention = settings.data?.retentionDays ?? 90;

  if (runId) return <RunDetail runId={runId} onBack={() => onRunChange(null)} onOpenTicket={onOpenTicket} />;

  const total = list.data?.total ?? 0;
  const runs = list.data?.runs ?? [];
  const searching = filters.q.trim() !== '';
  const filtered =
    searching ||
    filters.memberId ||
    filters.ticketId.trim() ||
    filters.skill ||
    filters.view !== 'all' ||
    filters.days !== DEFAULT_FILTERS.days;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="history-tab">
      <div className="hs-head">
        <h2>Run history</h2>
        <span className="hs-count" data-testid="hs-count">
          {list.data ? (searching ? `${total} match` : `${total.toLocaleString()} run${total === 1 ? '' : 's'}`) : ''}
        </span>
        <span style={{ flex: 1 }} />
        <label className="hs-search">
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search what the AIs said and did, e.g. npm test 2 failed"
            aria-label="Search runs"
          />
        </label>
        <button
          type="button"
          className={`tl-btn${showRetention ? ' on' : ''}`}
          onClick={() => setShowRetention(!showRetention)}
        >
          Retention
        </button>
      </div>

      {showRetention ? (
        <div className="hs-panel" data-testid="hs-retention">
          <div className="hs-ret">
            <span className="h">WHAT</span>
            <span className="h">KEPT FOR</span>
            <span className="h">WHY</span>
            <b>The summary of a run</b>
            <span>Forever</span>
            <span>
              Who, which ticket, how it ended, how long, how many steps, which files, what it reported. Small, and it is
              what the board&apos;s own screens read.
            </span>
            <b>The full transcript</b>
            <span>{retention} days</span>
            <span>
              The prompt that was sent, every tool call with its arguments and result, everything the AI said. The same{' '}
              {retention} days as the notification log, set in Settings › Notifications.
            </span>
            <b>A pinned run</b>
            <span>Forever</span>
            <span>
              You pin it, or the board pins it: the run behind a reverted change, the run that produced a lesson, the
              run attached to an arbitration.
            </span>
            <b>Anything that looks like a secret</b>
            <span>Never stored</span>
            <span>Masked before writing.</span>
          </div>
        </div>
      ) : null}

      <div className="hs-filters">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`hs-chip${filters.view === v.id ? ' on' : ''}`}
            aria-pressed={filters.view === v.id}
            onClick={() => change({ view: v.id })}
          >
            {v.label}
            {counts[v.id] != null ? <b>{counts[v.id]}</b> : null}
          </button>
        ))}
        <select
          className="at-select"
          value={filters.memberId}
          onChange={(e) => change({ memberId: e.target.value })}
          aria-label="Member"
        >
          <option value="">Any member</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input
          className="hs-text"
          placeholder="Any ticket"
          aria-label="Ticket"
          value={filters.ticketId}
          onChange={(e) => change({ ticketId: e.target.value })}
        />
        <select
          className="at-select"
          value={filters.skill}
          onChange={(e) => change({ skill: e.target.value })}
          aria-label="Skill"
        >
          <option value="">Any skill</option>
          {(skills.data ?? []).map((s) => (
            <option key={`${s.kind}:${s.name}`} value={s.name}>
              {s.name}
              {s.kind === 'subagent' ? ' (subagent)' : ''} · {s.uses}
            </option>
          ))}
        </select>
        <select
          className="at-select"
          value={filters.days}
          onChange={(e) => change({ days: Number(e.target.value) })}
          aria-label="Time"
        >
          {DAYS.map((d) => (
            <option key={d.days} value={d.days}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {list.isError ? (
        <div className="hs-empty" role="alert">
          Couldn&apos;t load the run history.
        </div>
      ) : !list.data ? (
        <div className="hs-empty">Loading the run history…</div>
      ) : runs.length === 0 ? (
        <div className="hs-empty" data-testid="hs-empty">
          {filtered
            ? searching
              ? `No run matches “${filters.q.trim()}”.`
              : 'No run matches these filters.'
            : 'Nothing has run yet. Runs are kept from the moment the first one ends.'}
        </div>
      ) : (
        <div className="hs-table" role="table">
          <div className="hs-row head" role="row">
            <span>When</span>
            <span>Who</span>
            <span>Ticket</span>
            <span>How it ended</span>
            <span>Steps</span>
            <span>Took</span>
            <span>Skills used</span>
          </div>
          {runs.map((r) => (
            <Row key={r.id} r={r} onOpen={() => onRunChange(r.id)} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="hs-pager">
          <button type="button" className="tl-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Newer
          </button>
          <span>
            Page {page + 1} of {pages}
          </span>
          <button type="button" className="tl-btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Older
          </button>
        </div>
      ) : null}

      <div className="hs-note">
        What the search reads: the summary and report, what the AI said, the name and arguments of every tool call, file
        paths, error text, and the question it asked you.
      </div>
      <div className="hs-note" data-testid="hs-usage">
        {usage.data
          ? `Transcripts: ${fmtBytes(usage.data.bytes)} of ${retention} days across ${usage.data.runs} run${usage.data.runs === 1 ? '' : 's'}. Summaries are kept forever and are small. ${usage.data.pinned} pinned run${usage.data.pinned === 1 ? ' is' : 's are'} never deleted.`
          : `Transcripts are kept for ${retention} days. Summaries are kept forever.`}
      </div>
    </div>
  );
}
