import { useAiTeams } from '../../../api/ai';
import type { Plugin } from '../../../types/aiPlugins';
import { Toggle } from '../aiUi';
import { roleName } from './pluginLogic';

/** What one team gets from one plugin, and why: its own switch, the project default, or a role it has. */
export function teamGets(p: Pick<Plugin, 'members' | 'defaultOn' | 'roles'>, teamId: string, teamRoles: string[]) {
  const own = p.members.find((m) => m.memberId === teamId)?.on;
  if (own !== undefined) return { on: own, why: own ? 'Switched on for this team' : 'Switched off for this team' };
  if (p.defaultOn) return { on: true, why: 'On by default: every team' };
  const hit = p.roles.filter((r) => teamRoles.includes(r));
  if (hit.length) return { on: true, why: `Suggested for ${hit.map(roleName).join(', ')}` };
  return {
    on: false,
    why: p.roles.length ? `Suggested for ${p.roles.map(roleName).join(', ')}: none here` : 'On by default: nobody',
  };
}

/** By team (design/screens/ai-project-settings.md, B7): what each team gets from its roles. Read only. */
export function ByTeamTab({ projectId, plugins }: { projectId: string; plugins: Plugin[] }) {
  const teams = useAiTeams(projectId);
  if (teams.isLoading) return <div className="ai-skel" style={{ height: 80 }} aria-busy="true" aria-label="Loading" />;
  if (!teams.data?.length)
    return (
      <div className="ai-hint" data-testid="by-team-empty">
        No team yet. A team gets the plugins of its roles.
      </div>
    );
  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="by-team">
      <div className="ai-hint">
        What a team gets follows its roles: a plugin suggested for a role goes to every team with that role.
      </div>
      {teams.data.map((t) => {
        const roles = t.roles.map((r) => r.key);
        return (
          <div
            key={t.id}
            className="ai-card"
            style={{ padding: 12, display: 'grid', gap: 8 }}
            data-testid={`team-${t.id}`}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13.5 }}>{t.name}</b>
              {t.roles.map((r) => (
                <span key={r.key} className="ai-chip">
                  {roleName(r.key)}
                </span>
              ))}
            </div>
            {plugins.length === 0 ? (
              <div className="ai-hint">
                Nothing installed yet. Pick one from the suggestions, or add one from a source.
              </div>
            ) : (
              plugins.map((p) => {
                const g = teamGets(p, t.id, roles);
                return (
                  <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', opacity: g.on ? 1 : 0.6 }}>
                    <Toggle label={`${p.name} for ${t.name}`} on={g.on} disabled onChange={() => undefined} />
                    <b style={{ fontSize: 13 }}>{p.name}</b>
                    <span className="ai-chip">Plugin</span>
                    <span className="ai-hint" style={{ flex: 1, textAlign: 'right' }}>
                      {g.why}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}
