import { useState } from 'react';
import { useAiWindows, usePatchWindow } from '../../../api/aiWindows';
import { extractError } from '../../../api/extractError';
import type { AccountWindow, RoomAccount } from '../../../types/aiWindows';
import { useToast } from '../../Toast';
import { LoadError, Toggle } from '../aiUi';
import { MoveUrgentDialog } from './MoveUrgentDialog';
import { WindowBar } from './WindowBar';
import { clock, isHeld, planLine, readText, runsText, windowTone } from './windowFormat';

function minutesSince(iso: string | null, nowMs: number): number {
  return iso ? Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000)) : 0;
}

/** The limit control: “Run at most [2] at a time”. Saves when the number is committed. */
function LimitControl({ account }: { account: AccountWindow }) {
  const patch = usePatchWindow();
  const toast = useToast();
  const [value, setValue] = useState(String(account.maxParallel));
  const save = (n: number) => {
    const next = Math.min(20, Math.max(1, Math.round(n) || account.maxParallel));
    setValue(String(next));
    if (next !== account.maxParallel)
      patch.mutate(
        { key: account.key, body: { maxParallel: next } },
        { onError: (e) => toast.error('Could not change the limit', extractError(e)) },
      );
  };
  return (
    <label className="win-limit">
      <span>Run at most</span>
      <input
        className="ai-input win-limit-input"
        type="number"
        min={1}
        max={20}
        aria-label={`Runs at a time on ${account.name}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => save(Number(value))}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <span>at a time</span>
    </label>
  );
}

function WindowCard({
  account,
  nowMs,
  onMove,
  canMove,
}: {
  account: AccountWindow;
  nowMs: number;
  onMove: () => void;
  canMove: boolean;
}) {
  const patch = usePatchWindow();
  const toast = useToast();
  const held = isHeld(account, nowMs);
  const tone = windowTone(Math.max(account.fiveHour.used ?? 0, account.sevenDay.used ?? 0));
  const runs = runsText(account, nowMs);
  const signedOut = account.status !== 'signed_in';
  return (
    <div
      className={`win-card ${held || tone === 'full' ? 'win-card-held' : ''}`}
      data-testid={`window-${account.key}`}
      data-held={held}
    >
      <div className="win-id">
        <b>{account.email ?? account.name}</b>
        <div className="acc-hint">
          {account.key === 'local' ? 'This computer’s own login' : planLine(account)}
          {account.key === 'local' && account.plan ? ` · ${account.plan}` : ''}
        </div>
      </div>
      <div className="win-bars">
        <WindowBar label="5 hours" window={account.fiveHour} nowMs={nowMs} />
        <WindowBar label="Week" window={account.sevenDay} nowMs={nowMs} />
        <div className="acc-hint" data-testid="win-read">
          {readText(account.readAt)}
          {signedOut && account.readAt ? ', before it signed out' : ''}
        </div>
      </div>
      <div className="win-runs">
        {account.running.map((r) => (
          <div key={r.runId} className="win-run">
            <span className="win-ticket">{r.ticketId}</span>
            <span className="acc-hint">· {minutesSince(r.startedAt, nowMs)} min</span>
          </div>
        ))}
        {runs.running && <div className="acc-hint">{runs.running}</div>}
        <div
          className={held ? 'win-held' : 'acc-hint'}
          data-testid="win-waiting"
          title={account.heldReason ?? undefined}
        >
          {runs.waiting}
        </div>
        {held && (
          <div className="acc-hint" data-testid="win-held">
            {account.heldReason ? `${account.heldReason}. ` : ''}Held since the window was used up. Nothing is lost.
            {account.heldUntil ? ` Starts again at ${clock(account.heldUntil)}.` : ''}
          </div>
        )}
      </div>
      <div className="win-actions">
        <LimitControl key={account.maxParallel} account={account} />
        <div className="win-switch">
          <Toggle
            on={account.moveUrgent}
            label="Move urgent work by itself, next time"
            testId={`move-urgent-switch-${account.key}`}
            onChange={(v) =>
              patch.mutate(
                { key: account.key, body: { moveUrgent: v } },
                { onError: (e) => toast.error('Could not change the switch', extractError(e)) },
              )
            }
          />
          <span className="acc-hint">Move urgent work by itself, next time</span>
        </div>
        {account.waiting > 0 && (
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={!canMove}
            title={canMove ? undefined : 'No other Claude account has room right now.'}
            onClick={onMove}
          >
            Move urgent work
          </button>
        )}
      </div>
    </div>
  );
}

/** “This window” of each Claude account, above the account list (design/screens/ai-operations.md, E). */
export function WindowsSection({ projectId }: { projectId: string }) {
  const windows = useAiWindows();
  const [moving, setMoving] = useState<AccountWindow | null>(null);
  const [now] = useState(() => Date.now());
  const nowMs = windows.dataUpdatedAt || now;

  let body;
  if (windows.isLoading) {
    body = (
      <div aria-busy="true" aria-label="Loading usage windows">
        <div className="ai-skel acc-skel" />
      </div>
    );
  } else if (windows.error) {
    body = <LoadError what="usage windows" error={windows.error} onRetry={() => void windows.refetch()} />;
  } else if (!windows.data?.accounts.length) {
    body = (
      <div className="acc-hint" data-testid="windows-empty">
        No Claude account yet, so there is no usage window to show.
      </div>
    );
  } else {
    const room: RoomAccount[] = windows.data.room;
    body = (
      <div className="win-list">
        {windows.data.accounts.map((a) => (
          <WindowCard
            key={a.key}
            account={a}
            nowMs={nowMs}
            canMove={room.some((r) => r.accountId !== a.key)}
            onMove={() => setMoving(a)}
          />
        ))}
      </div>
    );
  }

  return (
    <section className="win-root" data-testid="windows-section" aria-label="Usage windows of Claude accounts">
      <div className="win-head">
        <b>Usage window</b>
        <span className="acc-hint">
          A subscription has a usage window, not a bill. This is how much of the current window each account has spent,
          when it reopens, and what is waiting on it.
        </span>
      </div>
      {body}
      {moving && windows.data && (
        <MoveUrgentDialog
          account={moving}
          room={windows.data.room}
          projectId={projectId}
          onClose={() => setMoving(null)}
        />
      )}
    </section>
  );
}
