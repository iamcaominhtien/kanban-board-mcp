/**
 * The strip shown while a block opened from a link is marked (RichDocsLinks D 25): "Showing the linked block from
 * Decision log", and Clear highlight. It stays at the top of the page while the block is in view, and goes with the
 * mark.
 */

import { useArrival } from './blockAnchor';

/** The arrival banner; nothing while no linked block is marked. */
export function ArrivalBanner() {
  const a = useArrival();
  if (!a) return null;
  return (
    <div
      role="status"
      data-testid="arrival-banner"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 16px',
        background: '#FFF6D9',
        borderBottom: '1px solid #EBD99A',
        borderRadius: 8,
        fontSize: 13,
        marginBottom: 8,
      }}
    >
      <svg
        aria-hidden="true"
        width={15}
        height={15}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#8A5A00"
        strokeWidth={2}
        strokeLinecap="round"
        style={{ flex: 'none' }}
      >
        <rect x="4" y="5" width="16" height="14" rx="2.5" />
        <path d="M8 10h8M8 14h5" />
      </svg>
      <span style={{ flex: 1, color: '#5A4300' }}>
        Showing the linked block{a.from ? ' from ' : ''}
        {a.from && <b>{a.from}</b>}
      </span>
      <button
        type="button"
        onClick={a.clear}
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          font: 'inherit',
          fontWeight: 700,
          color: '#8A5A00',
          cursor: 'pointer',
        }}
      >
        Clear highlight
      </button>
    </div>
  );
}
