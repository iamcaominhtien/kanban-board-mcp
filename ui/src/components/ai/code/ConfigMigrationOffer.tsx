import { useState } from 'react';
import { codeApi, useCodeMutation, useConfigMigration } from '../../../api/aiCode';
import { extractError } from '../../../api/extractError';
import { useProjectOps } from '../../../api/aiProjectOps';

/**
 * Leaving the synced folder (design/screens/ai-team-process.md, B3): with per-run configuration on, offer once to
 * remove what the board wrote into the member's folder. Nothing is shown when there is nothing to remove.
 */
export function ConfigMigrationOffer({ memberId, projectId }: { memberId: string; projectId: string }) {
  const ops = useProjectOps(projectId);
  const on = !!ops.data?.perRunConfig;
  const q = useConfigMigration(memberId, on);
  const go = useCodeMutation(() => codeApi.migrate(memberId));
  const [done, setDone] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done)
    return (
      <div className="ai-notice ai-notice-info" data-testid="migration-done">
        Removed {done.length} file{done.length === 1 ? '' : 's'} from the folder. The next run starts a fresh
        conversation.
      </div>
    );
  if (!on || !q.data || q.data.files.length === 0) return null;
  const files = q.data.files;
  const kept = files.filter((f) => !f.unchanged && !f.blockOnly);
  return (
    <div className="ai-notice ai-notice-warn" style={{ display: 'block' }} data-testid="migration-offer">
      <div style={{ fontWeight: 700 }}>Leaving the synced folder</div>
      <div style={{ margin: '3px 0 6px' }}>
        The board wrote {files.length} file{files.length === 1 ? '' : 's'} into {q.data.folder} (skills, hooks, MCP
        servers). Configuration is now loaded per run, so they can go. Only what nobody changed is removed; your own
        files stay
        {kept.length ? `, and ${kept.length} changed file${kept.length === 1 ? '' : 's'} will be left as they are` : ''}
        . The next run of this member starts a fresh conversation.
      </div>
      <ul className="ai-mono" style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12 }}>
        {files.map((f) => (
          <li key={f.path}>
            {f.path}
            {f.blockOnly ? ' (only the board’s block)' : f.unchanged ? '' : ' (changed, kept)'}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="ai-btn ai-btn-sm ai-btn-primary"
        data-testid="migration-run"
        disabled={go.isPending}
        onClick={async () => {
          setError(null);
          try {
            setDone((await go.mutateAsync(undefined)).removed);
          } catch (e) {
            setError(extractError(e));
          }
        }}
      >
        {go.isPending ? 'Removing...' : 'Remove them'}
      </button>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
