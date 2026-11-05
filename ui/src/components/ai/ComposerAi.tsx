import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AiTeam } from '../../types/ai';
import { AiAvatar } from './aiUi';
import './ticketWork.css';
import { LineIcon } from '../ui/LineIcon';

/** How the composer sends a comment to a team: the text goes to that team's lead as an instruction. */
export interface SendOpts {
  /** Send the text to this team (`POST /tickets/{key}/ai/run {instruction}`); a lead already working hears it. */
  askMemberId?: string;
}

const MENTION = /@\[([^\][\n]{1,100})\]\(member:([\w.-]{1,64})\)/g;

/** AI members mentioned in a text, in order. */
export function mentionedAi(text: string, members: Map<string, AiTeam>): AiTeam[] {
  const out: AiTeam[] = [];
  for (const m of text.matchAll(MENTION)) {
    const ai = members.get(m[2]);
    if (ai && ai.kind === 'ai' && !out.includes(ai)) out.push(ai);
  }
  return out;
}

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

/** The Send shortcut: “Send to Backend ▾” sends the text to that team's lead. */
export function AskSplit({
  member,
  options,
  open,
  disabled,
  onToggle,
  onPick,
  onAsk,
}: {
  member: AiTeam;
  options: AiTeam[];
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
        <AiAvatar color={member.color} size={18} />
        Send to {member.name}
      </button>
      <button
        ref={caret}
        type="button"
        className="tw-split-caret"
        aria-label="Pick which team to send to"
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
            Send to
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
              <AiAvatar color={m.color} size={22} />
              <span style={{ flex: 1, fontWeight: 600 }}>{m.name}</span>
              {m.id === member.id && (
                <span style={{ color: '#2E6F40' }}>
                  <LineIcon name="check" size={13} />
                </span>
              )}
            </button>
          ))}
        </FloatMenu>
      )}
    </span>
  );
}
