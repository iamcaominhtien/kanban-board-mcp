/**
 * The keyboard shortcut sheet (Editor board I): one list grouped like the ribbon, searchable, with Mac keys on
 * demand. Opened from the ribbon, the status line, the phone's More sheet, Ctrl+/ in the page, or ? outside the
 * text. A shortcut that is not on this list does not exist.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BottomSheet } from '../../DocsSheets';
import { keyLabel } from './parts';

/** One row: what it does and its keys (several ways are listed one after another). */
export interface ShortcutRow {
  label: string;
  keys: string[];
}

/** The sheet's groups, in the ribbon's order. Keys use `Mod` for Ctrl (⌘ on a Mac). */
export const SHORTCUTS: { group: string; rows: ShortcutRow[] }[] = [
  {
    group: 'Text',
    rows: [
      { label: 'Bold', keys: ['Mod+B'] },
      { label: 'Italic', keys: ['Mod+I'] },
      { label: 'Underline', keys: ['Mod+U'] },
      { label: 'Strikethrough', keys: ['Mod+Shift+X'] },
      { label: 'Inline code', keys: ['Mod+E'] },
      { label: 'Superscript', keys: ['Mod+.'] },
      { label: 'Subscript', keys: ['Mod+,'] },
      { label: 'Highlight', keys: ['Mod+Shift+H'] },
      { label: 'Link', keys: ['Mod+K'] },
      { label: 'Clear formatting', keys: ['Mod+Space', 'Mod+\\'] },
    ],
  },
  {
    group: 'Paragraph',
    rows: [
      { label: 'Heading 1 to 4', keys: ['Mod+Alt+1 to 4'] },
      { label: 'Body text', keys: ['Mod+Alt+0'] },
      { label: 'Quote', keys: ['Mod+Shift+B'] },
      { label: 'Bulleted list', keys: ['Mod+Shift+8'] },
      { label: 'Numbered list', keys: ['Mod+Shift+7'] },
      { label: 'Task list', keys: ['Mod+Shift+9'] },
      { label: 'Align left, centre, right', keys: ['Mod+Shift+L', 'Mod+Shift+E', 'Mod+Shift+R'] },
      { label: 'Justify', keys: ['Mod+Shift+J'] },
      { label: 'Indent, outdent', keys: ['Tab', 'Shift+Tab'] },
      { label: 'Indent, outdent a paragraph', keys: ['Mod+]', 'Mod+['] },
    ],
  },
  {
    group: 'Insert',
    rows: [
      { label: 'Insert menu', keys: ['/'] },
      { label: 'Link a page', keys: ['[['] },
      { label: 'Divider', keys: ['---'] },
      { label: 'Code block', keys: ['```'] },
      { label: 'Image from the clipboard', keys: ['Mod+V'] },
      { label: 'Paste as plain text', keys: ['Mod+Shift+V'] },
      { label: 'Line break in a block', keys: ['Shift+Enter'] },
    ],
  },
  {
    group: 'Page',
    rows: [
      { label: 'Save the draft', keys: ['Mod+S'] },
      { label: 'Publish', keys: ['Mod+Enter'] },
      { label: 'Find', keys: ['Mod+F'] },
      { label: 'Find and replace', keys: ['Mod+H'] },
      { label: 'Copy format', keys: ['Mod+Alt+C'] },
      { label: 'Paste format', keys: ['Mod+Alt+V'] },
      { label: 'Focus mode', keys: ['Mod+Shift+F'] },
      { label: 'Undo, redo', keys: ['Mod+Z', 'Mod+Y'] },
      { label: 'This list', keys: ['Mod+/'] },
    ],
  },
];

/** "Mod+Alt+1 to 4" written for Windows ("Ctrl Alt 1 to 4") or a Mac ("⌘⌥1 to 4"). */
function keysText(keys: string, mac: boolean): string {
  if (!/[A-Za-z]+\+/.test(keys)) return keys;
  const [combo, ...rest] = keys.split(' ');
  return [mac ? keyLabel(combo, true) : keyLabel(combo, false).replace(/\+/g, ' '), ...rest].join(' ');
}

interface Props {
  onClose: () => void;
  /** Drawn as a bottom sheet (phone). */
  sheet?: boolean;
}

/**
 * The shortcut sheet.
 * @param props.onClose - Called by Close, Esc or a press outside.
 * @param props.sheet - Draw it as a bottom sheet.
 */
export function ShortcutSheet({ onClose, sheet }: Props) {
  const [q, setQ] = useState('');
  const [mac, setMac] = useState(() => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform));
  const input = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return SHORTCUTS.map((g) => ({
      ...g,
      rows: g.rows.filter(
        (r) =>
          !s ||
          r.label.toLowerCase().includes(s) ||
          r.keys.some((k) => keysText(k, mac).toLowerCase().includes(s)) ||
          g.group.toLowerCase().includes(s),
      ),
    })).filter((g) => g.rows.length);
  }, [q, mac]);

  useEffect(() => {
    if (sheet) return undefined;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sheet, onClose]);

  const body = (
    <div className="dk-keys" data-testid="shortcut-sheet">
      <div className="dk-keys-top">
        <input
          ref={input}
          className="dk-rb-search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="dk-seg" role="radiogroup" aria-label="Keyboard">
          <button type="button" role="radio" aria-checked={!mac} onClick={() => setMac(false)}>
            Windows
          </button>
          <button type="button" role="radio" aria-checked={mac} onClick={() => setMac(true)}>
            Mac
          </button>
        </div>
      </div>
      <div className="dk-keys-cols">
        {groups.map((g) => (
          <section key={g.group} aria-label={g.group}>
            <h3>{g.group}</h3>
            {g.rows.map((r) => (
              <div key={r.label} className="dk-keys-row">
                <span>{r.label}</span>
                <span className="dk-keys-k">
                  {r.keys.map((k) => (
                    <span key={k} className="dk-kbd">
                      {keysText(k, mac)}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
        {!groups.length && <div className="dk-rb-note">No shortcut matches “{q}”.</div>}
      </div>
      <div className="dk-rb-note">
        On a Mac, Ctrl is ⌘ and Alt is ⌥. With a tablet keyboard attached the same shortcuts work.
      </div>
    </div>
  );

  if (sheet)
    return (
      <BottomSheet label="Keyboard shortcuts" onClose={onClose} testId="shortcut-sheet-phone">
        {body}
      </BottomSheet>
    );
  return createPortal(
    <div className="dk-overlay docs-root" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dk-scrim" aria-hidden="true" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="dk-keys-dialog">
        <div className="dk-keys-head">
          <span>Keyboard shortcuts</span>
          <button type="button" className="dk-icobtn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {body}
      </div>
    </div>,
    document.body,
  );
}
