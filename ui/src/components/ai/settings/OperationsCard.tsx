import { useState } from 'react';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { LoadError, Toggle } from '../aiUi';
import { NumberSetting, SettingRow } from './settingsUi';
import { TeamOnItsOwn } from './TeamOnItsOwn';

/**
 * Project settings for the AI team › Operations (design/screens/ai-operations.md, K): when the board looks at a
 * silent run, whether a light model may read its last steps, and how much the team does on its own. Changes take
 * effect on the next run.
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
    <div
      className="ai-card"
      data-testid="ops-card"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div className="ai-hint">Changes take effect on the next run.</div>
      <SettingRow
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
      </SettingRow>
      <div className="ai-divider" />
      <SettingRow
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
      </SettingRow>
      <div className="ai-divider" />
      <TeamOnItsOwn ops={ops.data} busy={patch.isPending} projectId={projectId} save={(b) => void save(b)} />
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
