import { useState } from 'react';
import { useAiTeams, useProjectRuns } from '../../api/ai';
import { LoadError, RunStateChip, fmtElapsed, money } from '../ai/aiUi';
import { firstLine, whenAgo } from './teamFormat';
import { RunDetail } from './RunDetail';
import { TicketChip } from './teamUi';

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'finished', label: 'Finished' },
  { id: 'failed,timed_out', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'needs_input', label: 'Waiting for you' },
] as const;

/** AI Team › Run history: the project's runs, newest first; a click opens one. */
export function HistoryTab({
  projectId,
  runId,
  onRunChange,
  onOpenTicket,
}: {
  projectId: string;
  runId: string | null;
  onRunChange: (id: string | null) => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const [filter, setFilter] = useState<string>('');
  const q = useProjectRuns(projectId, { state: filter, limit: 60 });
  const teams = useAiTeams(projectId);
  if (runId) return <RunDetail runId={runId} onBack={() => onRunChange(null)} onOpenTicket={onOpenTicket} />;
  const names = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 24 }} data-testid="at-history">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="Show runs">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={filter === f.id}
            className={`tw-chipbtn ${filter === f.id ? 'tw-chipbtn-on' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {q.isError ? (
        <LoadError what="the run history" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <span className="ai-spin" />
      ) : (q.data ?? []).length === 0 ? (
        <div className="at-hint" data-testid="history-empty">
          No runs yet.
        </div>
      ) : (
        <div className="ai-card" data-testid="history-list">
          {(q.data ?? []).map((r) => {
            const secs =
              r.startedAt && r.endedAt ? Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000) : null;
            return (
              <div
                key={r.id}
                className="at-row"
                style={{ cursor: 'pointer' }}
                onClick={() => onRunChange(r.id)}
                data-testid="history-row"
              >
                {r.ticketId && (
                  <span onClick={(e) => e.stopPropagation()}>
                    <TicketChip id={r.ticketId} onOpen={onOpenTicket} />
                  </span>
                )}
                <button type="button" className="at-runlink" onClick={() => onRunChange(r.id)} title="Open this run">
                  {names.get(r.memberId) ?? 'Team'}
                </button>
                <span className="at-sub">#{r.number}</span>
                <RunStateChip state={r.state} />
                <span className="at-line at-sub" title={r.report?.summary || r.summary || r.instruction}>
                  {firstLine(r.report?.summary || r.summary || r.instruction)}
                </span>
                <span className="at-sub">{r.stepsCount} steps</span>
                {secs != null && <span className="at-mono">{fmtElapsed(secs)}</span>}
                {r.costUsd > 0 && <span className="at-mono">{money(r.costUsd)}</span>}
                <span className="at-sub">{whenAgo(r.queuedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
