import { useState } from 'react';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { LoadError, Toggle } from '../aiUi';

/**
 * Project settings for the AI team › Operations (design/screens/ai-operations.md, K): when the board looks at a
 * silent run, and whether a light model may read its last steps. Changes take effect on the next run.
 */
export function OperationsCard({ projectId }: { projectId: string }) {
  const ops = useProjectOps(projectId);
  const patch = usePatchProjectOps(projectId);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  if (ops.isLoading) return <div className="ai-skel" style={{ height: 96 }} aria-busy="true" aria-label="Loading" />;
  if (ops.error || !ops.data)
    return <LoadError what="the operations settings" error={ops.error} onRetry={() => void ops.refetch()} />;

  const save = async (body: Parameters<typeof patch.mutateAsync>[0]) => {
    setError(null);
    try {
      await patch.mutateAsync(body);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setDraft(null);
    }
  };
  const commit = () => {
    if (draft == null) return;
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 1 && n !== ops.data.hangAfterMin) void save({ hangAfterMin: n });
    else setDraft(null);
  };

  return (
    <div
      className="ai-card"
      data-testid="ops-card"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div className="ai-hint">Changes take effect on the next run.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Look at a run that printed nothing for</div>
          <div className="ai-hint">
            How long with no new output before the board diagnoses the run. A build that is still printing never trips
            it.
          </div>
        </div>
        <input
          className="ai-input"
          type="number"
          min={1}
          style={{ width: 64 }}
          aria-label="Minutes without output before the board looks at a run"
          data-testid="ops-hang-after"
          value={draft ?? String(ops.data.hangAfterMin)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="ai-hint">minutes</span>
      </div>
      <div className="ai-divider" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            When the board cannot tell why, let Haiku read the last steps
          </div>
          <div className="ai-hint">Its reading is a proposal, never applied by itself.</div>
        </div>
        <Toggle
          on={ops.data.diagnoseWithModel}
          label="Let Haiku read the last steps when the board cannot tell why"
          testId="ops-diagnose"
          disabled={patch.isPending}
          onChange={(v) => void save({ diagnoseWithModel: v })}
        />
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
