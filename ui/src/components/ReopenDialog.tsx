import React, { useState, useEffect, useRef } from 'react';
import type { Ticket, Member } from '../types/ticket';
import { DOCS_SCRIM, useEscape } from './docs/docsShared';

interface ReopenDialogProps {
  isOpen?: boolean;
  ticket: Ticket;
  allTickets?: Ticket[];
  parentTicket?: Ticket | null;
  subtaskTickets?: Ticket[];
  members?: Member[];
  isSubmitting?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: {
    reason?: string;
    resetAc?: boolean;
    resetTests?: boolean;
    unassign?: boolean;
    reopenParent?: boolean;
  }) => void;
  onRetry?: () => void;
}

/**
 * Pixel-perfect ReopenDialog strictly matching design/source/TicketReopen.dc.html (B1-B7).
 * Width: 376px, tokens: #FFF1D6, #F0C77A, #8A4B00, #C77700, #2E6F40, #F6FAF7, #EEF3EF.
 */
export const ReopenDialog: React.FC<ReopenDialogProps> = ({
  isOpen = true,
  ticket,
  allTickets,
  parentTicket,
  subtaskTickets = [],
  members = [],
  isSubmitting = false,
  error = null,
  onClose,
  onConfirm,
  onRetry,
}) => {
  useEscape(isSubmitting ? () => {} : onClose);

  const effectiveParent = parentTicket ?? (allTickets ? allTickets.find((t) => t.id === ticket.parentId) : null);
  const effectiveSubtasks =
    subtaskTickets.length > 0
      ? subtaskTickets
      : allTickets
      ? allTickets.filter((t) => t.parentId === ticket.id)
      : [];

  const [reason, setReason] = useState('');
  const [resetAc, setResetAc] = useState(false);
  const [resetTests, setResetTests] = useState(false);
  const [unassign, setUnassign] = useState(false);
  const [reopenParent, setReopenParent] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const checkedAcs = ticket.acceptanceCriteria?.filter((ac) => ac.done)?.length || 0;
  const totalAcs = ticket.acceptanceCriteria?.length || 0;

  const passedTests = ticket.testCases?.filter((tc) => tc.status === 'pass')?.length || 0;
  const failedTests = ticket.testCases?.filter((tc) => tc.status === 'fail')?.length || 0;
  const totalTests = ticket.testCases?.length || 0;

  const assigneeMember = members.find((m) => m.id === ticket.assignee);
  const assigneeName = assigneeMember?.name || ticket.assignee || 'Assignee';

  const isParentDone =
    effectiveParent && (effectiveParent.status === 'done' || effectiveParent.status === 'wont_do');
  const allSubtasksDone =
    effectiveSubtasks.length > 0 &&
    effectiveSubtasks.every((st) => st.status === 'done' || st.status === 'wont_do');

  const nextReopenCount = (ticket.reopenCount || 0) + 1;
  const isWontDo = ticket.status === 'wont_do';
  const fromStatusLabel = isWontDo ? "Won't Do" : 'Done';
  const fromDotColor = isWontDo ? '#C4432A' : '#2E6F40';

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setResetAc(false);
      setResetTests(false);
      setUnassign(false);
      setReopenParent(true);
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
      resetAc,
      resetTests,
      unassign,
      reopenParent: isParentDone ? reopenParent : false,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleSubmit(e);
    }
  }

  // Counter styling: turns amber at 220, red at 240
  const charCount = reason.length;
  const counterColor = charCount >= 240 ? '#C4432A' : charCount >= 220 ? '#C77700' : '#9AA8A0';

  const completedDateStr = ticket.completedAt
    ? new Date(ticket.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : ticket.updatedAt
    ? new Date(ticket.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'Oct 17';

  const lastReopenedDateStr = ticket.lastReopenedAt
    ? new Date(ticket.lastReopenedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'Oct 14';

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
        aria-label={`Reopen ${ticket.id}?`}
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
          <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Header: Icon + Title + Subtitle + Close */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: '#FFF1D6',
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
                  stroke="#C77700"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#1E2A22' }}>Reopen {ticket.id}?</span>
                <span style={{ fontSize: 12.5, color: '#5B6B60', lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ticket.title}
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

            {/* Transition summary box (F6FAF7) */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '10px 12px',
                borderRadius: 8,
                background: '#F6FAF7',
                border: '1px solid #E3E8E5',
              }}
            >
              {/* Pills row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #E3E8E5',
                    background: '#FFFFFF',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: fromDotColor,
                      flexShrink: 0,
                      display: 'inline-block',
                    }}
                  />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', whiteSpace: 'nowrap' }}>
                    {fromStatusLabel}
                  </span>
                </span>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#9AA8A0"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M5 12H19" />
                  <path d="M13 6L19 12L13 18" />
                </svg>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #E3E8E5',
                    background: '#FFFFFF',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: '#9AA8A0',
                      flexShrink: 0,
                      display: 'inline-block',
                    }}
                  />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', whiteSpace: 'nowrap' }}>
                    To Do
                  </span>
                </span>
              </div>

              {/* B5 Won't Do variant header */}
              {isWontDo && (
                <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', marginTop: 2 }}>
                  Move back into the backlog flow
                </div>
              )}

              {/* Check items */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.45, color: '#3A4A3E' }}>
                <span style={{ marginTop: 2 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2E6F40" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M5 12.5L10 17.5L19 7" />
                  </svg>
                </span>
                <span>
                  {isWontDo ? 'Goes back into the board at ' : 'Moves to '}
                  <b>To Do</b>; keeps assignee and tags
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.45, color: '#3A4A3E' }}>
                <span style={{ marginTop: 2 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2E6F40" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M5 12.5L10 17.5L19 7" />
                  </svg>
                </span>
                <span>
                  {isWontDo
                    ? `The Won't Do decision (${completedDateStr}) is cleared`
                    : `Completion date (${completedDateStr}) is cleared`}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.45, color: '#3A4A3E' }}>
                <span style={{ marginTop: 2 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2E6F40" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M5 12.5L10 17.5L19 7" />
                  </svg>
                </span>
                <span>
                  Marked <b>Reopened</b>, reopen #{nextReopenCount}
                  {ticket.reopenCount ? <span style={{ color: '#9AA8A0' }}> (last {lastReopenedDateStr})</span> : null}
                </span>
              </div>
            </div>

            {/* B6 Sub-ticket whose parent is Done */}
            {isParentDone && parentTicket && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 9,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: '#FFFAF0',
                  border: '1px solid #F0C77A',
                }}
              >
                <div
                  onClick={() => !isSubmitting && setReopenParent((p) => !p)}
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
                    background: reopenParent ? '#2E6F40' : '#FFFFFF',
                    border: reopenParent ? '1.4px solid #2E6F40' : '1.4px solid #C7D2CB',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {reopenParent && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M5 12.5L10 17.5L19 7" />
                    </svg>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 13, color: '#1E2A22', fontWeight: 600, lineHeight: 1.4 }}>
                    Also reopen parent{' '}
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{parentTicket.id}</span>
                  </span>
                  <span style={{ fontSize: 12, color: '#8A4B00', lineHeight: 1.4 }}>
                    A Done parent cannot keep an open sub-task, so it moves to To Do too.
                  </span>
                </div>
              </div>
            )}

            {/* B7 Parent whose sub-tasks are all Done */}
            {allSubtasksDone && subtaskTickets.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: '#F6FAF7',
                  border: '1px solid #E3E8E5',
                  fontSize: 12,
                  color: '#5B6B60',
                  lineHeight: 1.45,
                }}
              >
                <span>
                  Its {subtaskTickets.length} sub-tasks ({subtaskTickets.map((s) => s.id).join(', ')}){' '}
                  <b>stay Done</b>; reopen them one by one if needed.
                </span>
              </div>
            )}

            {/* Reason (optional) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', flexGrow: 1 }}>
                  Reason <span style={{ fontWeight: 500, color: '#9AA8A0' }}>(optional)</span>
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
                placeholder="Why is this being reopened?"
                style={{
                  boxSizing: 'border-box',
                  height: 42,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid #E3E8E5',
                  background: isSubmitting ? '#F6FAF7' : '#FFFFFF',
                  fontSize: 13,
                  color: '#1E2A22',
                  outline: 'none',
                  width: '100%',
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              />
            </div>

            {/* Side-effects Checkboxes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {/* Uncheck ACs */}
              <div
                onClick={() => {
                  if (isSubmitting || totalAcs === 0 || checkedAcs === 0) return;
                  setResetAc((v) => !v);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 9,
                  cursor: isSubmitting || totalAcs === 0 || checkedAcs === 0 ? 'default' : 'pointer',
                  opacity: totalAcs === 0 || checkedAcs === 0 ? 0.55 : 1,
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
                    background: resetAc ? '#2E6F40' : '#FFFFFF',
                    border: resetAc ? '1.4px solid #2E6F40' : '1.4px solid #C7D2CB',
                  }}
                >
                  {resetAc && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M5 12.5L10 17.5L19 7" />
                    </svg>
                  )}
                </span>
                <span style={{ fontSize: 13, color: '#1E2A22', fontWeight: 500, lineHeight: 1.4 }}>
                  Uncheck acceptance criteria{' '}
                  <span style={{ fontSize: 12, fontWeight: 400, color: '#9AA8A0' }}>
                    {checkedAcs > 0 ? `(${checkedAcs} of ${totalAcs} checked)` : '(none checked)'}
                  </span>
                </span>
              </div>

              {/* Reset Test Results */}
              <div
                onClick={() => {
                  if (isSubmitting || totalTests === 0) return;
                  setResetTests((v) => !v);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 9,
                  cursor: isSubmitting || totalTests === 0 ? 'default' : 'pointer',
                  opacity: totalTests === 0 ? 0.55 : 1,
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
                    background: resetTests ? '#2E6F40' : '#FFFFFF',
                    border: resetTests ? '1.4px solid #2E6F40' : '1.4px solid #C7D2CB',
                  }}
                >
                  {resetTests && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M5 12.5L10 17.5L19 7" />
                    </svg>
                  )}
                </span>
                <span style={{ fontSize: 13, color: '#1E2A22', fontWeight: 500, lineHeight: 1.4 }}>
                  Reset test results to pending{' '}
                  <span style={{ fontSize: 12, fontWeight: 400, color: '#9AA8A0' }}>
                    {totalTests > 0 ? `(${passedTests} pass, ${failedTests} fail)` : '(none recorded)'}
                  </span>
                </span>
              </div>
            </div>

            {/* Assignee Segmented Control */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', flexGrow: 1 }}>Assignee</span>
              <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 8, background: '#EEF3EF' }}>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setUnassign(false)}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    fontSize: 12.5,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    background: !unassign ? '#FFFFFF' : 'transparent',
                    color: !unassign ? '#1E2A22' : '#5B6B60',
                    boxShadow: !unassign ? '0 1px 2px rgba(30,42,34,0.10)' : 'none',
                    border: 'none',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                  }}
                >
                  Keep {assigneeName}
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setUnassign(true)}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    fontSize: 12.5,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    background: unassign ? '#FFFFFF' : 'transparent',
                    color: unassign ? '#1E2A22' : '#5B6B60',
                    boxShadow: unassign ? '0 1px 2px rgba(30,42,34,0.10)' : 'none',
                    border: 'none',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                  }}
                >
                  Unassign
                </button>
              </div>
            </div>

            {/* B4 Error State Box */}
            {error && (
              <div
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
                    Could not reopen {ticket.id}
                  </span>
                  <span style={{ fontSize: 12, color: '#8A3220', lineHeight: 1.4 }}>
                    {error || `The server returned an error. Nothing was changed - the ticket is still ${fromStatusLabel}.`}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Footer (FBFCFB) */}
          <div
            style={{
              display: 'flex',
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
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {isSubmitting ? 'Reopening...' : error ? 'Retry' : 'Reopen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
