import { useState } from 'react';
import { PullStatus } from './PullStatus';
import { codeApi, useCodeMutation, useTicketWorktree } from '../../../api/aiCode';
import { useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import type { Ticket } from '../../../types';
import type { HandoverRoute, MergeResult } from '../../../types/aiCode';
import { ROUTE_TEXT, ROUTE_TITLE, StateChip, mbText, uncommittedText } from './worktreeUi';

/** A ticket's worktree and hand-over (design/screens/ai-operations.md, J): ready to hand over, merge, a conflict. */
export function TicketHandover({ ticket }: { ticket: Ticket }) {
  const wt = useTicketWorktree(ticket.id);
  const ops = useProjectOps(ticket.projectId);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const merge = useCodeMutation(() => codeApi.merge(ticket.id));
  const handover = useCodeMutation((r: HandoverRoute) => codeApi.handover(ticket.id, r));
  const moveOutputs = useCodeMutation(() => codeApi.moveOutputs(ticket.id));
  const commit = useCodeMutation(() => codeApi.commit(ticket.id));
  const discard = useCodeMutation(() => codeApi.discard(ticket.id));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [tidyNote, setTidyNote] = useState<string | null>(null);

  const w = wt.data;
  if (!w || w.state === 'removed') return null;

  const route = (w as { route?: HandoverRoute }).route ?? w.handover ?? 'auto';
  const eff: Exclude<HandoverRoute, 'auto'> = route === 'auto' ? 'pr' : route;
  // the project's own choice (Settings › AI › Repositories); this ticket's can differ
  const projectDefault = (ops.data?.worktrees as { handover?: HandoverRoute } | undefined)?.handover;
  const projectRoute: Exclude<HandoverRoute, 'auto'> =
    !projectDefault || projectDefault === 'auto' ? 'pr' : projectDefault;
  const dirty = (w.live?.uncommitted.length ?? 0) > 0;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div
      className="ai-card"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="ticket-handover"
      data-ticket={ticket.id}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} data-testid="handover-worktree">
        <span style={{ fontSize: 13, fontWeight: 700 }}>Worktree</span>
        <StateChip state={w.state} />
        <span className="ai-mono" style={{ fontSize: 12 }}>
          {w.branch}
        </span>
        <span className="ai-muted">
          {w.live ? `${mbText(w.live.sizeMb)} · ` : ''}
          {w.port ? `port ${w.port} · ` : ''}
          {uncommittedText(w)}
        </span>
      </div>
      {dirty && w.state !== 'merged' && (
        <NotCommitted
          files={w.live?.uncommitted ?? []}
          outputs={w.live?.outputs ?? []}
          busy={moveOutputs.isPending || commit.isPending || discard.isPending}
          confirmDiscard={confirmDiscard}
          note={tidyNote}
          onMoveOutputs={() =>
            void run(async () => {
              const r = await moveOutputs.mutateAsync(undefined);
              setTidyNote(
                r.moved.length
                  ? `Moved ${r.moved.length} file${r.moved.length === 1 ? '' : 's'} to the Workspace: ${r.to}`
                  : (r.reason ?? 'Nothing to move.'),
              );
            })
          }
          onCommit={() =>
            void run(async () => {
              const r = await commit.mutateAsync(undefined);
              setTidyNote(r.committed ? 'Committed on the branch.' : 'Nothing to commit.');
            })
          }
          onDiscard={() => {
            if (!confirmDiscard) {
              setConfirmDiscard(true);
              return;
            }
            setConfirmDiscard(false);
            void run(() => discard.mutateAsync(undefined));
          }}
          onCancelDiscard={() => setConfirmDiscard(false)}
        />
      )}
      {w.prUrl && (
        <div>
          <a href={w.prUrl} target="_blank" rel="noreferrer" className="ai-link" data-testid="handover-pr">
            Pull request{w.prNumber ? ` #${w.prNumber}` : ''}
          </a>
        </div>
      )}

      {w.state === 'merged' ? (
        <div className="ai-hint">Merged. The worktree is removed and its port is given back.</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }} data-testid="ready-to-hand-over">
          <div className="ai-label">WHEN THE WORK IS READY, HAND IT OVER BY</div>
          <div
            role="radiogroup"
            aria-label="Hand the work over by"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}
          >
            {(Object.keys(ROUTE_TITLE) as Exclude<HandoverRoute, 'auto'>[]).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={eff === r}
                disabled={handover.isPending}
                className={`ai-option ${eff === r ? 'ai-option-active' : ''}`}
                style={{ alignItems: 'flex-start', textAlign: 'left' }}
                data-testid={`handover-${r}`}
                onClick={() => eff !== r && void run(() => handover.mutateAsync(r))}
              >
                <span className={`ai-radio ${eff === r ? 'ai-radio-on' : ''}`} />
                <span>
                  <b style={{ fontSize: 13 }}>{ROUTE_TITLE[r]}</b>
                  <div className="ai-muted">{ROUTE_TEXT[r]}</div>
                </span>
              </button>
            ))}
          </div>
          <div className="ai-hint">
            The project&rsquo;s default is {ROUTE_TITLE[projectRoute].toLowerCase()}. Choosing here changes only this
            ticket.
          </div>
          {eff === 'local' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                disabled={merge.isPending || dirty}
                title={dirty ? 'Commit or keep the changes in the worktree first' : undefined}
                data-testid="merge-btn"
                onClick={() => void run(async () => setResult(await merge.mutateAsync(undefined)))}
              >
                {merge.isPending ? 'Merging...' : 'Merge'}
              </button>
              <span className="ai-hint">Merging also removes the worktree. Only you merge, never a rule or an AI.</span>
            </div>
          )}
        </div>
      )}
      {result?.refused && (
        <div className="ai-notice ai-notice-warn" role="alert" data-testid="merge-refused">
          {result.refused}
        </div>
      )}
      {result?.merged && <div className="ai-ok-text">Merged.</div>}
      {result?.prUrl && (
        <a href={result.prUrl} target="_blank" rel="noreferrer" className="ai-link">
          Pull request
        </a>
      )}
      {error && <div className="ai-error-text">{error}</div>}
      <PullStatus ticketId={ticket.id} />
    </div>
  );
}

/** What keeps the worktree from being cleaned, and what a person can do about it (issue #269): the outputs a run left
 * (screenshots, logs, reports) go to the Workspace, the code is committed on the branch, or everything is discarded. */
function NotCommitted({
  files,
  outputs,
  busy,
  confirmDiscard,
  note,
  onMoveOutputs,
  onCommit,
  onDiscard,
  onCancelDiscard,
}: {
  files: string[];
  outputs: string[];
  busy: boolean;
  confirmDiscard: boolean;
  note: string | null;
  onMoveOutputs: () => void;
  onCommit: () => void;
  onDiscard: () => void;
  onCancelDiscard: () => void;
}) {
  const out = new Set(outputs);
  const code = files.filter((f) => !out.has(f));
  return (
    <div className="ai-notice ai-notice-warn" style={{ display: 'block' }} data-testid="worktree-not-committed">
      <div style={{ fontWeight: 700 }}>
        {files.length} file{files.length === 1 ? '' : 's'} not committed: the worktree stays until you decide
      </div>
      <ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12 }}>
        {files.slice(0, 8).map((f) => (
          <li key={f}>
            <span className="ai-mono">{f}</span>
            {out.has(f) ? <span className="ai-muted"> · output</span> : null}
          </li>
        ))}
        {files.length > 8 && <li className="ai-muted">and {files.length - 8} more</li>}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {outputs.length > 0 && (
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={busy}
            data-testid="move-outputs"
            onClick={onMoveOutputs}
          >
            Move {outputs.length} output{outputs.length === 1 ? '' : 's'} to the Workspace
          </button>
        )}
        {code.length > 0 && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={busy}
            data-testid="commit-leftovers"
            onClick={onCommit}
          >
            Commit the code
          </button>
        )}
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-danger-outline"
          disabled={busy}
          data-testid="discard-worktree"
          onClick={onDiscard}
        >
          {confirmDiscard ? `Discard ${files.length} file${files.length === 1 ? '' : 's'} and remove` : 'Discard…'}
        </button>
        {confirmDiscard && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={onCancelDiscard}>
            Cancel
          </button>
        )}
      </div>
      {confirmDiscard && (
        <div className="ai-hint" style={{ marginTop: 6 }}>
          This deletes the worktree and everything not committed in it. It cannot be undone.
        </div>
      )}
      {note && (
        <div className="ai-hint" style={{ marginTop: 6 }} data-testid="tidy-note">
          {note}
        </div>
      )}
    </div>
  );
}
