import React, { useState, useEffect, useRef } from 'react';
import type { Ticket } from '../types/ticket';
import { ModalShell } from './docs/docsShared';
import { Icon } from './docs/Icon';

interface ResumeDialogProps {
  isOpen: boolean;
  ticket: Ticket;
  isSubmitting?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: { reason?: string; addComment?: boolean }) => void;
}

export const ResumeDialog: React.FC<ResumeDialogProps> = ({
  isOpen,
  ticket,
  isSubmitting = false,
  error = null,
  onClose,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const [addComment, setAddComment] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setAddComment(true);
      setTimeout(() => textareaRef.current?.focus(), 80);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    onConfirm({
      reason: reason.trim() || undefined,
      addComment: addComment && !!reason.trim(),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleSubmit(e);
    }
  }

  const daysPending = ticket.pendingSince
    ? Math.max(0, Math.floor((Date.now() - new Date(ticket.pendingSince).getTime()) / (1000 * 60 * 60 * 24)))
    : 0;

  const targetDescription =
    ticket.pendingReasonType === 'ticket'
      ? ticket.pendingTicketId
        ? `#${ticket.pendingTicketId}`
        : 'Ticket'
      : ticket.pendingParty || ticket.pendingMemberId || 'Person / Party';

  return (
    <ModalShell
      width={480}
      onClose={isSubmitting ? () => {} : onClose}
      ariaLabel={`Resume ticket ${ticket.id}`}
      title={`Resume ${ticket.id}?`}
      subtitle={
        <>
          Removes the Pending flag. It stays in{' '}
          <strong style={{ textTransform: 'capitalize' }}>{ticket.status.replace('_', ' ')}</strong>.
        </>
      }
    >
      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Pending Summary Box */}
        <div
          style={{
            padding: '12px 14px',
            background: '#F4F6F9',
            border: '1px solid #B8C4D2',
            borderRadius: 8,
            fontSize: 12.5,
            color: '#34455A',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            Pending since {ticket.pendingSince ? new Date(ticket.pendingSince).toLocaleDateString() : 'recent'}{' '}
            <span style={{ color: '#5B6F86', fontWeight: 400 }}>({daysPending}d)</span>
            {ticket.pendingBy ? ` by ${ticket.pendingBy}` : ''}
          </div>
          <div style={{ color: '#5B6F86', fontSize: 12 }}>
            Waiting on <strong style={{ color: '#34455A' }}>{targetDescription}</strong>
            {ticket.pendingNote ? ` — "${ticket.pendingNote}"` : ''}
          </div>
        </div>

        {/* Reason Field */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>
              Reason for resuming <span style={{ fontWeight: 400, color: '#64748B' }}>(optional)</span>
            </label>
            <span style={{ fontSize: 11.5, color: reason.length > 220 ? '#DC2626' : '#64748B' }}>
              {reason.length} / 240
            </span>
          </div>
          <textarea
            ref={textareaRef}
            value={reason}
            maxLength={240}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Blocker ticket resolved, API keys arrived by email..."
            rows={2}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #CBD5E1',
              fontSize: 13,
              fontFamily: 'inherit',
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Checkbox: Add comment */}
        {reason.trim().length > 0 && (
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 12.5,
              color: '#34455A',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={addComment}
              onChange={(e) => setAddComment(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <div>
              <strong>Add a comment to the ticket</strong>
              <div style={{ fontSize: 11.5, color: '#64748B' }}>
                Posts the reason as a comment from you
              </div>
            </div>
          </label>
        )}

        {/* Error message */}
        {error && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              background: '#FEF2F2',
              border: '1px solid #FCA5A5',
              color: '#991B1B',
              fontSize: 12.5,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <Icon name="i14" size={16} />
            <div style={{ flex: 1 }}>{error}</div>
          </div>
        )}

        {/* Footer Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            style={{
              padding: '7px 14px',
              borderRadius: 6,
              border: '1px solid #CBD5E1',
              background: '#fff',
              color: '#475569',
              fontSize: 13,
              fontWeight: 500,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: 'none',
              background: isSubmitting ? '#94A3B8' : '#5B6F86',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isSubmitting ? 'Resuming...' : 'Resume'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};
