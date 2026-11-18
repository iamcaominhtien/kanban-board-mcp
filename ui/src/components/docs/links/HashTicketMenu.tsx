/**
 * "#" a ticket (RichDocsLinks C 18): typing `#` after a space lists the project's tickets, recent first; typing
 * narrows by key or title; Enter inserts the ticket chip (its status stays live), Tab only the key.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { TICKET_DOT, TICKET_STATUS_LABEL } from '../editor/constants';
import type { TicketLite } from '../editor/context';
import type { MenuHost, MenuState } from '../editor/menuHost';
import { Hint, MenuFooter, useMenuPosition } from '../editor/SlashMenu';
import { Kbd } from '../searchShared';

/** The tickets a `#query` offers: key or title holding the words, at most 8, in the given (recent first) order. */
export function hashTickets(tickets: TicketLite[], query: string): TicketLite[] {
  const q = query.trim().toLowerCase();
  return tickets.filter((t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)).slice(0, 8);
}

/**
 * The `#` ticket list.
 * @param props.host - The menu host of the `#` trigger.
 * @param props.state - The trigger's state (the words after `#`).
 * @param props.tickets - The project's tickets, recent first.
 * @param props.projectName - Named in the list's head ("Tickets in Kanban Board").
 */
export function HashTicketMenu({
  host,
  state,
  tickets,
  projectName,
}: {
  host: MenuHost;
  state: MenuState;
  tickets: TicketLite[];
  projectName?: string;
}) {
  const [active, setActive] = useState(0);
  const { ref, pos } = useMenuPosition(state.rect, 440);
  const list = useMemo(() => hashTickets(tickets, state.query), [tickets, state.query]);
  const act = Math.min(active, Math.max(0, list.length - 1));
  useEffect(() => setActive(0), [state.query]);
  const live = useRef({ list, act, state });
  live.current = { list, act, state };
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    host.keyHandler = (e) => {
      const s = live.current;
      const n = s.list.length;
      if (e.key === 'ArrowDown') {
        if (n) setActive((a) => (Math.min(a, n - 1) + 1) % n);
        return true;
      }
      if (e.key === 'ArrowUp') {
        if (n) setActive((a) => (Math.min(a, n - 1) - 1 + n) % n);
        return true;
      }
      const t = s.list[s.act];
      if ((e.key === 'Enter' || e.key === 'Tab') && t) {
        s.state.run(e.key === 'Enter' ? { kind: 'ticket', key: t.id } : { kind: 'text', text: t.id });
        return true;
      }
      return false;
    };
    return () => {
      host.keyHandler = null;
    };
  }, [host]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [act]);

  return (
    <div
      ref={ref}
      data-testid="hash-ticket-menu"
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        zIndex: 60,
        width: 440,
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
        borderRadius: 12,
        background: '#FFFFFF',
        border: '1px solid #DCE3DE',
        boxShadow: '0 16px 40px rgba(30,42,34,.2)',
        overflow: 'hidden',
      }}
    >
      <div ref={listRef} style={{ padding: '4px 0 6px', maxHeight: 360, overflowY: 'auto' }} role="listbox">
        <div
          style={{
            padding: '10px 18px 4px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: '#5B6B60',
          }}
        >
          Tickets{projectName ? ` in ${projectName}` : ''}
        </div>
        {list.length === 0 && (
          <div style={{ padding: '8px 18px', fontSize: 13, color: '#5B6B60' }}>No ticket matches “{state.query}”.</div>
        )}
        {list.map((t, i) => (
          <div
            key={t.id}
            role="option"
            aria-selected={i === act}
            data-active={i === act}
            data-testid="hash-ticket-row"
            onMouseEnter={() => setActive(i)}
            onClick={() => state.run({ kind: 'ticket', key: t.id })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minHeight: 44,
              padding: '3px 10px',
              margin: '0 5px',
              borderRadius: 8,
              background: i === act ? '#E6F2EA' : 'transparent',
              cursor: 'pointer',
              boxSizing: 'border-box',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: TICKET_DOT[t.status] ?? '#9AA8A0',
                flex: 'none',
                margin: '0 5px',
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t.title}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: '#5B6B60',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{t.id}</span> ·{' '}
                {TICKET_STATUS_LABEL[t.status] ?? t.status}
              </div>
            </div>
            {i === act && (
              <span style={{ marginLeft: 6 }}>
                <Kbd>Enter</Kbd>
              </span>
            )}
          </div>
        ))}
      </div>
      <MenuFooter>
        <Hint k="Enter">insert</Hint>
        <Hint k="Tab">only the key</Hint>
        <Hint k="Esc">close</Hint>
      </MenuFooter>
    </div>
  );
}
