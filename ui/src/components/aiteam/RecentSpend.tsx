import { useAiRecent } from '../../api/ai';
import type { AiSettings, AiTeam, RunState } from '../../types/ai';
import { ago } from '../ai/aiUi';
import { fmtTokens, fmtUsd } from './teamFormat';
import { openRun } from './runLink';
import { TicketChip } from './teamUi';

const END_LOOK: Partial<Record<RunState, { dot: string; word: string }>> = {
  finished: { dot: '#2E6F40', word: 'finished' },
  failed: { dot: '#C4432A', word: 'failed' },
  timed_out: { dot: '#C4432A', word: 'timed out' },
  cancelled: { dot: '#9AA8A0', word: 'cancelled' },
};

/** Recent: runs that just ended with the first line of their report, then the latest notes into and out of runs. */
export function RecentList({
  projectId,
  teamId,
  teams,
  onOpenTicket,
}: {
  projectId: string;
  /** Only this team's runs (the team page); otherwise the whole project's. */
  teamId?: string;
  teams: AiTeam[];
  onOpenTicket: (id: string) => void;
}) {
  const q = useAiRecent(projectId, teamId);
  const names = new Map(teams.map((t) => [t.id, t.name]));
  const runs = q.data?.runs ?? [];
  const notes = q.data?.notes ?? [];
  return (
    <section data-testid="at-recent" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 className="ai-label ai-label-dark">Recent</h2>
      {q.isLoading ? (
        <div className="ai-muted">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="ai-muted">No run has ended yet.</div>
      ) : (
        <div className="ai-card">
          {runs.map((r) => {
            const look = END_LOOK[r.state] ?? END_LOOK.finished!;
            return (
              <div
                key={r.runId}
                className="ai-row"
                data-testid="recent-run"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}
              >
                <span
                  title={look.word}
                  style={{ width: 8, height: 8, borderRadius: '50%', background: look.dot, flexShrink: 0 }}
                />
                {r.ticketId && <TicketChip id={r.ticketId} onOpen={onOpenTicket} />}
                {!teamId && <span style={{ fontWeight: 600 }}>{names.get(r.memberId) ?? 'Team'}</span>}
                <span
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={r.line}
                >
                  {r.line || <span className="ai-muted">{look.word}, no report</span>}
                </span>
                <span className="ai-muted" style={{ whiteSpace: 'nowrap' }}>
                  {look.word} {ago(r.endedAt)}
                </span>
                <button type="button" className="ai-link" onClick={() => openRun(r.runId)}>
                  Open run
                </button>
              </div>
            );
          })}
        </div>
      )}
      {notes.length > 0 && (
        <>
          <h3 className="ai-label" style={{ marginTop: 6 }}>
            Notes
          </h3>
          <div className="ai-card" data-testid="recent-notes">
            {notes.map((n) => (
              <div
                key={n.id}
                className="ai-row"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}
              >
                <span className="ai-muted" style={{ whiteSpace: 'nowrap' }}>
                  {n.direction === 'in'
                    ? `${n.peer || 'Someone'} → ${names.get(n.memberId) ?? 'team'}`
                    : `${names.get(n.memberId) ?? 'team'} → ${n.peer || 'someone'}`}
                </span>
                {n.ticketId && <TicketChip id={n.ticketId} onOpen={onOpenTicket} />}
                <span
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={n.text}
                >
                  {n.text}
                </span>
                <span className="ai-muted" style={{ whiteSpace: 'nowrap' }}>
                  {ago(n.at)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** A bar of `used` against `cap`; amber from 80 %, red when the cap is reached. */
function CapBar({ used, cap, label }: { used: number; cap: number; label: string }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const color = pct >= 100 ? '#C4432A' : pct >= 80 ? '#B8860B' : '#2E6F40';
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      role="img"
      aria-label={`${label}: ${Math.round(pct)} % of the cap`}
    >
      <div className="at-bar">
        <i style={{ width: `${Math.max(pct, used > 0 ? 3 : 0)}%`, background: color }} />
      </div>
    </div>
  );
}

const spendText = (t: AiTeam) =>
  t.usage.costToday > 0 || t.usage.tokensToday === 0
    ? fmtUsd(t.usage.costToday)
    : `${fmtTokens(t.usage.tokensToday)} tokens`;

/** Spend today against the daily caps: the board's, and each team's own. Money is per team, never per role. */
export function SpendToday({ teams, settings }: { teams: AiTeam[]; settings?: AiSettings | null }) {
  const cost = teams.reduce((n, t) => n + t.usage.costToday, 0);
  const runs = teams.reduce((n, t) => n + t.usage.runsToday, 0);
  const cap = settings?.boardDailyCap ?? null;
  const runCap = settings?.boardRunsPerDay ?? null;
  return (
    <section data-testid="at-spend" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 className="ai-label ai-label-dark">Spend today</h2>
      <div className="ai-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <b style={{ fontSize: 20 }}>{fmtUsd(cost)}</b>
            <span className="ai-muted">
              {cap != null ? `of ${fmtUsd(cap)} a day for the board` : 'no daily cap on the board'}
            </span>
          </div>
          {cap != null && <CapBar used={cost} cap={cap} label="Board spend today" />}
          <div className="ai-muted" style={{ marginTop: 4 }}>
            {runs} run{runs === 1 ? '' : 's'} today{runCap != null ? ` of ${runCap}` : ''}
          </div>
        </div>
        {teams.map((t) => (
          <div key={t.id} data-testid={`spend-${t.name}`}>
            <div style={{ display: 'flex', gap: 8, fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, flex: 1 }}>{t.name}</span>
              <span>
                {spendText(t)}
                {t.dailyBudget != null ? ` of ${fmtUsd(t.dailyBudget)}` : ''}
              </span>
              <span className="ai-muted">
                · {t.usage.runsToday}
                {t.maxRunsPerDay != null ? ` of ${t.maxRunsPerDay}` : ''} run{t.usage.runsToday === 1 ? '' : 's'}
              </span>
            </div>
            {t.dailyBudget != null && <CapBar used={t.usage.costToday} cap={t.dailyBudget} label={`${t.name} spend`} />}
          </div>
        ))}
      </div>
    </section>
  );
}
