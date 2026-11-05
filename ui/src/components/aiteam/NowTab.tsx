import { useAiLive, useAiOverview, useAiTeams, useProjectRuns } from '../../api/ai';
import type { AiLive, AiRun, AiTeam } from '../../types/ai';
import { AiAvatar, LoadError, RunStateChip, StatusLabel, fmtElapsed, hhmm, secondsSince, useNow } from '../ai/aiUi';
import { QuestionCard } from '../ai/QuestionCard';
import { RoleChips } from '../ai/AiMembersPage';
import { StepIcon } from '../ai/run/StepIcon';
import { openRun } from './runLink';
import { TicketChip } from './teamUi';

export interface NowActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
}

const ACTIVE = 'queued,starting,running,needs_input';

/** One card per team: its status, its roles, what it is working on. */
function TeamCard({ team, actions }: { team: AiTeam; actions: NowActions }) {
  return (
    <div
      className="ai-card"
      style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid={`team-card-${team.name}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AiAvatar color={team.color} size={32} dim={team.paused} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button
            type="button"
            className="ai-link"
            style={{ fontWeight: 700, fontSize: 14 }}
            onClick={() => actions.onOpenMember(team.id)}
          >
            {team.name}
          </button>
          <div className="ai-muted">{team.packName ?? team.packKey}</div>
        </div>
        <StatusLabel status={team.status} sub={null} />
      </div>
      <RoleChips team={team} />
      <div className="ai-muted">
        {team.slotsInUse} of {team.maxParallel} running · {team.queued} queued · {team.usage.runsToday} run
        {team.usage.runsToday === 1 ? '' : 's'} today
      </div>
      {team.running.map((r) => (
        <div key={r.runId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
          <TicketChip id={r.ticketId} onOpen={actions.onOpenTicket} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.ticketTitle}
          </span>
          <RunStateChip state={r.state} />
        </div>
      ))}
    </div>
  );
}

/** A row of an active run: ticket, team, state, how far. */
function ActiveRow({ run, team, actions }: { run: AiRun; team?: AiTeam; actions: NowActions }) {
  return (
    <div
      className="ai-row"
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}
      data-testid="active-run"
    >
      {run.ticketId && <TicketChip id={run.ticketId} onOpen={actions.onOpenTicket} />}
      <span style={{ fontWeight: 600 }}>{team?.name ?? 'Team'}</span>
      <span className="ai-muted">run #{run.number}</span>
      <RunStateChip state={run.state} />
      <span className="ai-muted">{run.stepsCount} steps</span>
      {run.state === 'running' && <span className="ai-mono ai-muted">{fmtElapsed(secondsSince(run.startedAt))}</span>}
      <span style={{ flex: 1 }} />
      <button type="button" className="ai-link" onClick={() => openRun(run.id)}>
        Open run
      </button>
    </div>
  );
}

/** The newest steps of every active run, from the live endpoint and the typed events that patch it. */
function LivePanel({ live, teams }: { live: AiLive; teams: Map<string, AiTeam> }) {
  const steps = live.steps.slice(-30).reverse();
  if (!steps.length) return <div className="ai-muted">Nothing is running.</div>;
  return (
    <div className="ai-steps" data-testid="live-steps">
      {steps.map((s) => (
        <div key={`${s.runId}-${s.seq}`} className="ai-step-row">
          <StepIcon step={s} />
          <span className="ai-mono ai-muted" style={{ whiteSpace: 'nowrap' }}>
            {s.ticketId ?? ''} · {teams.get(s.memberId)?.name ?? ''}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.title}
          </span>
          <span className="ai-step-time">{hhmm(s.at)}</span>
        </div>
      ))}
    </div>
  );
}

/** AI Team › Now: the teams, what waits for a person, the active runs and what they do right now. */
export function NowTab({ projectId, actions }: { projectId: string; actions: NowActions }) {
  const teamsQ = useAiTeams(projectId);
  const overview = useAiOverview(projectId);
  const activeQ = useProjectRuns(projectId, { state: ACTIVE, limit: 40 });
  const liveQ = useAiLive(projectId);
  useNow(
    1000,
    (activeQ.data ?? []).some((r) => r.state === 'running'),
  );
  if (teamsQ.isError)
    return <LoadError what="the AI teams" error={teamsQ.error} onRetry={() => void teamsQ.refetch()} />;
  if (teamsQ.isLoading || !teamsQ.data) return <div className="at-hint">Loading the AI team…</div>;
  const teams = teamsQ.data;
  const byId = new Map(teams.map((t) => [t.id, t]));
  const active = activeQ.data ?? [];
  const asking = active.filter((r) => r.state === 'needs_input' && r.question && !r.answer);
  const counts = overview.data?.runs ?? {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 24 }} data-testid="at-now">
      <div style={{ display: 'flex', gap: 24, fontSize: 13 }} data-testid="at-counts">
        <span>
          <b>{(counts.running ?? 0) + (counts.starting ?? 0)}</b> running
        </span>
        <span>
          <b>{counts.queued ?? 0}</b> queued
        </span>
        <span>
          <b>{counts.needsInput ?? 0}</b> waiting for you
        </span>
        <span>
          <b>{counts.finished ?? 0}</b> finished
        </span>
        <span>
          <b>{counts.failed ?? 0}</b> failed
        </span>
      </div>
      {asking.length > 0 && (
        <section data-testid="at-needs-you" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 className="ai-label ai-label-dark">Needs you</h2>
          {asking.map((r) => (
            <QuestionCard key={r.id} run={r} />
          ))}
        </section>
      )}
      <section>
        <h2 className="ai-label ai-label-dark" style={{ marginBottom: 8 }}>
          Teams
        </h2>
        {teams.length === 0 ? (
          <div className="ai-muted">No AI team yet. Add one from the Members page.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {teams.map((t) => (
              <TeamCard key={t.id} team={t} actions={actions} />
            ))}
          </div>
        )}
      </section>
      <section>
        <h2 className="ai-label ai-label-dark" style={{ marginBottom: 8 }}>
          Active runs
        </h2>
        {active.length === 0 ? (
          <div className="ai-muted">No run is active.</div>
        ) : (
          <div className="ai-card">
            {active.map((r) => (
              <ActiveRow key={r.id} run={r} team={byId.get(r.memberId)} actions={actions} />
            ))}
          </div>
        )}
      </section>
      <section>
        <h2 className="ai-label ai-label-dark" style={{ marginBottom: 8 }}>
          Live
        </h2>
        {liveQ.data ? <LivePanel live={liveQ.data} teams={byId} /> : <div className="ai-muted">Loading…</div>}
      </section>
    </div>
  );
}
