import { useState } from 'react';
import { aiApi } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useNotificationList } from '../../api/notifications';
import type { AiRun, AiTeam } from '../../types/ai';
import type { NotificationRow } from '../../types/notifications';
import { QuestionCard } from '../ai/QuestionCard';
import { useToast } from '../Toast';
import { useNotificationAction } from '../notifications/NotificationsHost';
import { Icon, type IconName } from '../notifications/notificationUi';
import { TicketChip } from './teamUi';
import { useQueryClient } from '@tanstack/react-query';

/** What a Needs you item offers: the first button is the one action, the others are ways to look. */
interface NeedAction {
  label: string;
  run: () => Promise<unknown> | void;
}

interface NeedItem {
  key: string;
  icon: IconName;
  red: boolean;
  title: string;
  body: string;
  ticketId?: string | null;
  actions: NeedAction[];
}

/** The notification kinds that stand for a person's turn on a run or an account (the rest are not for this strip). */
const RUN_KINDS = new Set(['run_failed', 'run_stopped_memory', 'board_fault']);

function fromRow(row: NotificationRow, act: (r: NotificationRow, id: string) => Promise<unknown>): NeedItem | null {
  const has = (id: string) => row.actions.some((a) => a.id === id);
  const go = (id: string) => () => act(row, id);
  if (RUN_KINDS.has(row.kind)) {
    return {
      key: row.id,
      icon: 'triangle',
      red: true,
      title: row.title,
      body: row.body,
      ticketId: row.ticketId,
      actions: [
        ...(has('retry') ? [{ label: 'Try again', run: go('retry') }] : []),
        { label: 'Open run', run: go('open_run_log') },
      ],
    };
  }
  if (row.kind === 'run_stuck') {
    return {
      key: row.id,
      icon: 'clock',
      red: false,
      title: row.title,
      body: row.body,
      ticketId: row.ticketId,
      actions: [
        { label: 'Open run', run: go('open_run_log') },
        { label: 'Cancel run', run: go('cancel') },
      ],
    };
  }
  if (row.kind === 'account_signed_out') {
    return {
      key: row.id,
      icon: 'lock',
      red: true,
      title: row.title,
      body: row.body,
      actions: [{ label: 'Sign in', run: go('sign_in') }],
    };
  }
  if (row.kind === 'offline') {
    return {
      key: row.id,
      icon: 'plug',
      red: true,
      title: row.title,
      body: row.body,
      actions: [{ label: 'Fix connection', run: go('open_ai') }],
    };
  }
  return null;
}

/** A team that is held by a limit: its queued runs wait for a reason that is not "a slot is busy". */
function heldBy(runs: AiRun[], teamId: string): { reason: string; runs: AiRun[] } | null {
  const held = runs.filter(
    (r) =>
      r.memberId === teamId &&
      r.state === 'queued' &&
      r.waitingReason &&
      /budget|cap\b|limit|quota|window|per day|used up/i.test(r.waitingReason),
  );
  return held.length ? { reason: held[0].waitingReason as string, runs: held } : null;
}

/**
 * AI Team › Now › Needs you: everything that waits for a person, each with its one action. Questions come from the
 * runs (they carry the answer box); failed, timed-out and stuck runs, and signed-out accounts, from the board's
 * notifications (the same rows, the same actions); a paused team or a limit from the teams themselves.
 */
export function NeedsYou({
  projectId,
  teams,
  active,
  asking,
  onOpenTicket,
  onOpenMember,
}: {
  projectId: string;
  teams: AiTeam[];
  active: AiRun[];
  asking: AiRun[];
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const onAction = useNotificationAction();
  const list = useNotificationList({ view: 'panel', tab: 'needs' });
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (list.data?.items ?? []).filter(
    (r) => !r.done && !r.gone && (r.projectId === projectId || r.projectId == null),
  );
  const act = async (row: NotificationRow, id: string) => {
    await onAction?.(row, id);
  };

  const items: NeedItem[] = [];
  for (const row of rows) {
    const it = onAction ? fromRow(row, act) : null;
    if (it) items.push(it);
  }
  const signedOut = rows.some((r) => r.kind === 'account_signed_out');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ai'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const resume = (label: string, call: () => Promise<unknown>): NeedAction => ({
    label: 'Resume',
    run: async () => {
      try {
        await call();
        toast.info(`${label} resumed`);
        refresh();
      } catch (err) {
        toast.error('Could not resume', extractError(err));
      }
    },
  });
  let pausedAllShown = false;
  for (const t of teams) {
    const code = t.status.code;
    if (code === 'paused_all' && !pausedAllShown) {
      pausedAllShown = true;
      items.push({
        key: 'paused-all',
        icon: 'clock',
        red: false,
        title: 'AI is paused for the whole project',
        body: t.status.detail ?? 'Nothing new starts until you resume.',
        actions: [resume('AI', () => aiApi.resumeAll(projectId))],
      });
    } else if (code === 'paused') {
      items.push({
        key: `paused-${t.id}`,
        icon: 'clock',
        red: false,
        title: `${t.name} is paused`,
        body: t.status.detail ?? 'New work waits in the queue.',
        actions: [resume(t.name, () => aiApi.resumeTeam(t.id)), { label: 'Open team', run: () => onOpenMember(t.id) }],
      });
    } else if ((code === 'not_logged_in' || code === 'runner_missing') && !signedOut) {
      items.push({
        key: `health-${t.id}`,
        icon: code === 'not_logged_in' ? 'lock' : 'plug',
        red: true,
        title: `${t.name}: ${t.status.label.toLowerCase()}`,
        body: t.status.detail ?? 'The team cannot start a run.',
        actions: [{ label: code === 'not_logged_in' ? 'Sign in' : 'Fix connection', run: () => onOpenMember(t.id) }],
      });
    }
    const held = heldBy(active, t.id);
    if (held && code !== 'paused' && code !== 'paused_all') {
      items.push({
        key: `held-${t.id}`,
        icon: 'clock',
        red: false,
        title: `${t.name} is held by a limit`,
        body: `${held.reason.replace(/\.$/, '')}. ${
          held.runs.length === 1 ? '1 run waits and starts' : `${held.runs.length} runs wait and start`
        } by itself when it clears.`,
        ticketId: held.runs[0].ticketId,
        actions: [{ label: 'Change the limits', run: () => onOpenMember(t.id) }],
      });
    }
  }

  if (!items.length && !asking.length) {
    return (
      <section data-testid="at-needs-you-empty" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 className="at-h">Needs you</h2>
        <div className="at-plain">Nothing waits for you.</div>
      </section>
    );
  }
  return (
    <section data-testid="at-needs-you" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 className="at-h">
        Needs you <span>· {items.length + asking.length}</span>
      </h2>
      {asking.map((r) => (
        <QuestionCard key={r.id} run={r} variant="strip" />
      ))}
      {items.length > 0 && (
        <div className="at-needs">
          {items.map((it) => (
            <div key={it.key} className="at-need" data-testid={`need-${it.key}`}>
              <div className="at-need-head">
                <span className={`at-need-ico${it.red ? ' red' : ''}`}>
                  <Icon name={it.icon} size={13} color={it.red ? '#C4432A' : '#B8860B'} />
                </span>
                <b>{it.title}</b>
                {it.ticketId && <TicketChip id={it.ticketId} onOpen={onOpenTicket} />}
              </div>
              {it.body && <div className="at-need-body">{it.body}</div>}
              <div className="at-actions">
                {it.actions.map((a, i) => (
                  <button
                    key={a.label}
                    type="button"
                    className={`st-btn st-btn-sm${i === 0 ? ' st-btn-primary' : ''}`}
                    disabled={busy === `${it.key}:${a.label}`}
                    onClick={() => {
                      setBusy(`${it.key}:${a.label}`);
                      void Promise.resolve(a.run()).finally(() => setBusy(null));
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
