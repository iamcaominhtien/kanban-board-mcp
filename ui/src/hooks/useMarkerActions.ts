import { useToast } from '../components/Toast';
import { useReopenTicket, useResumeTicket, useSetPending, useUndoReopen } from '../api/tickets';
import type { Member, Ticket } from '../types';

export const STATUS_NAMES: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't Do",
};

type PendingPayload = {
  reasonType: 'ticket' | 'person' | 'party';
  pendingTicketId?: string;
  pendingMemberId?: string;
  pendingParty?: string;
  note?: string;
  alsoAddBlockedBy?: boolean;
};

/** Who or what a ticket is pending on, as shown in toasts. */
export function pendingTarget(
  t: Pick<Ticket, 'pendingReasonType' | 'pendingTicketId' | 'pendingMemberId' | 'pendingParty'>,
  members: Member[],
): string {
  if (t.pendingReasonType === 'ticket') return t.pendingTicketId ?? 'a ticket';
  return t.pendingParty || members.find((m) => m.id === t.pendingMemberId)?.name || 'a person';
}

/**
 * Reopen / Pending / Resume with the result toasts of the design (TicketReopen C1, TicketPending D4).
 * Each toast carries an Undo (8 s); errors are thrown so the dialog can show its own error state.
 */
export function useMarkerActions(members: Member[]) {
  const toast = useToast();
  const reopenM = useReopenTicket();
  const undoReopenM = useUndoReopen();
  const pendingM = useSetPending();
  const resumeM = useResumeTicket();

  async function reopen(
    ticket: Ticket,
    payload: { reason?: string; resetAc?: boolean; resetTests?: boolean; unassign?: boolean; reopenParent?: boolean },
  ) {
    await reopenM.mutateAsync({ ticketId: ticket.id, data: payload });
    toast.success(`${ticket.id} reopened`, 'Moved to To Do, marked Reopened', 8000, {
      label: 'Undo',
      onClick: () => {
        undoReopenM.mutate(ticket.id, {
          onError: () => toast.error("Couldn't undo", `${ticket.id} could not be moved back`),
        });
      },
    });
  }

  async function setPending(ticket: Ticket, payload: PendingPayload) {
    await pendingM.mutateAsync({
      ticketId: ticket.id,
      data: {
        reasonType: payload.reasonType,
        ticketId: payload.pendingTicketId,
        memberId: payload.pendingMemberId,
        party: payload.pendingParty,
        note: payload.note,
        addBlockedBy: payload.alsoAddBlockedBy,
      },
    });
    toast.success(`${ticket.id} marked pending`, `Still in ${STATUS_NAMES[ticket.status] ?? ticket.status}`, 8000, {
      label: 'Undo',
      onClick: () => {
        resumeM.mutate({ ticketId: ticket.id, data: {} });
      },
    });
  }

  async function resume(ticket: Ticket, payload: { reason?: string; addComment?: boolean }) {
    await resumeM.mutateAsync({ ticketId: ticket.id, data: payload });
    toast.success(`${ticket.id} resumed`, `Still in ${STATUS_NAMES[ticket.status] ?? ticket.status}`, 8000, {
      label: 'Undo',
      onClick: () => {
        if (!ticket.pendingReasonType) return;
        pendingM.mutate({
          ticketId: ticket.id,
          data: {
            reasonType: ticket.pendingReasonType,
            ticketId: ticket.pendingTicketId ?? undefined,
            memberId: ticket.pendingMemberId ?? undefined,
            party: ticket.pendingParty ?? undefined,
            note: ticket.pendingNote ?? undefined,
          },
        });
      },
    });
  }

  void members;
  return { reopen, setPending, resume };
}
