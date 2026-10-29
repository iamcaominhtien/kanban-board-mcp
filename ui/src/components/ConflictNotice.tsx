import React from 'react';

interface ConflictNoticeProps {
  /** Amber box text (the bold lead goes in `who`). */
  who: string;
  message: string;
}

/** Amber "someone changed it meanwhile" box of the concurrent-change edge cases (TicketReopen G, TicketPending H). */
export const ConflictNotice: React.FC<ConflictNoticeProps> = ({ who, message }) => (
  <div
    role="alert"
    style={{
      padding: '10px 12px',
      borderRadius: 8,
      background: '#FFFAF0',
      border: '1px solid #F0C77A',
      fontSize: 12.5,
      color: '#5C3200',
      lineHeight: 1.45,
    }}
  >
    <b>{who}</b> {message}
  </div>
);

/** Footer buttons of a conflict: View ticket / Close. */
export const ConflictActions: React.FC<{ onView?: () => void; onClose: () => void }> = ({ onView, onClose }) => (
  <>
    {onView && (
      <button
        type="button"
        onClick={onView}
        style={{
          padding: '7px 13px',
          borderRadius: 8,
          border: '1px solid #E3E8E5',
          background: '#FFFFFF',
          color: '#1E2A22',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        View ticket
      </button>
    )}
    <button
      type="button"
      onClick={onClose}
      style={{
        padding: '8px 14px',
        borderRadius: 8,
        border: 'none',
        background: '#2E6F40',
        color: '#FFFFFF',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      Close
    </button>
  </>
);
