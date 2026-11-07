import { useAiLive, useAiOverview, useAiSettings, useAiTeams, useProjectRuns, useTeamsActivity } from '../../api/ai';
import type { AiLive, AiRun, AiTeam, TeamActivity } from '../../types/ai';
import { AiAvatar, LoadError, RunStateChip, StatusLabel, fmtElapsed, hhmm, secondsSince, useNow } from '../ai/aiUi';
import { RoleChips } from '../ai/AiMembersPage';
import { roleLook } from '../ai/roleLook';
import { StepIcon } from '../ai/run/StepIcon';
import { ContextMeter } from '../assist/ContextMeter';
import { useResourcesStream } from '../../api/aiResources';
import type { ResourceSnapshot } from '../../types/aiResources';
import { NeedsYou } from './NeedsYou';
import { RamChip, rowsByRun } from './RamChip';
import { RecentList, SpendToday } from './RecentSpend';
import { openRun } from './runLink';
import { TicketChip } from './teamUi';

export interface NowActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
  /** Open the team's page: its roles, what each does, its recent runs. */
  onOpenTeam: (teamId: string) => void;
  /** Open the Resources tab (the RAM chip of a running team). */
  onOpenResources?: () => void;
}

const ACTIVE = 'queued,starting,running,needs_input';

/** What a team does right now: the roles working, the step they are on, how full the lead's conversation is. */
function WorkingNow({ team, activity }: { team: AiTeam; activity?: TeamActivity }) {
  const lead = activity?.lead.working;
  if (!lead) return null;
  const waiting = lead.state === 'needs_input';
  const workers = (activity?.roles ?? []).filter((r) => r.working);
  const roleName = (key: string) => team.roles.find((r) => r.key === key)?.name ?? key;
  // the most specific step: the role that works now, else the lead
  const step = workers.find((r) => r.working?.step)?.working?.step ?? lead.step;
  return (
    <div className="at-quote" style={{ background: '#F4F9F5', borderColor: '#D6E8DB' }} data-testid="working-now">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span className="at-label">{waiting ? 'Waiting for your answer' : 'Working'}</span>
        {workers.length === 0 && !waiting && <span className="at-chip">Lead</span>}
        {(waiting ? [] : workers).map((r) => {
          const look = roleLook(r.key);
          return (
            <span
              key={r.key}
              className="at-chip"
              style={{ background: look.bg, color: look.fg, border: `1px solid ${look.border}` }}
            >
              <span className="at-dot at-dot-live" style={{ background: look.border }} />
              {roleName(r.key)}
            </span>
          );
        })}
      </div>
      <div className="at-step" style={{ marginTop: 4 }} title={step?.title} data-testid="working-step">
        {step ? step.title : 'Starting…'}
      </div>
      {lead.contextUsed != null && lead.contextWindow ? (
        <div style={{ marginTop: 4 }}>
          <ContextMeter used={lead.contextUsed} size={lead.contextWindow} inline />
        </div>
      ) : null}
    </div>
  );
}

/** One card per team: its status, its roles, what it is working on. The name opens the team's page. */
function TeamCard({
  team,
  activity,
  actions,
  resources,
}: {
  team: AiTeam;
  activity?: TeamActivity;
  actions: NowActions;
  resources: ResourceSnapshot | null;
}) {
  const rows = rowsByRun(resources);
  const limitMb = resources?.limits.runMemoryLimitMb ?? 0;
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
            onClick={() => actions.onOpenTeam(team.id)}
          >
            {team.name}
          </button>
          <div className="ai-muted">{team.packName ?? team.packKey}</div>
        </div>
        <StatusLabel status={team.status} sub={null} />
      </div>
      <RoleChips team={team} />
      <WorkingNow team={team} activity={activity} />
      <div className="ai-muted">
        {team.slotsInUse} of {team.maxParallel} running · {team.queued} queued · {team.usage.runsToday} run
        {team.usage.runsToday === 1 ? '' : 's'} today
      </div>
      {team.running.map((r) => (
        <div key={r.runId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
          <TicketChip id={r.ticketId} onOpen={actions.onOpenTicket} />
          <span
            style={{
              flex: '1 1 90px',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {r.ticketTitle}
          </span>
          <RamChip run={rows.get(r.runId)} limitMb={limitMb} onOpen={actions.onOpenResources} />
          <RunStateChip state={r.state} />
        </div>
      ))}
      <div>
        <button type="button" className="ai-link" onClick={() => actions.onOpenTeam(team.id)}>
          See the roles →
        </button>
      </div>
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

/** AI Team › Now: what waits for a person, the teams and who works in them, the active runs, what ended, the spend. */
export function NowTab({ projectId, actions }: { projectId: string; actions: NowActions }) {
  const teamsQ = useAiTeams(projectId);
  const overview = useAiOverview(projectId);
  const activeQ = useProjectRuns(projectId, { state: ACTIVE, limit: 40 });
  const liveQ = useAiLive(projectId);
  const activityQ = useTeamsActivity(projectId);
  const settingsQ = useAiSettings(projectId);
  const { data: resources } = useResourcesStream(projectId);
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
      <div style={{ display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap' }} data-testid="at-counts">
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
      <NeedsYou
        projectId={projectId}
        teams={teams}
        active={active}
        asking={asking}
        onOpenTicket={actions.onOpenTicket}
        onOpenMember={actions.onOpenMember}
      />
      <section>
        <h2 className="ai-label ai-label-dark" style={{ marginBottom: 8 }}>
          Teams
        </h2>
        {teams.length === 0 ? (
          <div className="ai-muted">No AI team yet. Add one from the Members page.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {teams.map((t) => (
              <TeamCard key={t.id} team={t} activity={activityQ.data?.[t.id]} actions={actions} resources={resources} />
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
      <RecentList projectId={projectId} teams={teams} onOpenTicket={actions.onOpenTicket} />
      <SpendToday teams={teams} settings={settingsQ.data} />
      <section>
        <h2 className="ai-label ai-label-dark" style={{ marginBottom: 8 }}>
          Live
        </h2>
        {liveQ.data ? <LivePanel live={liveQ.data} teams={byId} /> : <div className="ai-muted">Loading…</div>}
      </section>
    </div>
  );
}
