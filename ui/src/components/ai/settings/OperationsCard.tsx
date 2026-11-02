import { useState } from 'react';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { LoadError, Toggle } from '../aiUi';
import { GroupHead, NumberSetting, TeamRow } from './settingsUi';
import { TeamOnItsOwn } from './TeamOnItsOwn';
import './teamOwn.css';

/**
 * Project settings for the AI team › Operations (design/screens/ai-operations.md, K): when the board looks at a
 * silent run, whether a light model may read its last steps, how messages and GitHub reach the team, and how far the
 * team goes on its own (Team on its own, design/screens/ai-story-flow.md, L). Changes take effect on the next run.
 */
export function OperationsCard({ projectId }: { projectId: string }) {
  const ops = useProjectOps(projectId);
  const patch = usePatchProjectOps(projectId);
  const [error, setError] = useState<string | null>(null);

  if (ops.isLoading) return <div className="ai-skel" style={{ height: 96 }} aria-busy="true" aria-label="Loading" />;
  if (ops.error || !ops.data)
    return <LoadError what="the operations settings" error={ops.error} onRetry={() => void ops.refetch()} />;

  const save = async (body: Parameters<typeof patch.mutateAsync>[0]) => {
    setError(null);
    try {
      await patch.mutateAsync(body);
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className="to-sec" data-testid="ops-card">
        <div className="ai-hint">Changes take effect on the next run.</div>
        <div className="to-group">
          <GroupHead
            title="When a run goes quiet"
            hint="How the board looks at a run that has stopped producing output."
          />
          <TeamRow
            title="Say nothing is moving after"
            hint="How long with no new output before the board diagnoses the run. A build that is still printing never trips it."
          >
            <NumberSetting
              value={ops.data.hangAfterMin}
              min={1}
              label="Minutes without output before the board looks at a run"
              testId="ops-hang-after"
              onSave={(n) => void save({ hangAfterMin: n })}
            />
            <span className="ai-hint">minutes</span>
          </TeamRow>
          <TeamRow
            title="When the board cannot tell why, let Haiku read the last steps"
            hint="Its reading is a proposal, never applied by itself."
          >
            <Toggle
              on={ops.data.diagnoseWithModel}
              label="Let Haiku read the last steps when the board cannot tell why"
              testId="ops-diagnose"
              disabled={patch.isPending}
              onChange={(v) => void save({ diagnoseWithModel: v })}
            />
          </TeamRow>
        </div>
        <div className="to-rule" />
        <div className="to-group">
          <GroupHead title="Messages and GitHub" hint="How a message and a pull request reach the team." />
          <TeamRow
            title="A message reaches a running AI at its next turn"
            hint="Off: it reaches the AI at its next call to the board."
          >
            <Toggle
              on={!!ops.data.liveMessages}
              label="A message reaches a running AI at its next turn"
              testId="ops-live-messages"
              disabled={patch.isPending}
              onChange={(v) => void save({ liveMessages: v })}
            />
          </TeamRow>
          <TeamRow
            title="Watch GitHub for the pull requests the board opened"
            hint="No webhook: the app asks gh every few minutes while a pull request is open."
          >
            <Toggle
              on={!!ops.data.github?.on}
              label="Watch GitHub for the pull requests the board opened"
              testId="ops-github-on"
              disabled={patch.isPending}
              onChange={(v) => void save({ github: { on: v } })}
            />
          </TeamRow>
          <TeamRow
            title="Red CI this change caused and review comments go to the Dev by themselves"
            hint="Only for pull requests the board opened."
          >
            <Toggle
              on={ops.data.github?.auto ?? true}
              label="Red CI this change caused and review comments go to the Dev by themselves"
              testId="ops-github-auto"
              disabled={patch.isPending}
              onChange={(v) => void save({ github: { auto: v } })}
            />
          </TeamRow>
        </div>
      </section>
      <TeamOnItsOwn ops={ops.data} busy={patch.isPending} projectId={projectId} save={(b) => void save(b)} />
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
