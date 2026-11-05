import type { RunState } from '../../../types/ai';

/** What a worktree row needs of the latest run of its ticket. */
export interface WorktreeRun {
  state: RunState;
  memberId?: string;
  memberName?: string | null;
  endedAt?: string | null;
}
import type { HandoverRoute, Worktree, WorktreeState } from '../../../types/aiCode';
import { hhmm, useAiBoardState } from '../aiUi';

export const STATE_LABEL: Record<WorktreeState, string> = {
  active: 'In use',
  conflict: 'Conflict with main',
  kept: 'Kept',
  merged: 'Merged',
  removed: 'Removed',
};

const STATE_TONE: Record<WorktreeState, { bg: string; fg: string }> = {
  active: { bg: '#E8F3EC', fg: '#2E6F40' },
  conflict: { bg: '#FBEAE6', fg: '#C4432A' },
  kept: { bg: '#EEF1F6', fg: '#4A5A7A' },
  merged: { bg: '#F0ECFA', fg: '#6D5DD3' },
  removed: { bg: '#F1F4F2', fg: '#5B6B60' },
};

export const ROUTE_TITLE: Record<Exclude<HandoverRoute, 'auto'>, string> = {
  pr: 'Open a pull request',
  local: 'Merge on this machine',
  branch: 'Leave the branch',
};

export const ROUTE_TEXT: Record<Exclude<HandoverRoute, 'auto'>, string> = {
  pr: 'Opened as a draft when the ticket reaches Review, marked ready at Done.',
  local: 'Only ever when you ask: moving to Done, or the Merge button. Never while the main checkout is dirty.',
  branch: 'The branch is pushed and you open whatever your host calls a merge request.',
};

/** A run that is queued or going on this ticket. */
export function isRunning(run: WorktreeRun | null | undefined): boolean {
  return !!run && ['queued', 'starting', 'running'].includes(run.state);
}

/** "Waiting for you": nothing is running and the AI left changes that are not committed (design I). */
export function waitsForYou(w: Worktree, run: WorktreeRun | null | undefined): boolean {
  return w.state === 'active' && !isRunning(run) && uncommittedCount(w) > 0;
}

export const WAITING_LABEL = 'Waiting for you';

/** A worktree state as a chip. */
export function StateChip({ state, waiting }: { state: WorktreeState; waiting?: boolean }) {
  const t = waiting ? { bg: '#FDF0E6', fg: '#B4571F' } : STATE_TONE[state];
  return (
    <span className="ai-chip" style={{ background: t.bg, color: t.fg }} data-testid="worktree-state">
      {waiting ? WAITING_LABEL : STATE_LABEL[state]}
    </span>
  );
}

/** How many files are changed and not committed. */
export function uncommittedCount(w: Worktree): number {
  return w.live?.uncommitted.length ?? 0;
}

/** Remove is never offered while something is uncommitted (Keep is); nor for a worktree that is gone already. */
export function canRemove(w: Worktree): boolean {
  return w.state !== 'removed' && uncommittedCount(w) === 0;
}

/** Keep is for a worktree that would otherwise be cleaned up. */
export function canKeep(w: Worktree): boolean {
  return w.state === 'active' || w.state === 'conflict' || w.state === 'merged';
}

/** Megabytes as MB, or GB from 1024. */
export function mbText(mb: number | null | undefined): string {
  if (mb == null) return '-';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The uncommitted line under a branch. */
export function uncommittedText(w: Worktree): string {
  const n = uncommittedCount(w);
  return n === 0 ? 'nothing uncommitted' : `${n} file${n === 1 ? '' : 's'} changed, not committed`;
}

/** One row of the worktree list. */
export function WorktreeRow({
  w,
  run,
  busy,
  onRemove,
  onKeep,
  onCopyPath,
  onOpen,
  onStop,
}: {
  w: Worktree;
  /** The latest run on the ticket, when known. */
  run?: WorktreeRun | null;
  busy?: boolean;
  onRemove: () => void;
  onKeep: () => void;
  onCopyPath: () => void;
  onOpen?: () => void;
  onStop?: () => void;
}) {
  const dirty = uncommittedCount(w) > 0;
  const running = isRunning(run);
  const known = useAiBoardState().members.get(run?.memberId ?? '')?.name;
  const memberName = run?.memberName ?? known;
  const who = memberName
    ? `${memberName}${running ? '' : ` stopped${run?.endedAt ? ` at ${hhmm(run.endedAt)}` : ''}`} · `
    : '';
  return (
    <tr data-testid={`worktree-${w.ticketId}`}>
      <td>
        <div style={{ fontWeight: 600 }}>{w.ticketId}</div>
      </td>
      <td>
        <div className="ai-mono">{w.branch}</div>
        <div className="ai-muted">
          {who}
          {uncommittedText(w)}
          {w.live && !w.live.exists ? ' · folder missing' : ''}
        </div>
      </td>
      <td>
        <StateChip state={w.state} waiting={waitsForYou(w, run)} />
      </td>
      <td>{mbText(w.live?.sizeMb)}</td>
      <td className="ai-mono">{w.port ?? '-'}</td>
      <td>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {onOpen && w.state !== 'removed' && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={onOpen} title={w.path}>
              Open folder
            </button>
          )}
          <button type="button" className="ai-btn ai-btn-sm" onClick={onCopyPath} title={w.path}>
            Copy path
          </button>
          {running && onStop && (
            <button type="button" className="ai-btn ai-btn-sm ai-btn-danger-outline" disabled={busy} onClick={onStop}>
              Stop
            </button>
          )}
          {w.state === 'conflict' && (
            <a
              className="ai-btn ai-btn-sm ai-btn-primary"
              style={{ textDecoration: 'none' }}
              href={`?ticket=${encodeURIComponent(w.ticketId)}`}
            >
              Resolve
            </a>
          )}
          {canRemove(w) && (
            <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          )}
          {(dirty || w.state === 'active') && canKeep(w) && w.state !== 'kept' && (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={busy}
              onClick={onKeep}
              title={dirty ? 'Something is not committed, so it stays' : undefined}
            >
              Keep
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** The conflict card of a ticket (design J): who resolves it. Nothing was started, nothing is half-done. */
export function ConflictCard({
  files,
  memberName,
  busy,
  error,
  onChoose,
}: {
  files: string[];
  memberName: string | null;
  busy?: boolean;
  error?: string | null;
  onChoose: (choice: 'ai' | 'me' | 'later') => void;
}) {
  return (
    <div className="ai-notice ai-notice-error" data-testid="conflict-card" style={{ display: 'block' }}>
      <div style={{ fontWeight: 700 }}>Conflict: cannot be merged, main has moved</div>
      <div style={{ margin: '4px 0 8px' }}>
        {files.length === 0
          ? 'Some files differ from main.'
          : `${files.length === 1 ? 'One file differs' : `${files.length} files differ`} from main: ${files.join(', ')}.`}{' '}
        The merge was not started, so the worktree is exactly as the AI left it.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {memberName && (
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={busy}
            onClick={() => onChoose('ai')}
          >
            Give it to {memberName}
          </button>
        )}
        <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => onChoose('me')}>
          I will do it
        </button>
        <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => onChoose('later')}>
          Leave it for now
        </button>
      </div>
      {memberName && (
        <div className="ai-hint" style={{ marginTop: 6 }}>
          Handing it to an AI starts a run whose only job is the conflict. It can fail, and it lands in Needs you if it
          does.
        </div>
      )}
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
