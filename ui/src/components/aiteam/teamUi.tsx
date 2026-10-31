import type { ReactNode } from 'react';
import type { CardState, HandoffEnd } from '../../types/aiTeam';
import './aiTeam.css';
import '../docs/docs.css';

const STATE_LOOK: Record<
  CardState,
  { bg: string; fg: string; dot: string; live?: boolean; label: string; line: string }
> = {
  working: { bg: '#E6F2EA', fg: '#1F5A31', dot: '#2E6F40', live: true, label: 'Working', line: '#2E6F40' },
  waiting: { bg: '#FEF3D9', fg: '#7A5A06', dot: '#E8B93A', label: 'Waiting for you', line: '#B8860B' },
  offline: { bg: '#FDECE8', fg: '#A5321E', dot: '#C4432A', label: 'Offline', line: '#C4432A' },
  idle: { bg: '#F1F3F1', fg: '#5B6B60', dot: '#C7D2CB', label: 'Idle', line: '#2E6F40' },
  queued: { bg: '#E8F1FA', fg: '#244E78', dot: '#2F6FB0', label: 'Queued', line: '#2E6F40' },
  paused: { bg: '#F1F3F1', fg: '#5B6B60', dot: '#9AA8A0', label: 'Paused', line: '#2E6F40' },
};

export const STATE_ORDER: CardState[] = ['working', 'waiting', 'offline', 'idle', 'queued', 'paused'];
/** The word a state chip shows. */
export const stateLabel = (s: CardState) => STATE_LOOK[s].label;
/** The colour of a card's trend line. */
export const stateLine = (s: CardState) => STATE_LOOK[s].line;

/** A coloured chip for an AI's state, with an optional count. */
export function StateChip({ state, count, label }: { state: CardState; count?: number; label?: string }) {
  const look = STATE_LOOK[state];
  return (
    <span className="at-chip" style={{ background: look.bg, color: look.fg }}>
      <span className={`at-dot${look.live ? ' at-dot-live' : ''}`} style={{ background: look.dot }} />
      {label ?? look.label}
      {count != null ? ` ${count}` : ''}
    </span>
  );
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const raw = words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
  return raw.toUpperCase() || '?';
}

/** A member's square badge: its initials in its colour (the dark "You" square for a person). */
export function Badge({
  end,
  name,
  color,
  size = 32,
  person,
}: {
  end?: HandoffEnd;
  name?: string;
  color?: string | null;
  size?: number;
  person?: boolean;
}) {
  const label = end?.name ?? name ?? '';
  const isPerson = person ?? end?.kind === 'person';
  const tint = (end?.color ?? color) || '#5B6B60';
  const small = size < 26;
  return (
    <span
      className="at-avatar"
      title={label}
      style={{
        width: size,
        height: size,
        borderRadius: small ? 6 : 9,
        fontSize: small ? 7 : 11,
        ...(isPerson
          ? { background: '#1E2A22', color: '#fff', border: '1.5px solid #1E2A22' }
          : { background: `${tint}22`, color: tint, border: `1.5px solid ${tint}` }),
      }}
    >
      {isPerson ? 'You' : initialsOf(label)}
    </span>
  );
}

/** A ticket as a small chip that opens it. */
export function TicketChip({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  return (
    <button type="button" className="at-tchip" onClick={() => onOpen?.(id)} title={`Open ${id}`}>
      <span className="at-dot" style={{ background: '#2F6FB0' }} />
      <span>{id}</span>
    </button>
  );
}

/** The rising line on a card: runs so far across the range. */
export function Spark({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1);
  const pts = values.map(
    (v, i) => `${(2 + (i * 66) / Math.max(values.length - 1, 1)).toFixed(1)},${(21 - (v / max) * 16).toFixed(1)}`,
  );
  return (
    <svg width="70" height="24" viewBox="0 0 70 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polygon points={`2,22 ${pts.join(' ')} 68,22`} fill={color} opacity="0.12" />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A 24-unit stroke icon. */
export function Icon({
  children,
  color = 'currentColor',
  size = 14,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

export const ICONS = {
  question: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  page: (
    <>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  pause: (
    <>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </>
  ),
  play: <path d="M8 5l11 7-11 7z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
};

export const KIND_LOOK: Record<string, { bg: string; fg: string }> = {
  mention: { bg: '#EFE8FB', fg: '#5B3AA6' },
  'asked you': { bg: '#FEF3D9', fg: '#7A5A06' },
  'hand-off': { bg: '#E6F2EA', fg: '#1F5A31' },
  'report back': { bg: '#F1F3F1', fg: '#5B6B60' },
  'sent back': { bg: '#FDECE8', fg: '#A5321E' },
  assigned: { bg: '#E8F1FA', fg: '#244E78' },
  answered: { bg: '#E6F2EA', fg: '#1F5A31' },
};
