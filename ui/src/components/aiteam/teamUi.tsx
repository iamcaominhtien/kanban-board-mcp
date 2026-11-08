import type { ReactNode } from 'react';
import { PauseGlyph } from '../ai/pausedUi';
import { roleCode, roleLook } from '../ai/roleLook';
/** What a team card shows. */
export type CardState = 'working' | 'waiting' | 'queued' | 'paused' | 'offline' | 'idle';

/** One end of a hand-off as a badge draws it: a person or an AI, by name and colour. */
export interface HandoffEnd {
  kind?: 'person' | 'ai';
  name?: string;
  color?: string | null;
}
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
export function StateChip({
  state,
  count,
  label,
  project,
}: {
  state: CardState;
  count?: number;
  label?: string;
  /** Paused for the whole project (orange, "AI paused"), not on its own (grey, "Paused"). */
  project?: boolean;
}) {
  const look =
    state === 'paused' && project
      ? { bg: '#FDF0E6', fg: '#B4571F', dot: '#B4571F', live: false, label: 'AI paused', line: '#2E6F40' }
      : STATE_LOOK[state];
  return (
    <span className="at-chip" style={{ background: look.bg, color: look.fg }}>
      {state === 'paused' && project ? (
        <PauseGlyph size={11} color={look.fg} />
      ) : (
        <span className={`at-dot${look.live ? ' at-dot-live' : ''}`} style={{ background: look.dot }} />
      )}
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
  role,
}: {
  end?: HandoffEnd;
  name?: string;
  color?: string | null;
  size?: number;
  person?: boolean;
  /** The role pack the member was made from: its code ("RV") replaces the initials (AT-4). */
  role?: string | null;
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
      {isPerson ? 'You' : (roleCode(role) ?? initialsOf(label))}
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

// The role chips of the team cards (AiTeam.dc.html, frame 4): Dev blue, Reviewer purple, QA amber, Docs green
const CHIP_LOOK: Record<string, { bg: string; fg: string }> = {
  dev: { bg: '#E1EEFB', fg: '#1F5A8E' },
  reviewer: { bg: '#EFEAFB', fg: '#5B4BB5' },
  qa: { bg: '#FDF3E3', fg: '#8A5A00' },
  tech_writer: { bg: '#E6F2EA', fg: '#1F5A31' },
};

/** The colours of a role's chip on a team card. */
export const chipLook = (role: string) => CHIP_LOOK[role] ?? roleLook(role);

/** The role chips of a team card: a small tag per role ("Dev", "Reviewer", "QA"), or "No roles". */
export function RoleTags({ roles }: { roles: { key: string; name?: string | null; model?: string | null }[] }) {
  if (!roles.length) return <span className="at-hint-sm">No roles</span>;
  return (
    <span className="at-tags" data-testid="role-chips">
      {roles.map((r) => {
        const look = chipLook(r.key);
        return (
          <span
            key={r.key}
            className="at-tag"
            style={{ background: look.bg, color: look.fg }}
            title={`${r.name ?? r.key}${r.model ? ` · ${r.model}` : ''}`}
          >
            {r.name ?? roleLook(r.key).glyph}
          </span>
        );
      })}
    </span>
  );
}

/** How full a conversation is: a 56 px bar and "38% of the context" (the design's working block and role card). */
export function ContextBar({ used, size }: { used: number; size: number }) {
  const pct = Math.min(100, Math.max(0, (used / size) * 100));
  const color = pct >= 85 ? '#C4432A' : '#2E6F40';
  const label = pct > 0 && pct < 1 ? '<1' : String(Math.round(pct));
  return (
    <span
      className="at-ctx"
      role="img"
      aria-label={`The conversation is ${label}% full`}
      title="How full the lead's conversation is. Claude Code summarises the oldest part when it gets close to full."
      data-testid="context-bar"
    >
      <span>
        <i style={{ width: `${Math.max(pct, 3)}%`, background: color }} />
      </span>
      {label}% of the context
    </span>
  );
}

/** A step's title with the file paths in bold, as the design draws it ("editing **ui/src/…/CardFooter.tsx**"). */
export function StepText({ text }: { text: string }) {
  const parts = text.split(/(\S+\/\S+)/g);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))}</>;
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
  /** The design's range button (AiTeam.dc.html, "Last 7 days"). */
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
};

/** The calendar glyph of the range buttons, at the design's size and stroke. */
export function CalendarIcon() {
  return <Icon size={14}>{ICONS.calendar}</Icon>;
}
