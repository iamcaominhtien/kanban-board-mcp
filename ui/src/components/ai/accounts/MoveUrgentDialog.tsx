import { useMemo, useState } from 'react';
import { useAiBoard, useAiOverview } from '../../../api/ai';
import { useMoveRun } from '../../../api/aiWindows';
import { extractError } from '../../../api/extractError';
import type { AccountWindow, RoomAccount } from '../../../types/aiWindows';
import { AccountDialog } from './AccountParts';
import { clock, usedText } from './windowFormat';

/**
 * “Move urgent work to another account” (design/screens/ai-operations.md, E): pick the waiting runs of an account
 * and the account with room that takes them. The member keeps its model and permissions; the conversation does not
 * carry over. Moving is always a person's choice here.
 */
export function MoveUrgentDialog({
  account,
  room,
  projectId,
  onClose,
}: {
  account: AccountWindow;
  room: RoomAccount[];
  projectId: string;
  onClose: () => void;
}) {
  const board = useAiBoard(projectId);
  const overview = useAiOverview(projectId);
  const move = useMoveRun();
  const targets = room.filter((r) => r.accountId !== account.key);
  const [target, setTarget] = useState<string | null>(targets[0]?.accountId ?? null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queued = useMemo(() => {
    const members = new Map((overview.data?.members ?? []).map((m) => [m.id, m]));
    return (board.data?.runs ?? []).filter((r) => {
      if (r.state !== 'queued') return false;
      const accountId = members.get(r.memberId)?.accountId ?? null;
      return (account.key === 'local' ? accountId == null : accountId === account.key) && !r.paused;
    });
  }, [board.data, overview.data, account.key]);

  const chosen = picked ?? queued.map((r) => r.id);
  const hidden = Math.max(0, account.waiting - queued.length);
  const loading = board.isLoading || overview.isLoading;

  const submit = async () => {
    if (!target) return;
    setError(null);
    const failed: string[] = [];
    let last: unknown = null;
    for (const runId of chosen) {
      try {
        await move.mutateAsync({ runId, accountId: target });
      } catch (e) {
        failed.push(runId);
        last = e;
      }
    }
    if (failed.length) {
      setPicked(failed);
      setError(extractError(last));
    } else onClose();
  };

  const to = targets.find((t) => t.accountId === target);
  return (
    <AccountDialog
      title="Move urgent work to another account"
      onClose={onClose}
      body={
        <div className="win-dlg" data-testid="move-urgent-dialog">
          <div className="acc-hint">
            {account.name} has used {usedText(account.fiveHour.used).replace(' used', '')} of its window
            {account.heldUntil ? ` and reopens at ${clock(account.heldUntil)}` : ''}. {account.waiting} run
            {account.waiting === 1 ? ' is' : 's are'} held. Moving work between accounts is yours to do. The board never
            does it on its own.
          </div>
          <div className="acc-h">Runs to move</div>
          {loading ? (
            <div className="ai-skel acc-skel" aria-busy="true" />
          ) : queued.length ? (
            <div className="win-list">
              {queued.map((r) => (
                <label key={r.id} className="win-pick">
                  <input
                    type="checkbox"
                    checked={chosen.includes(r.id)}
                    onChange={(e) =>
                      setPicked(e.target.checked ? [...chosen, r.id] : chosen.filter((id) => id !== r.id))
                    }
                  />
                  <b>{r.memberName ?? 'AI member'}</b>
                  <span className="win-ticket">{r.ticketId}</span>
                  <span className="acc-hint">held {r.queuedAt ? `since ${clock(r.queuedAt)}` : ''}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="acc-hint" data-testid="move-urgent-none">
              No waiting run of this project is on this account.
            </div>
          )}
          {hidden > 0 && queued.length > 0 && (
            <div className="acc-hint">
              {hidden} more wait here for other projects. Open those projects to move them.
            </div>
          )}
          <div className="acc-h">Run it on</div>
          {targets.length ? (
            <div className="win-list">
              {targets.map((t) => (
                <label key={t.accountId} className="win-pick">
                  <input
                    type="radio"
                    name="move-target"
                    checked={target === t.accountId}
                    onChange={() => setTarget(t.accountId)}
                  />
                  <b>{t.email ?? t.name}</b>
                  <span className="acc-hint">
                    {[t.plan, usedText(t.used), `room for ${t.free}`].filter(Boolean).join(' · ')}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="acc-hint" data-testid="move-urgent-no-room">
              No other Claude account has room right now.
            </div>
          )}
          <div className="acc-hint">
            The member keeps its own model and permissions. Only the account changes, and only for this run.
          </div>
          <div className="acc-hint">
            The conversation does not carry over: a run moved to another account starts a new one, with a hand-over note
            of what was done so far.
          </div>
          {error && <div className="ai-error-text">{error}</div>}
        </div>
      }
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={!to || !chosen.length || move.isPending}
            onClick={() => void submit()}
          >
            Move {chosen.length} run{chosen.length === 1 ? '' : 's'}
          </button>
        </>
      }
    />
  );
}
