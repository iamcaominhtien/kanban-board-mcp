import React, { useEffect, useRef, useState } from 'react';
import type { Ticket } from '../types';
import { STATUS_NAMES } from '../hooks/useMarkerActions';

interface ReopenDropPopoverProps {
  ticket: Ticket;
  /** Where the card was dropped (viewport coordinates). */
  x: number;
  y: number;
  isSubmitting?: boolean;
  onCancel: () => void;
  onMoreOptions: (reason: string) => void;
  onConfirm: (reason: string) => void;
}

/**
 * Inline popover at the drop target when a card is dragged out of Done / Won't Do: the move is
 * not applied until it is confirmed (TicketReopen A3).
 */
export const ReopenDropPopover: React.FC<ReopenDropPopoverProps> = ({
  ticket,
  x,
  y,
  isSubmitting = false,
  onCancel,
  onMoreOptions,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const left = Math.min(Math.max(x - 150, 12), window.innerWidth - 312);
  const top = Math.min(Math.max(y - 20, 12), window.innerHeight - 190);
  const btn: React.CSSProperties = {
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid #E3E8E5',
    background: '#fff',
    color: '#1E2A22',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000 }} onMouseDown={onCancel}>
      <form
        role="dialog"
        aria-label={`Reopen ${ticket.id}?`}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!isSubmitting) onConfirm(reason.trim());
        }}
        style={{
          position: 'absolute',
          left,
          top,
          width: 300,
          boxSizing: 'border-box',
          padding: 14,
          borderRadius: 12,
          background: '#fff',
          border: '1px solid #F0C77A',
          boxShadow: '0 12px 28px rgba(30,42,34,0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>Reopen {ticket.id}?</div>
          <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>
            {STATUS_NAMES[ticket.status] ?? ticket.status} to To Do, marked Reopened
          </div>
        </div>
        <input
          ref={inputRef}
          value={reason}
          maxLength={240}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this being reopened?"
          disabled={isSubmitting}
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid #E3E8E5',
            fontSize: 13,
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => onMoreOptions(reason)}
            style={{ ...btn, border: 'none', background: 'transparent', color: '#2E6F40', padding: '6px 0' }}
          >
            More options
          </button>
          <span style={{ flexGrow: 1 }} />
          <button type="button" style={btn} onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{ ...btn, background: '#2E6F40', color: '#fff', border: 'none', opacity: isSubmitting ? 0.75 : 1 }}
          >
            {isSubmitting ? 'Reopening...' : 'Reopen'}
          </button>
        </div>
      </form>
    </div>
  );
};
