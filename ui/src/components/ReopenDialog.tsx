import React, { useState, useEffect, useRef } from 'react';
import type { Ticket, Member } from '../types/ticket';
import { ModalShell } from './docs/docsShared';

interface ReopenDialogProps {
  isOpen: boolean;
  ticket: Ticket;
  parentTicket?: Ticket | null;
  members?: Member[];
  isSubmitting?: boolean;
  onClose: () => void;
  onConfirm: (payload: {
    reason?: string;
    resetAc?: boolean;
    resetTests?: boolean;
    unassign?: boolean;
    reopenParent?: boolean;
  }) => void;
}

export const ReopenDialog: React.FC<ReopenDialogProps> = ({
  isOpen,
  ticket,
  parentTicket,
  members = [],
  isSubmitting = false,
  onClose,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const [resetAc, setResetAc] = useState(false);
  const [resetTests, setResetTests] = useState(false);
  const [unassign, setUnassign] = useState(false);
  const [reopenParent, setReopenParent] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const checkedAcs = ticket.acceptanceCriteria?.filter((ac) => ac.done)?.length || 0;
  const totalAcs = ticket.acceptanceCriteria?.length || 0;

  const passedTests = ticket.testCases?.filter((tc) => tc.status === 'pass')?.length || 0;
  const failedTests = ticket.testCases?.filter((tc) => tc.status === 'fail')?.length || 0;
  const totalTests = ticket.testCases?.length || 0;

  const assigneeMember = members.find((m) => m.id === ticket.assignee);
  const assigneeName = assigneeMember?.name || ticket.assignee || 'Assignee';

  const isParentDone = parentTicket && (parentTicket.status === 'done' || parentTicket.status === 'wont_do');
  const nextReopenCount = (ticket.reopenCount || 0) + 1;
  const fromStatusLabel = ticket.status === 'wont_do' ? "Won't Do" : 'Done';

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setResetAc(false);
      setResetTests(false);
      setUnassign(false);
      setReopenParent(true);
      setTimeout(() => textareaRef.current?.focus(), 80);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    onConfirm({
      reason: reason.trim() || undefined,
      resetAc,
      resetTests,
      unassign,
      reopenParent: isParentDone ? reopenParent : false,
    });
  }

  return (
    <ModalShell
      width={520}
      onClose={isSubmitting ? () => {} : onClose}
      ariaLabel={`Reopen ticket ${ticket.id}`}
      title={`Reopen ${ticket.id}?`}
      subtitle={ticket.title}
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Transition Summary Box */}
        <div
          style={{
            padding: '12px 14px',
            background: '#FFFAF0',
            border: '1px solid #F0C77A',
            borderRadius: 8,
            fontSize: 12.5,
            color: '#8A4B00',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                background: '#fff',
                border: '1px solid #F0C77A',
              }}
            >
              {fromStatusLabel}
            </span>
            <span>→</span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                background: '#fff',
                border: '1px solid #F0C77A',
                color: '#2E6F40',
              }}
            >
              To Do
            </span>
            <span style={{ marginLeft: 'auto', fontWeight: 600, fontSize: 12, color: '#C77700' }}>
              Reopen #{nextReopenCount}
            </span>
          </div>
          <div style={{ lineHeight: 1.45, color: '#663900' }}>
            • Moves back into the active board at <strong>To Do</strong>; keeps tags.
            <br />
            • Marked with the amber <strong>Reopened</strong> badge.
            {ticket.status === 'wont_do' && (
              <>
                <br />• The Won’t Do decision is cleared.
              </>
            )}
          </div>
        </div>

        {/* Reason field */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <label
              htmlFor="reopen-reason-input"
              style={{ fontSize: 12, fontWeight: 600, color: '#405246', textTransform: 'uppercase', letterSpacing: '0.04em' }}
            >
              Reason <span style={{ fontWeight: 400, color: '#7E8B83' }}>(optional)</span>
            </label>
            <span
              style={{
                fontSize: 11.5,
                color: reason.length >= 240 ? '#C4432A' : reason.length >= 220 ? '#C77700' : '#8A968E',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {reason.length} / 240
            </span>
          </div>
          <textarea
            id="reopen-reason-input"
            ref={textareaRef}
            rows={3}
            maxLength={240}
            value={reason}
            disabled={isSubmitting}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being reopened? e.g. Rate limit returns 500 under load..."
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid #D1DDD5',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
              resize: 'vertical',
            }}
          />
        </div>

        {/* Optional Side-effects */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: '#2C3A31' }}>
          {/* AC reset */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: checkedAcs > 0 ? 'pointer' : 'default',
              opacity: checkedAcs > 0 ? 1 : 0.6,
            }}
          >
            <input
              type="checkbox"
              checked={resetAc}
              disabled={checkedAcs === 0 || isSubmitting}
              onChange={(e) => setResetAc(e.target.checked)}
              style={{ accentColor: '#C77700' }}
            />
            <span>
              Uncheck acceptance criteria{' '}
              <span style={{ fontSize: 12, color: '#6A7870' }}>
                ({checkedAcs > 0 ? `${checkedAcs} of ${totalAcs} checked` : 'none checked'})
              </span>
            </span>
          </label>

          {/* Test cases reset */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: totalTests > 0 ? 'pointer' : 'default',
              opacity: totalTests > 0 ? 1 : 0.6,
            }}
          >
            <input
              type="checkbox"
              checked={resetTests}
              disabled={totalTests === 0 || isSubmitting}
              onChange={(e) => setResetTests(e.target.checked)}
              style={{ accentColor: '#C77700' }}
            />
            <span>
              Reset test results to pending{' '}
              <span style={{ fontSize: 12, color: '#6A7870' }}>
                ({totalTests > 0 ? `${passedTests} pass, ${failedTests} fail` : 'none recorded'})
              </span>
            </span>
          </label>

          {/* Sub-ticket: Reopen Parent */}
          {isParentDone && (
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 6,
                background: '#FFF8E6',
                border: '1px solid #F0C77A',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={reopenParent}
                disabled={isSubmitting}
                onChange={(e) => setReopenParent(e.target.checked)}
                style={{ accentColor: '#C77700', marginTop: 3 }}
              />
              <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                <strong>Also reopen parent ticket {parentTicket.id}</strong>
                <div style={{ color: '#8A4B00', fontSize: 12 }}>
                  A Done parent cannot keep an open sub-task, so it will move to To Do as well.
                </div>
              </div>
            </label>
          )}

          {/* Assignee choice */}
          {ticket.assignee && (
            <div style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
              <span style={{ color: '#5B6B60', fontWeight: 500 }}>Assignee:</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="reopen-assignee"
                  checked={!unassign}
                  onChange={() => setUnassign(false)}
                  style={{ accentColor: '#C77700' }}
                />
                <span>Keep {assigneeName}</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="reopen-assignee"
                  checked={unassign}
                  onChange={() => setUnassign(true)}
                  style={{ accentColor: '#C77700' }}
                />
                <span style={{ color: '#7E8B83' }}>Unassign</span>
              </label>
            </div>
          )}
        </div>

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 4,
            paddingTop: 12,
            borderTop: '1px solid #E3E8E5',
          }}
        >
          <button
            type="button"
            className="st-btn"
            onClick={onClose}
            disabled={isSubmitting}
            style={{ minWidth: 70 }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="st-btn"
            disabled={isSubmitting}
            style={{
              minWidth: 85,
              background: '#C77700',
              borderColor: '#B46A00',
              color: '#ffffff',
              fontWeight: 600,
            }}
          >
            {isSubmitting ? 'Reopening…' : 'Reopen'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};
