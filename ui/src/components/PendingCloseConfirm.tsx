import React from 'react';
import { ModalShell, Spacer } from './docs/docsShared';
import { pendingTarget, STATUS_NAMES } from '../hooks/useMarkerActions';
import type { Member, Ticket } from '../types';

interface PendingCloseConfirmProps {
  ticket: Ticket;
  /** Done or Won't Do */
  targetStatus: 'done' | 'wont_do';
  allTickets: Ticket[];
  members: Member[];
  onCancel: () => void;
  onResumeFirst: () => void;
  onProceed: () => void;
}

/** E2 · Moving a pending ticket to Done / Won't Do: confirm, since it also clears Pending (TicketPending E2). */
export const PendingCloseConfirm: React.FC<PendingCloseConfirmProps> = ({
  ticket,
  targetStatus,
  allTickets,
  members,
  onCancel,
  onResumeFirst,
  onProceed,
}) => {
  const blocker =
    ticket.pendingReasonType === 'ticket' ? allTickets.find((t) => t.id === ticket.pendingTicketId) : undefined;
  const pendingChildren = allTickets.filter((t) => t.parentId === ticket.id && t.pending);
  const verb = targetStatus === 'done' ? 'Done' : "Won't Do";
  const mono = { fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 } as const;

  return (
    <ModalShell
      width={376}
      ariaLabel={`${ticket.id} is pending`}
      icon="i14"
      title={<>{ticket.id} is pending</>}
      subtitle={`${ticket.title}. Move it to ${verb}?`}
      onClose={onCancel}
      testId="pending-close-confirm"
      bodyStyle={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="st-btn" onClick={onResumeFirst}>
            Resume first
          </button>
          <button type="button" className="st-btn st-btn-primary" onClick={onProceed}>
            {targetStatus === 'done' ? 'Mark done anyway' : "Mark Won't Do anyway"}
          </button>
        </>
      }
    >
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 8,
          background: '#F4F6F9',
          border: '1px solid #B8C4D2',
          fontSize: 12.5,
          color: '#34455A',
          lineHeight: 1.5,
        }}
      >
        It is waiting on <span style={ticket.pendingReasonType === 'ticket' ? mono : { fontWeight: 700 }}>{pendingTarget(ticket, members)}</span>
        {blocker ? <> ({STATUS_NAMES[blocker.status] ?? blocker.status})</> : null}. Marking it {targetStatus === 'done' ? 'done' : "Won't Do"} also clears Pending.
      </div>
      {pendingChildren.length > 0 && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: '#F4F6F9',
            border: '1px solid #B8C4D2',
            fontSize: 12.5,
            color: '#34455A',
            lineHeight: 1.5,
          }}
        >
          {pendingChildren.length} pending sub-{pendingChildren.length === 1 ? 'task' : 'tasks'}:{' '}
          {pendingChildren.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? ', ' : ''}
              <span style={mono}>{c.id}</span>
            </span>
          ))}
          . Their flags are cleared too.
        </div>
      )}
    </ModalShell>
  );
};
