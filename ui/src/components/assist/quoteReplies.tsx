import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LineIcon } from '../ui/LineIcon';

/**
 * Reply to a passage of an answer: select it, press Reply, write a line under it. Several passages wait in a tray
 * above the composer and go out together as one message, each as a Markdown quote with its reply under it.
 */

export type QuoteReply = { id: string; quote: string; text: string };

/** What a selection reads as: no trailing spaces, no run of blank lines. */
export function cleanQuote(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The one message the tray sends: every passage as a quote with its reply under it, then the composer's text. */
export function composeReplies(replies: QuoteReply[], text: string): string {
  const parts = replies.map((r) => {
    const quote = r.quote
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    return r.text.trim() ? `${quote}\n\n${r.text.trim()}` : quote;
  });
  if (text.trim()) parts.push(text.trim());
  return parts.join('\n\n');
}

export type QuotedPart = { kind: 'quote' | 'text'; text: string };

/** A sent message split into its quotes (lines that start with ">") and the text between them. */
export function splitQuoted(message: string): QuotedPart[] {
  const parts: QuotedPart[] = [];
  for (const line of message.split('\n')) {
    const quoted = /^>\s?(.*)$/.exec(line);
    const kind = quoted ? 'quote' : 'text';
    const body = quoted ? quoted[1] : line;
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += `\n${body}`;
    else parts.push({ kind, text: body });
  }
  return parts
    .map((p) => ({ ...p, text: p.text.replace(/^\n+|\n+$/g, '') }))
    .filter((p) => p.kind === 'quote' || p.text.trim());
}

/** A message the person sent: its quotes framed, the rest as typed. */
export function UserText({ text }: { text: string }) {
  if (!text.split('\n').some((l) => l.startsWith('>'))) return <>{text}</>;
  return (
    <>
      {splitQuoted(text).map((p, i) =>
        p.kind === 'quote' ? (
          <div key={i} className="as-user-quote">
            {p.text}
          </div>
        ) : (
          <div key={i}>{p.text}</div>
        ),
      )}
    </>
  );
}

const HIGHLIGHT = 'as-reply';

/** Marks the passages waiting in the tray in the answers (CSS Custom Highlight API; nothing where it is missing). */
function paint(ranges: Range[]) {
  const reg = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !Ctor) return;
  if (ranges.length) reg.set(HIGHLIGHT, new Ctor(...ranges));
  else reg.delete(HIGHLIGHT);
}

let seq = 0;

/** The passages waiting to be sent, with their marks in the answers. */
export function useQuoteReplies() {
  const [replies, setReplies] = useState<QuoteReply[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const ranges = useRef(new Map<string, Range>());

  useEffect(() => {
    paint(replies.map((r) => ranges.current.get(r.id)).filter((r): r is Range => !!r));
  }, [replies]);
  useEffect(() => () => paint([]), []);

  const add = useCallback((quote: string, range?: Range) => {
    const id = `q${Date.now()}-${++seq}`;
    if (range) ranges.current.set(id, range);
    setReplies((rs) => [...rs, { id, quote, text: '' }]);
    setFocusId(id);
  }, []);
  const update = useCallback((id: string, text: string) => {
    setReplies((rs) => rs.map((r) => (r.id === id ? { ...r, text } : r)));
  }, []);
  const remove = useCallback((id: string) => {
    ranges.current.delete(id);
    setReplies((rs) => rs.filter((r) => r.id !== id));
  }, []);
  const clear = useCallback(() => {
    ranges.current.clear();
    setReplies([]);
  }, []);

  return { replies, focusId, add, update, remove, clear };
}

function quotableOf(node: Node, root: HTMLElement): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const q = el?.closest('.as-quotable') ?? null;
  return q && root.contains(q) ? q : null;
}

type Spot = { x: number; y: number; quote: string; range: Range };

/** The floating Reply button over a selection inside an answer (an element with the class `as-quotable`). */
export function SelectToReply({
  containerRef,
  onReply,
  disabled,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onReply: (quote: string, range: Range) => void;
  disabled?: boolean;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || disabled) return;
    const check = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setSpot(null);
      const range = sel.getRangeAt(0);
      const start = quotableOf(range.startContainer, root);
      if (!start || start !== quotableOf(range.endContainer, root)) return setSpot(null);
      const quote = cleanQuote(sel.toString());
      if (!quote) return setSpot(null);
      const rect = range.getBoundingClientRect();
      setSpot({ x: rect.left + rect.width / 2, y: rect.top, quote, range: range.cloneRange() });
    };
    // read once the pointer is up, so the button does not follow the drag
    const later = () => window.setTimeout(check, 0);
    const onSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSpot(null);
    };
    const hide = () => setSpot(null);
    root.addEventListener('pointerup', later);
    root.addEventListener('keyup', later);
    root.addEventListener('scroll', hide);
    document.addEventListener('selectionchange', onSelection);
    window.addEventListener('resize', hide);
    return () => {
      root.removeEventListener('pointerup', later);
      root.removeEventListener('keyup', later);
      root.removeEventListener('scroll', hide);
      document.removeEventListener('selectionchange', onSelection);
      window.removeEventListener('resize', hide);
    };
  }, [containerRef, disabled]);

  if (!spot || disabled) return null;
  return createPortal(
    <button
      type="button"
      className="as-reply-pop"
      style={{ left: spot.x, top: Math.max(8, spot.y - 38) }}
      data-testid="reply-to-selection"
      // keep the selection while the button is pressed
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onReply(spot.quote, spot.range);
        window.getSelection()?.removeAllRanges();
        setSpot(null);
      }}
    >
      <LineIcon name="reply" size={13} /> Reply
    </button>,
    document.body,
  );
}

/** The passages waiting above the composer, each with its own reply. Enter moves on to the message box. */
export function ReplyTray({
  replies,
  focusId,
  onChange,
  onRemove,
  onDone,
}: {
  replies: QuoteReply[];
  focusId: string | null;
  onChange: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onDone?: () => void;
}) {
  if (!replies.length) return null;
  return (
    <div className="as-replies" data-testid="reply-tray">
      <div className="as-replies-head">
        Replying to {replies.length === 1 ? '1 passage' : `${replies.length} passages`} · sent together
      </div>
      {replies.map((r, i) => (
        <div key={r.id} className="as-reply" data-testid="reply-item">
          <div className="as-reply-quote" title={r.quote}>
            {r.quote}
          </div>
          <div className="as-reply-row">
            <textarea
              rows={1}
              value={r.text}
              placeholder="Your reply to this part…"
              aria-label={`Reply to passage ${i + 1}`}
              autoFocus={r.id === focusId}
              onChange={(e) => onChange(r.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onDone?.();
                }
              }}
            />
            <button
              type="button"
              className="as-reply-remove"
              aria-label={`Remove passage ${i + 1}`}
              title="Remove"
              onClick={() => onRemove(r.id)}
            >
              <LineIcon name="close" size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
