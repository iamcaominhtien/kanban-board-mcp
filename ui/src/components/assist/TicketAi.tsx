import { useEffect, useMemo, useRef, useState, Fragment } from 'react';
import { useAssistState } from '../../api/assist';
import type { Ticket } from '../../types';
import { SparkleIcon, useAiBoardState } from '../ai/aiUi';
import { shortcutLabel, useAssist } from './AssistContext';
import { featureBlock } from './assistUi';
import './assist.css';
import { LineIcon } from '../ui/LineIcon';

/**
 * The ticket header "AI" button: it opens the chat docked in the ticket page (design/screens/ai-where-you-work.md, B);
 * the arrow beside it keeps the menu of one-click helpers.
 * Hidden when AI is turned off for the project or no AI member exists.
 * @param props.ticket - The open ticket.
 * @param props.chatOpen - Whether the chat panel is open (the button shows pressed).
 * @param props.onToggleChat - Opens or closes the chat panel.
 */
export function TicketAiMenu({
  ticket,
  chatOpen = false,
  onToggleChat,
}: {
  ticket: Ticket;
  chatOpen?: boolean;
  onToggleChat?: (open?: boolean) => void;
}) {
  const ctx = useAssist();
  const { members: aiMembers } = useAiBoardState();
  const st = useAssistState(ticket.projectId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const chat = featureBlock(st.data, 'chat');
  const items = useMemo(
    () => [
      {
        label: 'Ask about this ticket',
        icon: 'chat' as const,
        block: onToggleChat ? undefined : chat?.reason,
        hint: shortcutLabel(),
        run: async () => (onToggleChat ? onToggleChat(true) : ctx?.ask({ scope: 'ticket', ticketId: ticket.id })),
      },
    ],
    [chat, ticket.id, ctx, onToggleChat],
  );
  // AI helpers appear when AI is on for the project and an AI member exists (design E)
  if (!onToggleChat && (!st.data || st.data.boardAi.state === 'not_configured')) return null;
  if (onToggleChat && aiMembers.size === 0 && (!st.data || st.data.boardAi.state === 'not_configured')) return null;
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }} className="ai-root">
      {onToggleChat && (
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          style={{
            height: 30,
            borderTopRightRadius: 0,
            borderBottomRightRadius: 0,
            borderColor: chatOpen ? '#6B4FE0' : undefined,
            color: chatOpen ? '#4B2FBF' : undefined,
            background: chatOpen ? '#F3F0FD' : undefined,
          }}
          aria-pressed={chatOpen}
          title={`AI chat about ${ticket.id} (${shortcutLabel()})`}
          onClick={() => onToggleChat()}
          data-testid="ticket-ai-chat"
        >
          <SparkleIcon size={12} /> AI
        </button>
      )}
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        style={{
          height: 30,
          borderColor: open ? '#2E6F40' : undefined,
          ...(onToggleChat
            ? { padding: '0 7px', marginLeft: -1, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }
            : {}),
        }}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={onToggleChat ? 'More AI helpers' : 'AI'}
        data-testid="ticket-ai-menu"
      >
        {onToggleChat ? (
          <LineIcon name="chevronDown" size={12} />
        ) : (
          <>
            <SparkleIcon size={12} /> AI <LineIcon name="chevronDown" size={12} />
          </>
        )}
      </button>
      {open && (
        <div className="as-menu" style={{ top: 36, left: 0 }} role="menu">
          {items.map((it) => (
            <Fragment key={it.label}>
              <button
                type="button"
                role="menuitem"
                disabled={!!it.block}
                title={it.block}
                onClick={async () => {
                  setOpen(false);
                  await it.run();
                }}
              >
                <LineIcon name={it.icon} size={14} color="#5B6B60" />
                <span style={{ flex: 1 }}>{it.label}</span>
                {'hint' in it && it.hint && <span className="as-kbd">{it.hint}</span>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
