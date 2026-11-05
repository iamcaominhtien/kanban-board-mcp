import { useMemo, useState } from 'react';
import { useAiTeams } from '../../../api/ai';
import { useAiWindows, usePatchWindow } from '../../../api/aiWindows';
import { extractError } from '../../../api/extractError';
import type { AccountWindow, RoomAccount } from '../../../types/aiWindows';
import { useToast } from '../../Toast';
import { LoadError, Toggle } from '../aiUi';
import type { AiTeam } from '../../../types/ai';
import { AccountBadge } from './AccountParts';
import { MoveUrgentDialog } from './MoveUrgentDialog';
import { WindowBar } from './WindowBar';
import { clock, isHeld, lastReadText, planLine, runsText, windowTone } from './windowFormat';

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
    <label className="win-limit" title="This account's own limit">
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

/**
 * The one header control of design E: “Run at most [2] at a time per account”. It sets every account's limit; an
 * account keeps its own number in its row when it should differ.
 */
function AllLimitControl({ accounts }: { accounts: AccountWindow[] }) {
  const patch = usePatchWindow();
  const toast = useToast();
  const counts = new Map<number, number>();
  accounts.forEach((a) => counts.set(a.maxParallel, (counts.get(a.maxParallel) ?? 0) + 1));
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 2;
  const [value, setValue] = useState(String(common));
  const save = (n: number) => {
    const next = Math.min(20, Math.max(1, Math.round(n) || common));
    setValue(String(next));
    accounts
      .filter((a) => a.maxParallel !== next)
      .forEach((a) =>
        patch.mutate(
          { key: a.key, body: { maxParallel: next } },
          { onError: (e) => toast.error('Could not change the limit', extractError(e)) },
        ),
      );
  };
  return (
    <label className="win-limit win-limit-all">
      <span>Run at most</span>
      <input
        className="ai-input win-limit-input"
        type="number"
        min={1}
        max={20}
        aria-label="Runs at a time on every account"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => save(Number(value))}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        data-testid="win-limit-all"
      />
      <span className="acc-hint">at a time per account</span>
    </label>
  );
}

function WindowCard({
  account,
  nowMs,
  onMove,
  canMove,
  members,
}: {
  account: AccountWindow;
  nowMs: number;
  onMove: () => void;
  canMove: boolean;
  /** This project's AI members, for the MEMBERS column and the member on each running run. */
  members: AiTeam[];
}) {
  const patch = usePatchWindow();
  const toast = useToast();
  const held = isHeld(account, nowMs);
  const tone = windowTone(Math.max(account.fiveHour.used ?? 0, account.sevenDay.used ?? 0));
  const runs = runsText(account, nowMs);
  const signedOut = account.status !== 'signed_in';
  const users = members.filter((m) => (account.key === 'local' ? !m.accountId : m.accountId === account.key));
  const byId = new Map(members.map((m) => [m.id, m]));
  return (
    <div
      className={`win-card ${held || tone === 'full' ? 'win-card-held' : ''} ${signedOut ? 'win-card-out' : ''}`}
      data-testid={`window-${account.key}`}
      data-held={held}
    >
      <div className="win-id">
        <AccountBadge cli="claude" label="Claude Code" />
        <div style={{ minWidth: 0 }}>
          <b>{account.email ?? account.name}</b>
          <div className="acc-hint">{planLine(account)}</div>
        </div>
      </div>
      <div className="win-bars">
        <WindowBar label="5 hours" window={account.fiveHour} nowMs={nowMs} />
        <WindowBar label="Week" window={account.sevenDay} nowMs={nowMs} />
        <div className="acc-hint" data-testid="win-read">
          {lastReadText(account.readAt, signedOut)}
        </div>
      </div>
      <div className="win-members" data-testid="win-members">
        <b>{users.length}</b> member{users.length === 1 ? '' : 's'}
      </div>
      <div className="win-runs">
        {account.running.map((r) => (
          <div key={r.runId} className="win-run">
            {byId.get(r.memberId) && <span className="win-member">{byId.get(r.memberId)!.name}</span>}
            <span className="win-ticket">{r.ticketId}</span>
            <span className="acc-hint">· {minutesSince(r.startedAt, nowMs)} min</span>
          </div>
        ))}
        {runs.running && <div className="acc-hint">{runs.running}</div>}
        <div
          className={held || signedOut ? 'win-held' : 'acc-hint'}
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
  const teams = useAiTeams(projectId);
  const members = useMemo(() => teams.data ?? [], [teams.data]);
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
        <div className="win-card win-cols" aria-hidden="true">
          <span>Claude account</span>
          <span>This window</span>
          <span>Members</span>
          <span>Running now</span>
          <span />
        </div>
        {windows.data.accounts.map((a) => (
          <WindowCard
            key={a.key}
            account={a}
            nowMs={nowMs}
            canMove={room.some((r) => r.accountId !== a.key)}
            members={members}
            onMove={() => setMoving(a)}
          />
        ))}
      </div>
    );
  }

  return (
    <section className="win-root" data-testid="windows-section" aria-label="Usage windows of Claude accounts">
      {/* E: one header with the account count and the one limit control */}
      <div className="win-head">
        <div className="win-head-row">
          <b className="win-title">Usage window</b>
          {!!windows.data?.accounts.length && (
            <span className="win-count" data-testid="win-count">
              {windows.data.accounts.length} Claude account{windows.data.accounts.length === 1 ? '' : 's'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {!!windows.data?.accounts.length && (
            <AllLimitControl
              key={windows.data.accounts.map((a) => a.maxParallel).join(',')}
              accounts={windows.data.accounts}
            />
          )}
        </div>
        <span className="acc-hint">
          A subscription has a usage window, not a bill. This is how much of the current window each account has spent,
          when it reopens, and what is waiting on it.
        </span>
      </div>
      {body}
      <div className="win-note">
        <b>Where these numbers come from.</b> The CLI does not publish what is left in a window. The board learns it two
        ways: it counts what it spent itself, and it reads the reset time the CLI gives when a limit is actually hit. So
        the bar is the board’s own count and says so; the reset time is exact.
      </div>
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
