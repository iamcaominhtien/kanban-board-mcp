import React, { useEffect, useState } from 'react';
import { ModalShell, Spacer } from './docs/docsShared';
import { Icon } from './docs/Icon';
import './docs/docs.css';

interface WontDoDialogProps {
  ticketId: string;
  ticketTitle: string;
  isOpen: boolean;
  isSubmitting?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * Dialog to provide a required reason when marking a ticket as Won't Do.
 * Uses ModalShell for consistent design with Docs and system dialogs.
 * @param props.ticketId - Ticket key (e.g. SBFF-16).
 * @param props.ticketTitle - Ticket title for context.
 * @param props.isOpen - Whether the dialog is displayed.
 * @param props.isSubmitting - Submission in progress.
 * @param props.onClose - Called to cancel and dismiss.
 * @param props.onConfirm - Called with the non-empty reason string.
 */
export function WontDoDialog({
  ticketId,
  ticketTitle,
  isOpen,
  isSubmitting = false,
  onClose,
  onConfirm,
}: WontDoDialogProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReason('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (reason.trim() && !isSubmitting) {
          e.preventDefault();
          void onConfirm(reason.trim());
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, reason, isSubmitting, onConfirm]);

  if (!isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!reason.trim() || isSubmitting) return;
    void onConfirm(reason.trim());
  };

  return (
    <ModalShell
      width={480}
      ariaLabel="Mark ticket as Won't Do"
      icon="i14"
      iconTone="red"
      title={<>Mark {ticketId} as Won’t Do?</>}
      subtitle="This ticket will be moved to the Recycle Bin and hidden from the board."
      onClose={onClose}
      testId="wont-do-dialog"
      bodyStyle={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-danger"
            data-testid="confirm-wont-do"
            disabled={!reason.trim() || isSubmitting}
            onClick={() => handleSubmit()}
          >
            <Icon name="i14" size={14} />
            {isSubmitting ? 'Marking…' : 'Mark as Won’t Do'}
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="wont-do-reason-input" className="st-field-label">
            Reason <span style={{ color: '#C4432A' }}>*</span>
          </label>
          <span style={{ fontSize: 11, color: '#9AA8A0' }}>Required</span>
        </div>
        <textarea
          id="wont-do-reason-input"
          data-testid="wont-do-reason-input"
          autoFocus
          className="st-input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why won't this ticket be worked on? e.g. Duplicate of #..., Out of scope, No longer needed..."
          style={{ resize: 'vertical', minHeight: 74, lineHeight: 1.5 }}
          disabled={isSubmitting}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#9AA8A0' }}>
          <span>Press <b>⌘ + Enter</b> to confirm</span>
          <span>{ticketTitle}</span>
        </div>
      </form>
    </ModalShell>
  );
}
