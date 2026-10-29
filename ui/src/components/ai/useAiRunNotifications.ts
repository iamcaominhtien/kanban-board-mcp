import { useEffect, useRef } from 'react';
import type { AiRun } from '../../types/ai';
import { useToast } from '../Toast';

interface Seen {
  state: string;
  reminders: number;
  blocked: string | null;
}

/**
 * Toasts for run changes on the board: the AI needs an answer (Answer / Open ticket), a reminder for a question
 * still open, a run finished, failed, was archived away, or tried to move a ticket past its permission (AI work on
 * tickets, E2, F3, H6). The first load only records the states, so opening the board never replays old news.
 */
export function useAiRunNotifications(
  runs: AiRun[] | undefined,
  openTicket: (ticketId: string) => void,
  openAiPage?: (memberId?: string) => void,
) {
  const toast = useToast();
  const seen = useRef<Map<string, Seen> | null>(null);
  useEffect(() => {
    if (!runs) return;
    const prev = seen.current;
    const next = new Map<string, Seen>(
      runs.map((r) => [
        r.id,
        { state: r.state, reminders: r.question?.reminders?.length ?? 0, blocked: r.blockedMove },
      ]),
    );
    seen.current = next;
    if (!prev) return;
    for (const r of runs) {
      const before = prev.get(r.id);
      const open = { label: 'Open ticket', onClick: () => openTicket(r.ticketId) };
      if (before && before.blocked !== r.blockedMove && r.blockedMove) {
        const target = r.blockedMove === 'done' ? 'Done' : r.blockedMove;
        toast.showToast({
          variant: 'warning',
          title: `${r.memberName} can’t move ${r.ticketId} to ${target}`,
          message: 'Its permission stops before that. The ticket stays where it is.',
          duration: 12000,
          action: { label: 'Open comment', onClick: () => openTicket(r.ticketId) },
          secondaryAction: { label: 'Change permission', onClick: () => openAiPage?.(r.memberId) },
        });
      }
      if (before && r.state === 'needs_input' && r.question && (r.question.reminders?.length ?? 0) > before.reminders) {
        toast.showToast({
          variant: 'warning',
          title: `${r.memberName} is still waiting for ${r.question.to}`,
          message: `${r.ticketId} · ${r.question.text}`,
          duration: 12000,
          action: { label: 'Answer', onClick: () => openTicket(r.ticketId) },
        });
      }
      if (before?.state === r.state) continue;
      if (r.state === 'needs_input')
        toast.showToast({
          variant: 'warning',
          title: `${r.memberName} needs an answer`,
          message: `${r.ticketId} · ${r.question?.text ?? ''}`,
          duration: 12000,
          action: { label: 'Answer', onClick: () => openTicket(r.ticketId) },
          secondaryAction: open,
        });
      else if (r.state === 'finished' && r.mode === 'work')
        toast.success(`${r.memberName} finished ${r.ticketId}`, 'AI summary ready for review.', 8000, open);
      else if (r.state === 'cancelled' && r.stopCode === 'archive')
        toast.showToast({
          variant: 'warning',
          title: `${r.ticketId} was archived${r.endedBy ? ` by ${r.endedBy}` : ''}`,
          message: `Run #${r.number} was cancelled at step ${r.stepCount ?? r.steps?.length ?? 0}. Files stay on the branch.`,
          duration: 10000,
          action: { label: 'View run log', onClick: () => openTicket(r.ticketId) },
        });
      else if (r.state === 'failed' || r.state === 'timed_out')
        toast.error(
          `Run #${r.number} on ${r.ticketId} ${r.state === 'failed' ? 'failed' : 'timed out'}`,
          r.endedReason ?? '',
          10000,
          open,
        );
    }
  }, [runs, toast, openTicket, openAiPage]);
}
