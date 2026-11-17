/**
 * The small menus of the ribbon and the phone sheets (Editor board F): styles drawn in their own style, fonts in their
 * own font, the size, line and paragraph spacing, drop cap, the numbered list's start and the three levels of clear
 * formatting. Each acts on the editor and calls `onDone` when a choice closes it.
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useState, type CSSProperties } from 'react';
import { FONT_FAMILY, FONT_LABEL, type PageFont } from '../../pageSettings';
import {
  DROP_CAPS,
  FONT_SIZES,
  LINE_HEIGHTS,
  STYLE_IDS,
  STYLE_INFO,
  applyStyle,
  clampFontSize,
  clearFormatting,
  setBlockAttrs,
  setDropCap,
  setFontFamily,
  setFontSize,
  setListStart,
  type ClearLevel,
  type FormatState,
  type StyleId,
} from './format';
import { keyLabel } from './parts';

interface MenuProps {
  editor: Editor;
  st: FormatState;
  onDone: () => void;
  /** Keep the caret out of the page (phone sheets keep the keyboard down). */
  noFocus?: boolean;
}

const focus = (editor: Editor, noFocus?: boolean) => {
  if (!noFocus) editor.commands.focus();
};

/** How each style row is drawn. */
const STYLE_LOOK: Record<StyleId, CSSProperties> = {
  body: { fontSize: 14 },
  lead: { fontSize: 16.5, color: '#3A4A3E' },
  h1: { fontSize: 21, fontWeight: 800 },
  h2: { fontSize: 18, fontWeight: 800 },
  h3: { fontSize: 16, fontWeight: 700 },
  h4: { fontSize: 14, fontWeight: 700 },
  quote: { fontSize: 14, fontStyle: 'italic', borderLeft: '3px solid #C7D2CB', paddingLeft: 8 },
  code: { fontSize: 13, fontFamily: "'JetBrains Mono', monospace" },
  small: { fontSize: 12, color: '#5B6B60' },
};

/**
 * The Styles menu: Body, Lead, Heading 1 to 4, Quote, Code and Small, each drawn in its style.
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 * @param props.onDone - Called after a choice.
 */
export function StyleMenu({ editor, st, onDone, noFocus }: MenuProps) {
  return (
    <div role="menu" aria-label="Styles" data-testid="style-menu">
      {STYLE_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="menuitemradio"
          aria-checked={st.style === id}
          className={`dk-mi dk-rb-row${st.style === id ? ' dk-mi-on' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            applyStyle(editor, id);
            focus(editor, noFocus);
            onDone();
          }}
        >
          <span style={{ flex: 1, ...STYLE_LOOK[id] }}>{STYLE_INFO[id].label}</span>
          {STYLE_INFO[id].keys && <span className="dk-rb-keys">{keyLabel(STYLE_INFO[id].keys!)}</span>}
        </button>
      ))}
    </div>
  );
}

/** Font families grouped as the font menu shows them. */
const FONT_GROUPS: { label: string; fonts: PageFont[] }[] = [
  { label: 'Page font', fonts: ['jakarta'] },
  { label: 'Serif', fonts: ['lora', 'source-serif', 'merriweather', 'playfair'] },
  { label: 'Sans', fonts: ['inter'] },
  { label: 'Mono', fonts: ['jetbrains-mono'] },
  { label: 'Handwriting', fonts: ['caveat'] },
];

/**
 * The font menu: a search and the eight bundled fonts, each name drawn in its font. "Plus Jakarta Sans · default"
 * takes the page font back (no font stored).
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 * @param props.onDone - Called after a choice.
 */
export function FontMenu({ editor, st, onDone, noFocus }: MenuProps) {
  const [q, setQ] = useState('');
  const match = (f: PageFont) => FONT_LABEL[f].toLowerCase().includes(q.trim().toLowerCase());
  const pick = (f: PageFont | null) => {
    setFontFamily(editor, f);
    focus(editor, noFocus);
    onDone();
  };
  return (
    <div data-testid="font-menu">
      <input
        className="dk-rb-search"
        aria-label="Search fonts"
        placeholder="Search fonts"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div role="menu" aria-label="Fonts">
        {FONT_GROUPS.map((g) => {
          const fonts = g.fonts.filter(match);
          if (!fonts.length) return null;
          return (
            <div key={g.label}>
              <div className="dk-rb-group">{g.label}</div>
              {fonts.map((f) => {
                const on =
                  f === 'jakarta' ? st.fontFamily === null || st.fontFamily === 'jakarta' : st.fontFamily === f;
                return (
                  <button
                    key={f}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={`dk-mi dk-rb-row${on ? ' dk-mi-on' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(f === 'jakarta' ? null : f)}
                  >
                    <span style={{ flex: 1, fontFamily: FONT_FAMILY[f], fontSize: 14.5 }}>{FONT_LABEL[f]}</span>
                    {f === 'jakarta' && <span className="dk-rb-keys">default</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The size menu: type a size (8 to 160), or pick one; "Use the style size" takes the stored size off.
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 * @param props.styleSize - The size of the block's style in px, shown in "Use the style size (18)".
 * @param props.onDone - Called after a choice.
 */
export function SizeMenu({ editor, st, onDone, noFocus, styleSize }: MenuProps & { styleSize: number }) {
  const cur = typeof st.fontSize === 'number' ? st.fontSize : null;
  const [typed, setTyped] = useState(String(cur ?? styleSize));
  const set = (n: number | null) => {
    setFontSize(editor, n);
    focus(editor, noFocus);
    onDone();
  };
  return (
    <div data-testid="size-menu">
      <input
        className="dk-rb-search"
        aria-label="Font size"
        inputMode="decimal"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const n = clampFontSize(typed);
            if (n !== null) set(n);
          }
        }}
      />
      <div role="menu" aria-label="Sizes" className="dk-rb-sizes">
        {FONT_SIZES.map((n) => (
          <button
            key={n}
            type="button"
            role="menuitemradio"
            aria-checked={cur === n}
            className={`dk-mi${cur === n ? ' dk-mi-on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => set(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="dk-mi dk-rb-row"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => set(null)}
      >
        Use the style size ({Math.round(styleSize)})
      </button>
    </div>
  );
}

/** A number field in px for the spacing menu (empty = the style's spacing). */
function PxField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [v, setV] = useState(value === null ? '' : String(value));
  useEffect(() => setV(value === null ? '' : String(value)), [value]);
  const commit = () => {
    const n = parseFloat(v);
    onChange(v.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, Math.min(200, Math.round(n))));
  };
  return (
    <label className="dk-rb-px">
      <span>{label}</span>
      <input
        aria-label={`Space ${label.toLowerCase()} (px)`}
        inputMode="numeric"
        placeholder="0"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span className="dk-rb-unit">px</span>
    </label>
  );
}

/**
 * Line and paragraph spacing: five line heights, space before and after in px; it acts on every paragraph the
 * selection touches. With `dropCap` it also offers the drop cap of a paragraph (off, 3 or 5 lines).
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 */
export function SpacingMenu({ editor, st, noFocus, onDone }: MenuProps) {
  return (
    <div data-testid="spacing-menu" className="dk-rb-form">
      <div className="dk-rb-group">Line spacing</div>
      <div role="menu" aria-label="Line spacing">
        {LINE_HEIGHTS.map((l) => (
          <button
            key={l.value}
            type="button"
            role="menuitemradio"
            aria-checked={st.lineHeight === l.value}
            className={`dk-mi dk-rb-row${st.lineHeight === l.value ? ' dk-mi-on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setBlockAttrs(editor, { lineHeight: st.lineHeight === l.value ? null : l.value });
              focus(editor, noFocus);
              onDone();
            }}
          >
            <span style={{ flex: 1 }}>{l.label}</span>
            {'note' in l && <span className="dk-rb-keys">{l.note}</span>}
          </button>
        ))}
      </div>
      <div className="dk-rb-group">Paragraph spacing</div>
      <div style={{ display: 'flex', gap: 8, padding: '2px 8px 6px' }}>
        <PxField label="Before" value={st.spaceBefore} onChange={(v) => setBlockAttrs(editor, { spaceBefore: v })} />
        <PxField label="After" value={st.spaceAfter} onChange={(v) => setBlockAttrs(editor, { spaceAfter: v })} />
      </div>
    </div>
  );
}

/**
 * Drop cap of the paragraph: off, 3 or 5 lines (Editor boards 25, 26).
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 */
export function DropCapMenu({ editor, st, noFocus, onDone }: MenuProps) {
  return (
    <div role="menu" aria-label="Drop cap" data-testid="dropcap-menu">
      {DROP_CAPS.map((n) => (
        <button
          key={n}
          type="button"
          role="menuitemradio"
          aria-checked={st.dropCap === n}
          className={`dk-mi dk-rb-row${st.dropCap === n ? ' dk-mi-on' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setDropCap(editor, n);
            focus(editor, noFocus);
            onDone();
          }}
        >
          {n === 0 ? 'Off' : `${n} lines`}
        </button>
      ))}
      <div className="dk-rb-note">Applies to the first letter of this paragraph.</div>
    </div>
  );
}

/**
 * The numbered list's start number.
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 */
export function ListStartMenu({ editor, st, onDone, noFocus }: MenuProps) {
  const [v, setV] = useState(String(st.listStart));
  const apply = () => {
    if (st.list !== 'ordered') editor.chain().toggleOrderedList().run();
    setListStart(editor, Number(v));
    focus(editor, noFocus);
    onDone();
  };
  return (
    <div className="dk-rb-form" data-testid="list-start-menu">
      <div className="dk-rb-group">Numbered list</div>
      <label className="dk-rb-px" style={{ padding: '2px 8px 8px' }}>
        <span>Start at</span>
        <input
          aria-label="Start at"
          inputMode="numeric"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            }
          }}
        />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 8px 6px' }}>
        <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}

const CLEAR: { level: ClearLevel; label: string; keys?: string }[] = [
  { level: 'text', label: 'Clear text formatting', keys: 'Mod+Space' },
  { level: 'paragraph', label: 'Clear paragraph formatting' },
  { level: 'all', label: 'Back to page style' },
];

/**
 * Clear formatting, three levels (Editor board 33).
 * @param props.editor - The editor.
 */
export function ClearMenu({ editor, onDone, noFocus }: Omit<MenuProps, 'st'>) {
  return (
    <div role="menu" aria-label="Clear formatting" data-testid="clear-menu">
      {CLEAR.map((c) => (
        <button
          key={c.level}
          type="button"
          role="menuitem"
          className="dk-mi dk-rb-row"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            clearFormatting(editor, c.level);
            focus(editor, noFocus);
            onDone();
          }}
        >
          <span style={{ flex: 1 }}>{c.label}</span>
          {c.keys && <span className="dk-rb-keys">{keyLabel(c.keys)}</span>}
        </button>
      ))}
    </div>
  );
}
