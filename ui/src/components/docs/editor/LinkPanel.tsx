/**
 * The link panel (Editor board, frame 30; Ctrl K): the text of the link, its address with pages and tickets that match
 * what is typed, "Open in a new tab", Cancel and Apply, and Remove for a link that is there already.
 */

import type { Editor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocsTreeNode } from '../../../types/docs';
import type { TicketLite } from './context';

/** Pages and tickets the address field offers. */
export interface LinkTargets {
  nodes: DocsTreeNode[];
  tickets: TicketLite[];
}

interface Suggestion {
  kind: 'page' | 'ticket';
  label: string;
  href: string;
}

/** A typed address as a link: `example.com` gets https://, a path, an anchor or a scheme stays as it is. */
export function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/^(https?:|mailto:|tel:|\/|#|\?)/i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)) return `https://${v}`;
  return v;
}

/** The address of a page or a ticket of this app, kept relative so it works on any host. */
const pageHref = (id: string) => `?docs=${encodeURIComponent(id)}`;
const ticketHref = (id: string) => `?ticket=${encodeURIComponent(id)}`;

/** The selected text, or the whole link the caret is on. */
function linkText(editor: Editor): string {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (!empty) return state.doc.textBetween(from, to, ' ');
  if (!editor.isActive('link')) return '';
  const $p = state.selection.$from;
  const parent = $p.parent;
  let text = '';
  parent.forEach((child, offset) => {
    const start = $p.start() + offset;
    if (
      child.isText &&
      child.marks.some((m) => m.type.name === 'link') &&
      start <= from &&
      from <= start + child.nodeSize
    )
      text = child.text ?? '';
  });
  return text;
}

/**
 * The panel.
 * @param props.targets - Pages and tickets offered for what is typed.
 * @param props.onClose - Called when it closes (after Apply, Cancel, Remove or Esc).
 */
export function LinkPanel({
  editor,
  targets,
  onClose,
}: {
  editor: Editor;
  targets?: LinkTargets;
  onClose: () => void;
}) {
  const existing = (editor.getAttributes('link').href as string | undefined) ?? '';
  const startText = useMemo(() => linkText(editor), [editor]);
  const [text, setText] = useState(startText);
  const [url, setUrl] = useState(existing);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => urlRef.current?.focus(), 0);
  }, []);

  const q = url.trim().toLowerCase();
  const looksLikeAddress = /^(https?:|mailto:|tel:|\/|#|\?)|\.[a-z]{2,}/i.test(url.trim());
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!q || looksLikeAddress || picked || !targets) return [];
    const pages = targets.nodes
      .filter((n) => n.title.toLowerCase().includes(q))
      .slice(0, 3)
      .map((n) => ({ kind: 'page' as const, label: n.title, href: pageHref(n.id) }));
    const tickets = targets.tickets
      .filter((t) => `${t.id} ${t.title}`.toLowerCase().includes(q))
      .slice(0, 3)
      .map((t) => ({ kind: 'ticket' as const, label: `${t.id} ${t.title}`, href: ticketHref(t.id) }));
    return [...pages, ...tickets].slice(0, 5);
  }, [q, looksLikeAddress, picked, targets]);

  const apply = (hrefIn?: string) => {
    const href = normalizeUrl(hrefIn ?? url);
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) {
      chain.unsetLink().run();
    } else if (text.trim() && text !== startText) {
      chain.insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else if (editor.state.selection.empty && !editor.isActive('link')) {
      const words = text.trim() || href;
      chain.insertContent({ type: 'text', text: words, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      chain.setLink({ href }).run();
    }
    onClose();
  };
  const choose = (s: Suggestion) => {
    setUrl(s.href);
    setPicked(true);
    if (!text.trim()) setText(s.kind === 'ticket' ? s.label.split(' ')[0] : s.label);
  };

  const icon = (kind: Suggestion['kind']) =>
    kind === 'page' ? (
      <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
    ) : (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M8.5 12.5l2.5 2.5 4.5-5" />
      </>
    );

  return (
    <div
      className="dk-linkp"
      data-testid="link-panel"
      role="dialog"
      aria-label="Link"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          editor.commands.focus();
        }
      }}
    >
      <div className="dk-linkp-head">
        <span>Link</span>
        {existing && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
              onClose();
            }}
          >
            Remove
          </button>
        )}
      </div>
      <label className="dk-linkp-field">
        <span>Text</span>
        <input
          aria-label="Link text"
          value={text}
          placeholder="The words to show"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label className="dk-linkp-field">
        <span>Link</span>
        <input
          ref={urlRef}
          aria-label="Link URL"
          value={url}
          placeholder="Paste a link, or search pages and tickets"
          onChange={(e) => {
            setUrl(e.target.value);
            setPicked(false);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault();
              setActive((a) => (a + suggestions.length - 1) % suggestions.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (suggestions[active]) choose(suggestions[active]);
              else apply();
            }
          }}
        />
      </label>
      {suggestions.length > 0 && (
        <div className="dk-linkp-list" role="listbox" aria-label="Pages and tickets">
          {suggestions.map((s, i) => (
            <button
              key={s.href}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(s)}
            >
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {icon(s.kind)}
              </svg>
              <span className="dk-linkp-label">{s.label}</span>
              <span className="dk-linkp-kind">{s.kind === 'page' ? 'Page' : 'Ticket'}</span>
            </button>
          ))}
        </div>
      )}
      <div className="dk-linkp-row" title="Links on a page always open in a new tab">
        <span>Open in a new tab</span>
        <span
          className="dk-rb-switch on"
          role="switch"
          aria-checked="true"
          aria-disabled="true"
          aria-label="Open in a new tab"
        />
      </div>
      <div className="dk-linkp-foot">
        <button
          type="button"
          className="st-btn st-btn-sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onClose();
            editor.commands.focus();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="st-btn st-btn-sm st-btn-primary"
          disabled={!url.trim() && !existing}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
