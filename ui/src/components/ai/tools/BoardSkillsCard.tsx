import { useState } from 'react';
import { useBoardSkills } from '../../../api/aiPlugins';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import { boardSkillOn, boardSkillOwn, withBoardSkill } from './boardSkillLogic';

/**
 * The board's own skills (the canvas design guide, permissions, the shared skills every role uses), each with a switch:
 * for the whole project, or, with `memberId`, for one member over the project's default (issue #277).
 */
export function BoardSkillsRows({ projectId, memberId }: { projectId: string; memberId?: string }) {
  const skills = useBoardSkills();
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
  const all = Array.isArray(skills.data) ? skills.data : [];
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
        return (
          <div key={s.name} data-testid={`bs-${s.name}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Toggle label={s.name} on={on} disabled={patch.isPending} onChange={(v) => void set(s.name, v)} />
            <b style={{ fontSize: 13 }}>{s.name}</b>
            <span className="ai-chip">Board</span>
            <span className="ai-hint" style={{ flex: 1 }} title={s.description}>
              {memberId
                ? `Project default is ${boardSkillOn(list, s.name) ? 'on' : 'off'}.${own ? ' Switched here.' : ''}`
                : s.description}
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
    <div className="ai-card" data-testid="board-skills" style={{ padding: 12, display: 'grid', gap: 8 }}>
      <b style={{ fontSize: 13.5 }}>The board's own skills</b>
      <div className="ai-hint">
        Every Claude Code member gets these, whatever its role. Switch one off for the project here, or for one member
        on its page.
      </div>
      <BoardSkillsRows projectId={projectId} />
    </div>
  );
}
