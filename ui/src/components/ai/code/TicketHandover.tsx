import { useState, type CSSProperties, type ReactNode } from 'react';
import { codeApi, useCodeMutation, useTicketWorktree } from '../../../api/aiCode';
import { useAiBoard } from '../../../api/ai';
import { useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import type { Ticket } from '../../../types';
import type { HandoverRoute, MergeResult } from '../../../types/aiCode';
import { ROUTE_TEXT, StateChip, mbText, uncommittedText, waitsForYou } from './worktreeUi';
import '../activity/design/designBlocks.css';

type Route = Exclude<HandoverRoute, 'auto'>;

/** "This project hands over by opening a pull request": the route as the sentence of the design says it. */
const ROUTE_VERB: Record<Route, string> = {
  pr: 'opening a pull request',
  local: 'merging on this machine',
  branch: 'leaving the branch',
};

/** The button that switches this ticket to another route (design H: "Merge here instead"). */
const ROUTE_SWITCH: Record<Route, { text: string; testId: string }> = {
  pr: { text: 'Open a pull request instead', testId: 'route-pr' },
  local: { text: 'Merge here instead', testId: 'merge-here' },
  branch: { text: 'Leave the branch instead', testId: 'route-branch' },
};

const isRoute = (r: HandoverRoute | null | undefined): r is Route => !!r && r !== 'auto';

const BRANCH_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6 8.5v7M18 11.5c0 4-6 3-12 4.5" />
  </svg>
);

/** A coloured box inside the card: amber for what waits, red for a conflict, green for done. */
function Box({
  tone,
  testId,
  role,
  children,
}: {
  tone: 'amber' | 'red' | 'green';
  testId: string;
  role?: string;
  children: ReactNode;
}) {
  const look: Record<typeof tone, CSSProperties> = {
    amber: { border: '1px solid #F0CDA0', background: '#FFF4E5' },
    red: { border: '1px solid #F0C4B8', background: '#FDF3F0' },
    green: { border: '1px solid #BFDCC7', background: '#F1F8F3' },
  };
  return (
    <div
      data-testid={testId}
      role={role}
      style={{
        ...look[tone],
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 12.5,
        lineHeight: 1.55,
        color: '#1E2A22',
      }}
    >
      {children}
    </div>
  );
}

const code = (text: string) => (
  <code
    style={{
      fontFamily: "'JetBrains Mono',monospace",
      fontSize: 11.5,
      background: '#F1F4F2',
      color: '#1E2A22',
      border: '1px solid #E3E8E5',
      borderRadius: 5,
      padding: '1px 6px',
    }}
  >
    {text}
  </code>
);

/**
 * A ticket's worktree and how its code is handed over, in the look of the canvas design (design/screens/
 * ai-operations.md, G and H): the branch, its state and size; what is left uncommitted (move the outputs to the
 * Workspace, commit the code, or discard it all); the route (a pull request, a merge on this machine or the branch
 * left pushed), changed for this ticket only; Merge when the route is this machine; and a conflict with the base
 * branch. Nothing when the ticket has no worktree.
 */
export function TicketHandover({ ticket }: { ticket: Ticket }) {
  const wt = useTicketWorktree(ticket.id);
  const ops = useProjectOps(ticket.projectId);
  const board = useAiBoard(ticket.projectId);
  const runHere = board.data?.tickets?.[ticket.id];
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
  if (!w || w.state === 'removed') {
    // a merge removes the worktree at once: say it went through before the card goes
    if (!result?.merged) return null;
    return (
      <div className="dz dz-tw" data-testid="ticket-handover" data-ticket={ticket.id}>
        <Box tone="green" testId="merge-done" role="status">
          <b style={{ color: '#1F5A31' }}>Merged.</b>
          <span>The worktree is removed and its port is given back.</span>
        </Box>
      </div>
    );
  }

  // the project's own choice (Settings › AI › Repositories), or none when the board guesses from the repository
  const projectSetting = (ops.data?.worktrees as { handover?: HandoverRoute } | undefined)?.handover;
  const projectRoute = isRoute(projectSetting) ? projectSetting : null;
  const own = isRoute(w.handover) ? w.handover : null;
  // the server says which route it will use (it alone can guess from the repository); an older answer has no route
  const eff: Route = isRoute(w.route) ? w.route : (own ?? projectRoute ?? 'pr');
  const dirty = (w.live?.uncommitted.length ?? 0) > 0;
  const busy = moveOutputs.isPending || commit.isPending || discard.isPending;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    }
  };
  const conflict = w.state === 'conflict';
  const merged = w.state === 'merged';

  return (
    <div className="dz dz-tw" data-testid="ticket-handover" data-ticket={ticket.id} data-route={eff}>
      <div
        style={{
          border: `1px solid ${conflict ? '#F0C4B8' : merged ? '#E3E8E5' : '#BFDCC7'}`,
          borderRadius: 12,
          background: merged ? '#fff' : '#F6FBF7',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}
          data-testid="handover-worktree"
        >
          <span style={{ color: conflict ? '#A5321E' : '#2E6F40', display: 'flex' }}>{BRANCH_ICON}</span>
          <b style={{ fontSize: 13.5 }}>Worktree</b>
          {code(w.branch)}
          <span style={{ flex: 1 }} />
          <StateChip state={w.state} waiting={waitsForYou(w, runHere)} />
        </div>
        <div className="st-hint" style={{ fontSize: 12, marginTop: -6 }}>
          {w.live ? `${mbText(w.live.sizeMb)} · ` : ''}
          {w.port ? `port ${w.port} · ` : ''}
          {uncommittedText(w)}
          {w.base ? ` · from ${w.base}` : ''}
        </div>

        {conflict && (
          <Box tone="red" testId="handover-conflict" role="alert">
            <b style={{ color: '#A5321E' }}>Cannot be merged: {w.base ?? 'the base branch'} has moved</b>
            <span>
              {w.conflictFiles.length > 0 ? (
                <>
                  {w.conflictFiles.length === 1 ? 'One file differs' : `${w.conflictFiles.length} files differ`} from{' '}
                  {w.base ?? 'the base'}:{' '}
                  {w.conflictFiles.slice(0, 6).map((f, i) => (
                    <span key={f}>
                      {i > 0 && ', '}
                      {code(f)}
                    </span>
                  ))}
                  {w.conflictFiles.length > 6 ? ` and ${w.conflictFiles.length - 6} more` : ''}.{' '}
                </>
              ) : null}
              The merge was not started, so the worktree is exactly as the AI left it.
            </span>
          </Box>
        )}

        {dirty && !merged && (
          <NotCommitted
            files={w.live?.uncommitted ?? []}
            outputs={w.live?.outputs ?? []}
            busy={busy}
            confirmDiscard={confirmDiscard}
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

        {tidyNote && (
          <div className="st-hint" style={{ fontSize: 12 }} data-testid="tidy-note" role="status">
            {tidyNote}
          </div>
        )}

        {merged ? (
          <div className="st-hint" style={{ fontSize: 12.5 }}>
            Merged. The worktree is removed and its port is given back.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="ready-to-hand-over">
            <div style={{ fontSize: 13, lineHeight: 1.55 }} data-testid="handover-route">
              This ticket hands over by <b>{ROUTE_VERB[eff]}</b>.{' '}
              {own ? (
                <>
                  That is its own choice; the project&rsquo;s is{' '}
                  {projectRoute ? ROUTE_VERB[projectRoute] : 'guessed from the repository'}.{' '}
                  <button
                    type="button"
                    className="mc-link"
                    disabled={handover.isPending}
                    data-testid="route-auto"
                    onClick={() => void run(() => handover.mutateAsync('auto'))}
                  >
                    Use the project&rsquo;s
                  </button>
                </>
              ) : (
                <>
                  {projectRoute ? 'The project chose it' : 'The board guessed it from the repository'}; you can change
                  it for this ticket.
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {eff === 'local' && (
                <button
                  type="button"
                  className="st-btn st-btn-sm st-btn-primary"
                  disabled={merge.isPending || dirty}
                  title={dirty ? 'Commit or keep the changes in the worktree first' : undefined}
                  data-testid="merge-btn"
                  onClick={() =>
                    void run(async () => {
                      setResult(null);
                      setResult(await merge.mutateAsync(undefined));
                    })
                  }
                >
                  {BRANCH_ICON}
                  {merge.isPending ? 'Merging…' : 'Merge'}
                </button>
              )}
              {(Object.keys(ROUTE_SWITCH) as Route[])
                .filter((r) => r !== eff)
                .map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="st-btn st-btn-sm"
                    disabled={handover.isPending}
                    data-testid={ROUTE_SWITCH[r].testId}
                    onClick={() => void run(() => handover.mutateAsync(r))}
                  >
                    {ROUTE_SWITCH[r].text}
                  </button>
                ))}
            </div>
            <div className="st-hint" style={{ fontSize: 11.5 }} data-testid="handover-hint">
              {eff === 'local'
                ? dirty
                  ? 'Commit or keep the changes in the worktree first.'
                  : 'Merging also removes the worktree. Only you merge, never a rule or an AI.'
                : ROUTE_TEXT[eff]}
            </div>
          </div>
        )}

        {w.prUrl && (
          <a href={w.prUrl} target="_blank" rel="noreferrer" className="mc-link" data-testid="handover-pr">
            Pull request{w.prNumber ? ` #${w.prNumber}` : ''}
          </a>
        )}
        {result?.merged && (
          <Box tone="green" testId="merge-done" role="status">
            <b style={{ color: '#1F5A31' }}>Merged.</b>
          </Box>
        )}
        {result?.refused && (
          <Box tone="amber" testId="merge-refused" role="alert">
            {result.refused}
          </Box>
        )}
        {result?.conflict && result.conflict.length > 0 && !conflict && (
          <Box tone="red" testId="merge-conflict" role="alert">
            The merge stopped on a conflict in {result.conflict.length} file{result.conflict.length === 1 ? '' : 's'},
            so it was rolled back.
          </Box>
        )}
        {result?.prUrl && (
          <a href={result.prUrl} target="_blank" rel="noreferrer" className="mc-link">
            Pull request
          </a>
        )}
        {error && (
          <div className="st-status-err" role="alert" data-testid="handover-error">
            {error}
          </div>
        )}
      </div>
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
  onMoveOutputs,
  onCommit,
  onDiscard,
  onCancelDiscard,
}: {
  files: string[];
  outputs: string[];
  busy: boolean;
  confirmDiscard: boolean;
  onMoveOutputs: () => void;
  onCommit: () => void;
  onDiscard: () => void;
  onCancelDiscard: () => void;
}) {
  const out = new Set(outputs);
  const codeFiles = files.filter((f) => !out.has(f));
  return (
    <Box tone="amber" testId="worktree-not-committed">
      <b style={{ color: '#8A4B08' }}>
        {files.length} file{files.length === 1 ? '' : 's'} not committed: the worktree stays until you decide
      </b>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
        {files.slice(0, 8).map((f) => (
          <li key={f}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{f}</span>
            {out.has(f) ? <span style={{ color: '#6B7A70' }}> · output</span> : null}
          </li>
        ))}
        {files.length > 8 && <li style={{ color: '#6B7A70' }}>and {files.length - 8} more</li>}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {outputs.length > 0 && (
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            disabled={busy}
            data-testid="move-outputs"
            onClick={onMoveOutputs}
          >
            Move {outputs.length} output{outputs.length === 1 ? '' : 's'} to the Workspace
          </button>
        )}
        {codeFiles.length > 0 && (
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={busy}
            data-testid="commit-leftovers"
            onClick={onCommit}
          >
            Commit the code
          </button>
        )}
        <button
          type="button"
          className={`st-btn st-btn-sm ${confirmDiscard ? 'st-btn-danger' : 'st-btn-danger-outline'}`}
          disabled={busy}
          data-testid="discard-worktree"
          onClick={onDiscard}
        >
          {confirmDiscard ? `Discard ${files.length} file${files.length === 1 ? '' : 's'} and remove` : 'Discard…'}
        </button>
        {confirmDiscard && (
          <button type="button" className="st-btn st-btn-sm" onClick={onCancelDiscard}>
            Cancel
          </button>
        )}
      </div>
      {confirmDiscard && (
        <span className="st-hint" style={{ fontSize: 11.5 }}>
          This deletes the worktree and everything not committed in it. It cannot be undone.
        </span>
      )}
    </Box>
  );
}
