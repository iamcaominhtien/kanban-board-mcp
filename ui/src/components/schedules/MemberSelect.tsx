import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AiTeam } from '../../types/ai';
import type { Ticket } from '../../types';
import { AiAvatar } from '../ai/aiUi';
import { CheckCircleIcon, ChevronIcon, LockIcon } from './schedulesUi';
import { LineIcon } from '../ui/LineIcon';

/** Click outside closes a popover. */
function useOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open, onClose]);
  return ref;
}

/** Select of AI members that shows each one's avatar (a native select cannot). */
export function MemberSelect({
  members,
  value,
  onChange,
  none,
  invalid,
  testId,
  disabled,
}: {
  members: AiTeam[];
  value: string;
  onChange: (id: string) => void;
  /** Label of the empty choice ("None. Skip when unavailable."); without it a member must be picked. */
  none?: string;
  invalid?: boolean;
  testId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const current = members.find((m) => m.id === value);
  return (
    <div ref={ref} className="sc-pop-wrap">
      <button
        type="button"
        className={`sc-select ${invalid ? 'sc-invalid' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
      >
        {current ? (
          <>
            <AiAvatar provider={current.provider} size={22} />
            <span className="sc-select-text">{current.name}</span>
          </>
        ) : (
          <span className="sc-select-text sc-placeholder">{none ?? 'Pick an AI member'}</span>
        )}
        <ChevronIcon size={14} />
      </button>
      {open && (
        <div className="sc-pop" role="listbox">
          {none !== undefined && (
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className="ai-mi"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              <span className="sc-placeholder">{none}</span>
            </button>
          )}
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === value}
              className="ai-mi"
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              data-testid={`pick-${m.name}`}
            >
              <AiAvatar provider={m.provider} size={22} />
              <span className="sc-grow">{m.name}</span>
              {m.id === value && (
                <span style={{ color: '#2E6F40' }}>
                  <LineIcon name="check" size={14} />
                </span>
              )}
            </button>
          ))}
          {!members.length && (
            <div className="ai-muted" style={{ padding: 10 }}>
              No AI members yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Time zone picker with search (the design draws a custom dropdown; a native select lists hundreds of OS-styled
 * entries). Arrow keys move, Enter picks, Esc closes.
 */
export function ZoneSelect({
  zones,
  value,
  onChange,
  testId,
  maxWidth = 300,
}: {
  zones: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  testId?: string;
  maxWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const close = () => {
    setOpen(false);
    setQ('');
  };
  const ref = useOutside(open, close);
  const listRef = useRef<HTMLDivElement>(null);
  const current = zones.find((z) => z.id === value);
  const needle = q.trim().toLowerCase().replace(/\s+/g, '_');
  const list = needle ? zones.filter((z) => z.label.toLowerCase().replace(/\s+/g, '_').includes(needle)) : zones;
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  const openList = () => {
    setActive(
      Math.max(
        0,
        zones.findIndex((z) => z.id === value),
      ),
    );
    setOpen(true);
  };
  const pick = (id: string | undefined) => {
    if (!id) return;
    close();
    if (id !== value) onChange(id);
  };
  return (
    <div ref={ref} className="sc-pop-wrap" style={{ maxWidth }}>
      <button
        type="button"
        className="sc-select sc-select-field"
        onClick={() => (open ? close() : openList())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Time zone"
        data-testid={testId}
      >
        <span className="sc-select-text">{current?.label ?? value}</span>
        <ChevronIcon size={14} />
      </button>
      {open && (
        <div className="sc-pop">
          <input
            className="ai-input"
            placeholder="Search a city or zone…"
            aria-label="Search time zones"
            value={q}
            autoFocus
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, list.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(list[active]?.id);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
          <div ref={listRef} role="listbox" aria-label="Time zone" className="sc-pop-list">
            {list.map((z, i) => (
              <button
                key={z.id}
                type="button"
                role="option"
                aria-selected={z.id === value}
                data-index={i}
                className={`ai-mi ${i === active ? 'sc-mi-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(z.id)}
              >
                <span className="sc-grow">{z.label}</span>
                {z.id === value && (
                  <span style={{ color: '#2E6F40' }}>
                    <LineIcon name="check" size={14} />
                  </span>
                )}
              </button>
            ))}
            {!list.length && (
              <div className="ai-muted" style={{ padding: 10 }}>
                No time zone matches.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Dot colour of a ticket's status. */
const DOT: Record<string, string> = {
  backlog: '#9AA8A0',
  todo: '#3B6FB6',
  'in-progress': '#D9822B',
  review: '#6B5BD2',
  testing: '#B4541A',
  done: '#2E6F40',
  wont_do: '#9AA8A0',
};

/** "● KAN-151  Return 409 on duplicate member names". */
export function TicketLine({ id, title, status }: { id: string; title?: string | null; status?: string | null }) {
  return (
    <>
      <span className="sc-tdot" style={{ background: DOT[status ?? ''] ?? '#2E6F40' }} />
      <span className="ai-mono sc-tid">{id}</span>
      {title && <span className="sc-ttitle">{title}</span>}
    </>
  );
}

/** Ticket picker with search; locked shows the ticket and why it cannot change. */
export function TicketPicker({
  tickets,
  value,
  onChange,
  locked,
  invalid,
}: {
  tickets: Ticket[];
  value: string;
  onChange: (id: string) => void;
  /** Why the choice is fixed ("Locked: opened from the ticket"). */
  locked?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useOutside(open, () => setOpen(false));
  const current = tickets.find((t) => t.id === value);
  const needle = q.trim().toLowerCase();
  const list = tickets
    .filter((t) => t.status !== 'done' && t.status !== 'wont_do')
    .filter((t) => !needle || t.id.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle))
    .slice(0, 40);
  if (locked)
    return (
      <div className="sc-select sc-locked" data-testid="ticket-locked">
        <TicketLine id={value} title={current?.title} status={current?.status} />
        <span className="sc-grow" />
        <span
          className="ai-muted"
          style={{ display: 'inline-flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          <LockIcon size={11} /> {locked}
        </span>
      </div>
    );
  return (
    <div ref={ref} className="sc-pop-wrap">
      <button
        type="button"
        className={`sc-select ${invalid ? 'sc-invalid' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="ticket-picker"
      >
        {current ? (
          <TicketLine id={current.id} title={current.title} status={current.status} />
        ) : (
          <span className="sc-select-text sc-placeholder">Pick a ticket</span>
        )}
        <span className="sc-grow" />
        <ChevronIcon size={14} />
      </button>
      {open && (
        <div className="sc-pop" role="listbox" style={{ maxHeight: 320, overflow: 'auto' }}>
          <input
            className="ai-input"
            placeholder="Search by key or title…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          {list.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={t.id === value}
              className="ai-mi"
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
            >
              <TicketLine id={t.id} title={t.title} status={t.status} />
            </button>
          ))}
          {!list.length && (
            <div className="ai-muted" style={{ padding: 10 }}>
              No open tickets match.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A check or warning line with its icon (the CHECKS list). */
export function CheckLine({ level, children }: { level: 'ok' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`sc-check sc-check-${level}`}>
      {level === 'ok' ? (
        <CheckCircleIcon size={15} />
      ) : (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 3.5L22 20H2Z" />
          <path d="M12 10V14M12 17.2V17.3" />
        </svg>
      )}
      <span>{children}</span>
    </div>
  );
}
