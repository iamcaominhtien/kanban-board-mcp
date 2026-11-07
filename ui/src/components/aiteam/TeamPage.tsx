import { aiApi, useAiMutation, useAiTeams, useTeamActivity } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiTeam, AiTeamRole, RoleActivity } from '../../types/ai';
import { AiAvatar, LoadError, StatusLabel, useNow } from '../ai/aiUi';
import { useToast } from '../Toast';
import { RecentList } from './RecentSpend';
import { LeadCard, RoleCard } from './RoleCard';
import { fmtTokens, fmtUsd } from './teamFormat';

const NO_ACTIVITY: RoleActivity = { working: null, lastWorked: null, stepsToday: 0, runsToday: 0 };

/** "2 of 3", or just "2" when there is no cap. */
const against = (n: number, cap: number | null | undefined) => (cap != null ? `${n} of ${cap}` : String(n));

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="at-label">{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{children}</div>
    </div>
  );
}

function Header({ team, onOpenMember }: { team: AiTeam; onOpenMember: (id: string) => void }) {
  const toast = useToast();
  const toggle = useAiMutation(() => (team.paused ? aiApi.resumeTeam(team.id) : aiApi.pauseTeam(team.id)));
  const lead = [team.model, team.effort].filter(Boolean).join(' · ') || 'Default';
  const account = team.accountRef;
  return (
    <div
      className="ai-card"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
      data-testid="team-header"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <AiAvatar color={team.color} size={44} dim={team.paused} />
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{team.name}</div>
          <div className="ai-muted">{team.packName ?? team.packKey}</div>
        </div>
        <StatusLabel status={team.status} sub={null} />
        <button
          type="button"
          className="st-btn st-btn-sm"
          disabled={toggle.isPending}
          data-testid="team-pause"
          onClick={() =>
            toggle.mutate(undefined, {
              onError: (err) => toast.error(team.paused ? 'Could not resume' : 'Could not pause', extractError(err)),
            })
          }
        >
          {team.paused ? 'Resume the team' : 'Pause the team'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
        <Fact label="Account">
          {account ? (
            <>
              {account.name}
              {account.status !== 'signed_in' ? (
                <span className="ai-muted"> · {account.status.replace(/_/g, ' ')}</span>
              ) : null}
            </>
          ) : (
            'Board default'
          )}
        </Fact>
        <Fact label="Lead model">{lead}</Fact>
        <Fact label="Slots">
          {team.slotsInUse} of {team.maxParallel} running
          {team.queued > 0 ? <span className="ai-muted"> · {team.queued} queued</span> : null}
        </Fact>
        <Fact label="Runs today">{against(team.usage.runsToday, team.maxRunsPerDay)}</Fact>
        <Fact label="Spend today">
          {team.usage.costToday > 0 || team.usage.tokensToday === 0
            ? fmtUsd(team.usage.costToday)
            : `${fmtTokens(team.usage.tokensToday)} tokens`}
          {team.dailyBudget != null ? <span className="ai-muted"> of {fmtUsd(team.dailyBudget)}</span> : null}
        </Fact>
      </div>
      <div>
        <button type="button" className="ai-link" onClick={() => onOpenMember(team.id)} data-testid="team-configure">
          Roles, limits and account: open on the Members page →
        </button>
      </div>
    </div>
  );
}

/** AI Team › Now › a team: its header, a card per role (and the lead), and the team's recent runs. */
export function TeamPage({
  projectId,
  teamId,
  onBack,
  onOpenTicket,
  onOpenMember,
}: {
  projectId: string;
  teamId: string;
  onBack: () => void;
  onOpenTicket: (id: string) => void;
  onOpenMember: (id: string) => void;
}) {
  const teamsQ = useAiTeams(projectId);
  const activityQ = useTeamActivity(teamId);
  const team = teamsQ.data?.find((t) => t.id === teamId);
  const act = activityQ.data;
  useNow(1000, !!act?.lead.working || !!act?.roles.some((r) => r.working));
  if (teamsQ.isError) return <LoadError what="the team" error={teamsQ.error} onRetry={() => void teamsQ.refetch()} />;
  if (!team) return <div className="at-hint">{teamsQ.isLoading ? 'Loading the team…' : 'This team is gone.'}</div>;
  const roles: AiTeamRole[] = [...team.roles];
  for (const r of act?.roles ?? [])
    if (!roles.some((x) => x.key === r.key))
      roles.push({
        key: r.key,
        name: r.key,
        description: null,
        prompt: null,
        model: null,
        effort: null,
        tools: null,
        writes: null,
      });
  const byKey = new Map((act?.roles ?? []).map((r) => [r.key, r]));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 24 }} data-testid="team-page">
      <div>
        <button type="button" className="ai-link" onClick={onBack} data-testid="team-back">
          ← All teams
        </button>
      </div>
      <Header team={team} onOpenMember={onOpenMember} />
      <section>
        <h2 className="ai-label ai-label-dark" style={{ marginBottom: 8 }}>
          Roles
        </h2>
        {activityQ.isError ? (
          <LoadError what="what the roles do" error={activityQ.error} onRetry={() => void activityQ.refetch()} />
        ) : (
          <div className="at-cards" data-testid="role-cards">
            <LeadCard team={team} activity={act?.lead ?? NO_ACTIVITY} onOpenTicket={onOpenTicket} />
            {roles.map((r) => (
              <RoleCard
                key={r.key}
                role={r}
                team={team}
                activity={byKey.get(r.key) ?? NO_ACTIVITY}
                onOpenTicket={onOpenTicket}
              />
            ))}
          </div>
        )}
        {roles.length === 0 && <div className="ai-muted">This team has no roles: its lead works alone.</div>}
      </section>
      <RecentList projectId={projectId} teamId={teamId} teams={[team]} onOpenTicket={onOpenTicket} />
    </div>
  );
}
