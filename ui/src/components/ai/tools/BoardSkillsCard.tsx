import { useState } from 'react';
import { useBoardSkills } from '../../../api/aiPlugins';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { useAiTeams } from '../../../api/ai';
import { Toggle } from '../aiUi';
import { boardSkillOn, boardSkillOwn, withBoardSkill } from './boardSkillLogic';
import { roleName } from './pluginLogic';

/** The first sentence of a skill's description, for the one-line hint of its row. */
function gist(description: string): string {
  const first = description.split(/(?<=[.:])\s|\s-\s/)[0] ?? description;
  return first.replace(/[.:]$/, '');
}

/**
 * The board's own skills (the canvas design guide, permissions, the shared skills every role uses, one skill per role),
 * each with a switch: for the whole project, or, with `memberId`, for one member over the project's default (issues
 * #277, #273). With `memberId` only that team's own role skill is listed (`role`): the others never load for it.
 */
export function BoardSkillsRows({
  projectId,
  memberId,
  role,
}: {
  projectId: string;
  memberId?: string;
  role?: string | null;
}) {
  const skills = useBoardSkills();
  const teams = useAiTeams(projectId);
  const ops = useProjectOps(projectId);
  const patch = usePatchProjectOps(projectId);
  const [error, setError] = useState<string | null>(null);

  if (skills.isLoading || ops.isLoading)
    return <div className="ai-skel" style={{ height: 40 }} aria-busy="true" aria-label="Loading" />;
  if (skills.error || ops.error || !skills.data || !ops.data)
    return (
      <div className="ai-notice ai-notice-error" role="alert">
        Couldn't load the board's skills: {extractError(skills.error ?? ops.error)}.
      </div>
    );
  const list = ops.data.boardSkills;
  const every = Array.isArray(skills.data) ? skills.data : [];
  const all = memberId ? every.filter((s) => !s.role || s.role === role) : every;
  const set = async (skill: string, on: boolean | null) => {
    setError(null);
    try {
      await patch.mutateAsync({ boardSkills: withBoardSkill(list, skill, on, memberId) });
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <>
      {all.map((s) => {
        const on = boardSkillOn(list, s.name, memberId);
        const own = memberId ? boardSkillOwn(list, s.name, memberId) : false;
        // a craft skill reaches only the teams with a role that does that work
        const left = s.craftRoles
          ? (teams.data ?? []).filter((t) => !t.roles.some((r) => s.craftRoles?.includes(r.key)))
          : [];
        const nobody = on && left.length > 0 && left.length === (teams.data ?? []).length;
        const lockedOn = !!s.alwaysOn;
        const reach = s.role
          ? `every ${roleName(s.role)}`
          : left.length
            ? `every team except ${left.map((t) => t.name).join(', ')}`
            : 'every team';
        return (
          <div
            key={s.name}
            data-testid={`bs-${s.name}`}
            style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0, opacity: nobody ? 0.55 : 1 }}
          >
            <Toggle
              label={s.name}
              on={(on && !nobody) || lockedOn}
              disabled={patch.isPending || lockedOn || nobody}
              onChange={(v) => void set(s.name, v)}
            />
            <b style={{ fontSize: 13 }}>{s.name}</b>
            <span className="ai-chip">{s.role ? `${roleName(s.role)} skill` : 'Skill'}</span>
            {lockedOn && <span className="ai-chip">Always on</span>}
            <span
              className="ai-hint"
              style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={s.description}
            >
              {lockedOn
                ? 'How to work a ticket, prove it, ask and report'
                : memberId
                  ? `${boardSkillOn(list, s.name) ? 'On for every team' : 'Off for this project'}.${
                      own ? ` Switched ${on ? 'on' : 'off'} here.` : ''
                    }`
                  : nobody
                    ? `Not given to ${left.map((t) => t.name).join(', ')}: none of its roles draw`
                    : on
                      ? `On for ${reach} · ${gist(s.description)}`
                      : 'Off for this project'}
            </span>
            {own && (
              <button className="ai-link" onClick={() => void set(s.name, null)}>
                Follow the default
              </button>
            )}
          </div>
        );
      })}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/** The project's switches for the board's own skills, on the Installed tab. */
export function BoardSkillsCard({ projectId }: { projectId: string }) {
  return (
    <div
      className="ai-card"
      data-testid="board-skills"
      style={{ padding: 12, display: 'grid', gap: 8, minWidth: 0, overflow: 'hidden' }}
    >
      <b style={{ fontSize: 13.5 }}>The board’s own skills</b>
      <div className="ai-hint">
        Every team gets the shared ones; a role’s own skill goes only to teams with that role.
      </div>
      <BoardSkillsRows projectId={projectId} />
    </div>
  );
}
