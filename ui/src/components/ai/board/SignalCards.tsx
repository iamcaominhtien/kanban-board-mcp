import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { boardAiKeys, useSignals } from '../../../api/aiBoard';
import { aiApi } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { AiSignal, SignalKind } from '../../../types/aiBoard';
import { requestOpenNotifications } from '../../notifications/NotificationsHost';
import { useAssist } from '../../assist/AssistContext';
import { openRun } from '../../aiteam/runLink';
import { useAiBoardState } from '../aiUi';

const LOOK: Record<SignalKind, { border: string; bg: string; dot: string }> = {
  ai_failing: { border: '#F2C7BB', bg: '#FDECE8', dot: '#C4432A' },
  quota_near: { border: '#F0DBA8', bg: '#FFFBEF', dot: '#B8860B' },
  needs_queue: { border: '#F0DBA8', bg: '#FFFBEF', dot: '#B8860B' },
};

function SignalCard({ signal, projectId, onLeave }: { signal: AiSignal; projectId: string; onLeave: () => void }) {
  const qc = useQueryClient();
  const assist = useAssist();
  const board = useAiBoardState();
  const member = signal.memberId ? board.members.get(signal.memberId) : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const look = LOOK[signal.kind] ?? LOOK.needs_queue;
  const openTicket = () => signal.ticketId && assist?.onOpenTicket(signal.ticketId);
  const refresh = () => qc.invalidateQueries({ queryKey: boardAiKeys.signals(projectId) });

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    try {
      const text = await fn();
      if (text) setNote(text);
      await refresh();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const act = () => {
    switch (signal.kind) {
      case 'ai_failing':
        if (!signal.runId) return;
        return run(async () => {
          await aiApi.retry(signal.runId!);
          return 'Started again as a new run.';
        });
      case 'needs_queue':
        requestOpenNotifications('panel');
        return;
      case 'quota_near':
        if (board.openAiTab) board.openAiTab('accounts');
        else
          setNote('Accounts are on the Members page, under AI accounts: move an urgent run to another account there.');
        return;
    }
  };

  return (
    <div
      data-testid={`signal-${signal.kind}`}
      style={{
        flex: '1 1 290px',
        minWidth: 290,
        border: `1px solid ${look.border}`,
        borderRadius: 11,
        background: look.bg,
        padding: '12px 14px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden="true"
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: '#fff',
            border: `1px solid ${look.dot}`,
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: look.dot,
            fontWeight: 800,
            fontSize: 13,
          }}
        >
          !
        </span>
        <b style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{signal.title}</b>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{signal.detail}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" disabled={busy} onClick={() => void act()}>
          {signal.kind === 'quota_near' && board.openAiTab ? 'Open AI accounts' : signal.action}
        </button>
        {signal.runId && signal.kind === 'ai_failing' && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(signal.runId!)}>
            Open the last run
          </button>
        )}
        {signal.kind === 'ai_failing' && signal.memberId && member && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await aiApi.pauseTeam(signal.memberId!, { reason: 'Paused from an AI signal' });
                return `${member.name} is paused. Resume it from the AI members page.`;
              })
            }
          >
            Pause {member.name}
          </button>
        )}
        {signal.ticketId && !signal.runId && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={openTicket}>
            Open {signal.ticketId}
          </button>
        )}
        {(signal.kind === 'quota_near' || signal.kind === 'needs_queue') && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={onLeave}>
            Leave it
          </button>
        )}
      </div>
      {note && (
        <div className="ai-hint" data-testid="signal-note">
          {note}
        </div>
      )}
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

/** Noticing things (design/screens/ai-board-wave3.md, F): the AI signals as cards, each with its button. The
 * sixth card of the design, Stuck, is the board's own insight and stays where Board health already shows it. */
export function SignalCards({ projectId }: { projectId: string }) {
  const q = useSignals(projectId);
  // Leave it: the card stays away until it is worse than when it was left (its score went up)
  const [left, setLeft] = useState<Record<string, number>>({});
  if (q.isError)
    return (
      <div className="ai-notice ai-notice-error" role="alert" data-testid="signals-error" style={{ margin: 12 }}>
        Couldn&rsquo;t load the AI signals: {extractError(q.error)}.{' '}
        <button type="button" className="ai-link" onClick={() => void q.refetch()}>
          Try again
        </button>
      </div>
    );
  if (q.isLoading) return <div className="as-skel" style={{ height: 60, margin: 12 }} data-testid="signals-loading" />;
  const list = (q.data ?? []).filter((s) => !(s.key in left) || s.score > left[s.key]);
  if (!list.length) return <div data-testid="signal-cards" data-empty="true" />;
  return (
    <div
      data-testid="signal-cards"
      style={{ display: 'flex', gap: 11, flexWrap: 'wrap', padding: '12px 18px', borderBottom: '1px solid #EDF1EE' }}
    >
      {list.map((s) => (
        <SignalCard
          key={s.key}
          signal={s}
          projectId={projectId}
          onLeave={() => setLeft((m) => ({ ...m, [s.key]: s.score }))}
        />
      ))}
    </div>
  );
}
