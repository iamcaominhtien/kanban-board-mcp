import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AiMember } from '../../types/ai';
import type { MentionIntent } from './MentionIntent';
import { AiAvatar } from './aiUi';
import './ticketWork.css';

const CARET = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    aria-hidden="true"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/** A menu that opens above or below its anchor and escapes the composer's clipped box (rendered in the body). */
export function FloatMenu({
  anchor,
  onClose,
  width = 300,
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = box.current?.getBoundingClientRect().height ?? 160;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    if (r.bottom + 6 + h > window.innerHeight - 8 && r.top - 6 - h > 8)
      setPos({ left, bottom: window.innerHeight - r.top + 6 });
    else setPos({ left, top: r.bottom + 6 });
  }, [anchor, width]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={box}
      className="tw-menu ai-root"
      role="menu"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top,
        bottom: pos?.bottom,
        width,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** “Send ▾” of a comment that mentions an AI member: Send asks what the mention means, the menu picks it. */
export function SendSplit({
  open,
  disabled,
  onToggle,
  onSend,
  onPick,
}: {
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onSend: () => void;
  onPick: (intent: MentionIntent) => void;
}) {
  const caret = useRef<HTMLButtonElement>(null);
  const items: { id: MentionIntent; title: string; sub: string }[] = [
    { id: 'ask', title: 'Ask (answer in a comment)', sub: 'A short run that replies below. Nothing changes.' },
    { id: 'work', title: 'Do the work (assign + run)', sub: 'Assigns the ticket and starts a run.' },
    { id: 'notify', title: 'Just notify', sub: 'Nothing runs.' },
  ];
  return (
    <span className="tw-split tw-split-primary" data-testid="comment-send-split">
      <button type="button" className="tw-split-main" data-testid="comment-send" disabled={disabled} onClick={onSend}>
        Send
      </button>
      <button
        ref={caret}
        type="button"
        className="tw-split-caret"
        aria-label="Send as…"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="comment-send-menu"
        disabled={disabled}
        onClick={onToggle}
      >
        {CARET}
      </button>
      {open && (
        <FloatMenu anchor={caret.current} onClose={onToggle}>
          <div className="ai-label" style={{ padding: '6px 10px 2px' }}>
            Send as
          </div>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className="tw-menu-item"
              data-testid={`send-as-${it.id}`}
              onClick={() => onPick(it.id)}
            >
              <b>{it.title}</b>
              <span className="ai-muted">{it.sub}</span>
            </button>
          ))}
        </FloatMenu>
      )}
    </span>
  );
}

/** The Ask shortcut: “Ask Claude Code · Backend ▾” sends the text as a question to that AI member. */
export function AskSplit({
  member,
  options,
  open,
  disabled,
  onToggle,
  onPick,
  onAsk,
}: {
  member: AiMember;
  options: AiMember[];
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  onAsk: () => void;
}) {
  const caret = useRef<HTMLButtonElement>(null);
  return (
    <span className="tw-split tw-split-ask" data-testid="comment-ask-split">
      <button type="button" className="tw-split-main" data-testid="comment-ask" disabled={disabled} onClick={onAsk}>
        <AiAvatar provider={member.provider} color={member.color} glyph={member.glyph} size={18} />
        Ask {member.name}
      </button>
      <button
        ref={caret}
        type="button"
        className="tw-split-caret"
        aria-label="Pick which AI to ask"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="comment-ask-menu"
        onClick={onToggle}
      >
        {CARET}
      </button>
      {open && (
        <FloatMenu anchor={caret.current} onClose={onToggle} width={280}>
          <div className="ai-label" style={{ padding: '6px 10px 2px' }}>
            Ask
          </div>
          {options.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === member.id}
              className="tw-menu-item tw-menu-row"
              onClick={() => onPick(m.id)}
            >
              <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={22} />
              <span style={{ flex: 1, fontWeight: 600 }}>{m.name}</span>
              {m.id === member.id && <span style={{ color: '#2E6F40' }}>✓</span>}
            </button>
          ))}
        </FloatMenu>
      )}
    </span>
  );
}
