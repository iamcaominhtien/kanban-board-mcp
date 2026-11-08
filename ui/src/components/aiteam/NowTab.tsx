import { useAiLive, useAiOverview, useAiSettings, useAiTeams, useProjectRuns, useTeamsActivity } from '../../api/ai';
import type { AiLive, AiRun, AiTeam, TeamActivity } from '../../types/ai';
import { AiAvatar, LoadError, RunStateChip, StatusLabel, fmtElapsed, hhmm, secondsSince, useNow } from '../ai/aiUi';
import { StepIcon } from '../ai/run/StepIcon';
import { useResourcesStream } from '../../api/aiResources';
import type { ResourceSnapshot } from '../../types/aiResources';
import { NeedsYou } from './NeedsYou';
import { RamChip, rowsByRun } from './RamChip';
import { RecentList, SpendToday } from './RecentSpend';
import { openRun } from './runLink';
import { ContextBar, RoleTags, StepText, TicketChip, chipLook } from './teamUi';

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
    <div className="at-working" data-testid="working-now">
      <div className="at-working-head">
        <span className="at-label">{waiting ? 'Waiting for your answer' : 'Working'}</span>
        {workers.length === 0 && !waiting && (
          <span className="at-chip" style={{ background: '#1E2A22', color: '#fff' }}>
            Lead
          </span>
        )}
        {(waiting ? [] : workers).map((r) => {
          const look = chipLook(r.key);
          return (
            <span
              key={r.key}
              className="at-chip"
              style={{ background: look.bg, color: look.fg, border: `1px solid ${look.fg}55` }}
            >
              <span className="at-dot" style={{ background: look.fg, boxShadow: `0 0 0 3px ${look.fg}33` }} />
              {roleName(r.key)}
            </span>
          );
        })}
      </div>
      <div className="at-step" title={step?.title} data-testid="working-step">
        {step ? <StepText text={step.title} /> : 'Starting…'}
      </div>
      {!waiting && lead.contextUsed != null && lead.contextWindow ? (
        <div>
          <ContextBar used={lead.contextUsed} size={lead.contextWindow} />
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
          <button type="button" className="at-teamname" onClick={() => actions.onOpenTeam(team.id)}>
            {team.name}
          </button>
          <div className="at-hint-sm" style={{ fontSize: 12 }}>
            {team.packName ?? team.packKey}
          </div>
        </div>
        <StatusLabel status={team.status} sub={null} />
      </div>
      <RoleTags roles={team.roles} />
      <WorkingNow team={team} activity={activity} />
      <div className="at-hint-sm" style={{ fontSize: 12 }}>
        {team.slotsInUse} of {team.maxParallel} running · {team.queued} queued · {team.usage.runsToday} run
        {team.usage.runsToday === 1 ? '' : 's'} today
      </div>
      {team.running.map((r) => {
        const ram = rows.get(r.runId);
        return (
          <div key={r.runId} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, minWidth: 0 }}>
              <TicketChip id={r.ticketId} onOpen={actions.onOpenTicket} />
              <span className="at-line">{r.ticketTitle}</span>
              <RunStateChip state={r.state} />
            </div>
            {ram && ram.readable && ram.cliRssMb != null && (
              <div>
                <RamChip run={ram} limitMb={limitMb} onOpen={actions.onOpenResources} />
              </div>
            )}
          </div>
        );
      })}
      <div>
        <button type="button" className="at-open" onClick={() => actions.onOpenTeam(team.id)}>
          See the roles →
        </button>
      </div>
    </div>
  );
}

/** A row of an active run: ticket, team, state, how far. */
function ActiveRow({ run, team, actions }: { run: AiRun; team?: AiTeam; actions: NowActions }) {
  return (
    <div className="at-row" data-testid="active-run">
      {run.ticketId && <TicketChip id={run.ticketId} onOpen={actions.onOpenTicket} />}
      <b>{team?.name ?? 'Team'}</b>
      <span className="at-sub">run #{run.number}</span>
      <RunStateChip state={run.state} />
      <span className="at-sub">{run.stepsCount} steps</span>
      {run.state === 'running' && <span className="at-mono">{fmtElapsed(secondsSince(run.startedAt))}</span>}
      <span style={{ flex: 1 }} />
      <button type="button" className="at-open" onClick={() => openRun(run.id)}>
        Open run
      </button>
    </div>
  );
}

/** The newest steps of every active run, from the live endpoint and the typed events that patch it. */
function LivePanel({ live, teams }: { live: AiLive; teams: Map<string, AiTeam> }) {
  const steps = live.steps.slice(-30).reverse();
  if (!steps.length) return <div className="at-plain">Nothing is running.</div>;
  return (
    <div className="ai-card" data-testid="live-steps">
      {steps.map((s) => (
        <div key={`${s.runId}-${s.seq}`} className="at-row">
          <span className="at-stepico">
            <StepIcon step={s} />
          </span>
          <span className="at-mono" style={{ fontSize: 11.5 }}>
            {s.ticketId ?? ''} · {teams.get(s.memberId)?.name ?? ''}
          </span>
          <span className="at-line">{s.title}</span>
          <span className="at-mono" style={{ fontSize: 11.5, color: '#9aa8a0' }}>
            {hhmm(s.at)}
          </span>
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
  // a project with no team shows only what has nothing to count: no counts, no Recent, no Spend today
  const hasTeams = teams.length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 24 }} data-testid="at-now">
      {hasTeams && (
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
      )}
      <NeedsYou
        projectId={projectId}
        teams={teams}
        active={active}
        asking={asking}
        onOpenTicket={actions.onOpenTicket}
        onOpenMember={actions.onOpenMember}
      />
      <section className="at-sec">
        <h2 className="at-h">Teams</h2>
        {teams.length === 0 ? (
          <div className="at-plain">No AI team yet. Add one from the Members page.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {teams.map((t) => (
              <TeamCard key={t.id} team={t} activity={activityQ.data?.[t.id]} actions={actions} resources={resources} />
            ))}
          </div>
        )}
      </section>
      <section className="at-sec">
        <h2 className="at-h">Active runs</h2>
        {active.length === 0 ? (
          <div className="at-plain">No run is active.</div>
        ) : (
          <div className="ai-card">
            {active.map((r) => (
              <ActiveRow key={r.id} run={r} team={byId.get(r.memberId)} actions={actions} />
            ))}
          </div>
        )}
      </section>
      {hasTeams && <RecentList projectId={projectId} teams={teams} onOpenTicket={actions.onOpenTicket} />}
      {hasTeams && <SpendToday teams={teams} settings={settingsQ.data} />}
      <section className="at-sec">
        <h2 className="at-h">Live</h2>
        {liveQ.data ? <LivePanel live={liveQ.data} teams={byId} /> : <div className="at-plain">Loading…</div>}
      </section>
    </div>
  );
}
