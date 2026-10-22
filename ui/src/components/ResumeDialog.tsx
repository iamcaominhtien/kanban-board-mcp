import { ConflictNotice } from './ConflictNotice';
import React, { useState, useEffect, useRef } from 'react';
import type { Ticket, Member } from '../types/ticket';
import { DOCS_SCRIM, useEscape } from './docs/docsShared';

interface ResumeDialogProps {
  isOpen?: boolean;
  ticket: Ticket;
  members?: Member[];
  isSubmitting?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: { reason?: string; addComment?: boolean }) => void;
  onRetry?: () => void;
}

const STATUS_CONFIG: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't Do",
};

/**
 * Pixel-perfect ResumeDialog strictly matching design/source/TicketPending.dc.html (D3).
 * Width: 376px, tokens: #F1F8F3, #2E6F40, #F4F6F9, #B8C4D2, #34455A.
 */
export const ResumeDialog: React.FC<ResumeDialogProps> = ({
  isOpen = true,
  ticket,
  members = [],
  isSubmitting = false,
  error = null,
  onClose,
  onConfirm,
  onRetry,
}) => {
  useEscape(isSubmitting ? () => {} : onClose);

  const [reason, setReason] = useState('');
  const [addComment, setAddComment] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setAddComment(true);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    if (error && onRetry) {
      onRetry();
      return;
    }
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
      ? ticket.pendingTicketId || 'Ticket'
      : ticket.pendingParty ||
        (ticket.pendingMemberId && members.find((m) => m.id === ticket.pendingMemberId)?.name) ||
        ticket.pendingMemberId ||
        'Person / Party';

  const statusLabel = STATUS_CONFIG[ticket.status] || ticket.status;

  const charCount = reason.length;
  const counterColor = charCount >= 240 ? '#C4432A' : charCount >= 220 ? '#C77700' : '#9AA8A0';

  const pendingSinceStr = ticket.pendingSince
    ? new Date(ticket.pendingSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'Oct 19';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: DOCS_SCRIM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={isSubmitting ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Resume ${ticket.id}?`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 376,
          maxWidth: '100%',
          boxSizing: 'border-box',
          background: '#FFFFFF',
          borderRadius: 14,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.16)',
          overflow: 'hidden',
          fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
          color: '#1E2A22',
        }}
      >
        <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} style={{ margin: 0, padding: 0 }}>
          <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 11 }}>
            {/* Header: 32x32 #F1F8F3 circle + Title + Subtitle + Close */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: '#F1F8F3',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#2E6F40"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M7.5 4.8V19.2L19 12Z" />
                </svg>
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#1E2A22' }}>Resume {ticket.id}?</span>
                <span style={{ fontSize: 12.5, color: '#5B6B60', lineHeight: 1.35 }}>
                  Removes the Pending flag. It stays in {statusLabel}.
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                style={{
                  border: 'none',
                  background: 'none',
                  color: '#9AA8A0',
                  display: 'flex',
                  padding: 0,
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M6 6L18 18" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
            </div>

            {/* Pending info box */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '10px 12px',
                borderRadius: 8,
                background: '#F4F6F9',
                border: '1px solid #B8C4D2',
                fontSize: 12.5,
                color: '#34455A',
                lineHeight: 1.45,
              }}
            >
              <span>
                <b>Pending since {pendingSinceStr}</b> ({daysPending} {daysPending === 1 ? 'day' : 'days'}) by{' '}
                {ticket.pendingBy || 'An Nguyen'}
              </span>
              <span>
                Waiting on{' '}
                <b style={{ fontFamily: ticket.pendingReasonType === 'ticket' ? "'JetBrains Mono', monospace" : 'inherit' }}>
                  {targetDescription}
                </b>
                {ticket.pendingNote ? ` - "${ticket.pendingNote}"` : ''}
              </span>
            </div>

            {/* Reason for resuming (optional) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', flexGrow: 1 }}>
                  Reason for resuming <span style={{ fontWeight: 500, color: '#9AA8A0' }}>(optional)</span>
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: counterColor }}>
                  {charCount} / 240
                </span>
              </div>
              <input
                ref={inputRef}
                type="text"
                maxLength={240}
                disabled={isSubmitting}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Blocker is resolved, or work can continue"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  height: 40,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid #E3E8E5',
                  background: isSubmitting ? '#F6FAF7' : '#FFFFFF',
                  fontSize: 13,
                  color: '#1E2A22',
                  outline: 'none',
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              />
            </div>

            {/* Checkbox: Add a comment to the ticket */}
            <div
              onClick={() => {
                if (isSubmitting) return;
                setAddComment((c) => !c);
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 9,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  boxSizing: 'border-box',
                  flexShrink: 0,
                  marginTop: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: addComment ? '#2E6F40' : '#FFFFFF',
                  border: addComment ? '1.4px solid #2E6F40' : '1.4px solid #C7D2CB',
                }}
              >
                {addComment && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M5 12.5L10 17.5L19 7" />
                  </svg>
                )}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 13, color: '#1E2A22', fontWeight: 500, lineHeight: 1.4 }}>
                  Add a comment to the ticket
                </span>
                <span style={{ fontSize: 12, color: '#9AA8A0', lineHeight: 1.4 }}>
                  Posts the reason as a comment from you
                </span>
              </div>
            </div>

            {/* Error State Box */}
            {error && /no longer pending/i.test(error) && (
              <ConflictNotice who="Someone" message={`already resumed ${ticket.id} a moment ago. It is no longer pending.`} />
            )}
            {error && !/no longer pending/i.test(error) && (
              <div
                title={error}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: '#FBE7E4',
                  border: '1px solid #F1C4BC',
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#C4432A"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, marginTop: 2 }}
                >
                  <path d="M12 9V13" />
                  <path d="M12 17H12.01" />
                  <path d="M10.29 3.86L1.82 18A2 2 0 0 0 3.54 21H20.46A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z" />
                </svg>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#C4432A' }}>
                    Could not resume {ticket.id}
                  </span>
                  <span style={{ fontSize: 12, color: '#8A3220', lineHeight: 1.4 }}>
                    The server returned an error. Nothing was changed - the ticket is still pending.
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Footer (FBFCFB) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
              padding: '12px 20px',
              borderTop: '1px solid #EEF3EF',
              background: '#FBFCFB',
            }}
          >
            <button
              type="button"
              disabled={isSubmitting}
              onClick={onClose}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '7px 13px',
                borderRadius: 8,
                border: '1px solid #E3E8E5',
                background: '#FFFFFF',
                color: isSubmitting ? '#9AA8A0' : '#1E2A22',
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 8,
                background: '#2E6F40',
                color: '#FFFFFF',
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                border: 'none',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                opacity: isSubmitting ? 0.75 : 1,
                fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <path d="M7.5 4.8V19.2L19 12Z" />
              </svg>
              {isSubmitting ? 'Resuming...' : error ? 'Retry' : 'Resume'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
