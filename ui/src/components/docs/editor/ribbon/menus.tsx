/**
 * The small menus of the ribbon and the phone sheets (Editor board F): styles drawn in their own style, fonts in their
 * own font, the size, line and paragraph spacing, drop cap, the numbered list's start and the three levels of clear
 * formatting. Each acts on the editor and calls `onDone` when a choice closes it.
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
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
  setDropCapLook,
  setFontFamily,
  setFontSize,
  setListStart,
  type ClearLevel,
  type FormatState,
  type StyleId,
} from './format';
import { keyLabel } from './parts';
import { TEXT_COLOR_NAMES, colorLabel, hexOf } from './palette';

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
      <label className="dk-rb-searchbox">
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input aria-label="Search fonts" placeholder="Search fonts" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
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
                    <span className="dk-rb-check">
                      {on && (
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#2E6F40"
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 12.5L10 17.5L19 7" />
                        </svg>
                      )}
                    </span>
                    <span style={{ flex: 1, fontFamily: FONT_FAMILY[f], fontSize: f === 'caveat' ? 16 : 14.5 }}>
                      {FONT_LABEL[f]}
                    </span>
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
      <label className="dk-rb-sizefield">
        <input
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
        <span>px</span>
      </label>
      <div role="menu" aria-label="Sizes" className="dk-rb-sizes">
        {FONT_SIZES.map((n) => (
          <button
            key={n}
            type="button"
            role="menuitemradio"
            aria-checked={cur === n}
            className={`dk-mi dk-rb-row${cur === n ? ' dk-mi-on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => set(n)}
          >
            <span className="dk-rb-check">
              {cur === n && (
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#2E6F40"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12.5L10 17.5L19 7" />
                </svg>
              )}
            </span>
            {n}
          </button>
        ))}
      </div>
      <div className="dk-rb-rule" />
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

/** A switch drawn as on the Editor board (38 x 22). */
function Switch({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`dk-rb-switch${on ? ' on' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!on)}
    />
  );
}

/** A grey track of choices with the chosen one raised in white (Editor board, frames 25 and 28). */
function Track<T extends string | number | null>({
  label,
  options,
  value,
  onChange,
  wide,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  wide?: boolean;
}) {
  return (
    <div className={`dk-rb-track${wide ? ' wide' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One labelled row of a ribbon panel: the words on the left, the control on the right. */
function PanelRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="dk-rb-prow">
      <div>
        <div className="dk-rb-plabel">{label}</div>
        {hint && <div className="dk-rb-phint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** The drop cap colours: the text's own, then the twelve named text colours. */
const DROP_COLORS = [null, ...TEXT_COLOR_NAMES] as const;

/**
 * Drop cap of the paragraph (Editor board, frame 25): a switch, how many lines tall (2 to 5), dropped or raised, its
 * colour and its font.
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 */
export function DropCapMenu({ editor, st, noFocus }: MenuProps) {
  const [colours, setColours] = useState(false);
  const on = st.dropCap > 0;
  const lines = on ? st.dropCap : 3;
  const look = (a: Parameters<typeof setDropCapLook>[1]) => {
    if (!on) setDropCap(editor, 3);
    setDropCapLook(editor, a);
    focus(editor, noFocus);
  };
  const colourName = st.dropCapColor ? colorLabel(st.dropCapColor) : 'Same as text';
  return (
    <div className="dk-rb-panel" data-testid="dropcap-menu" aria-label="Drop cap">
      <div className="dk-rb-phead">
        <span>Drop cap</span>
        <Switch
          label="Drop cap"
          on={on}
          onChange={(v) => {
            setDropCap(editor, v ? 3 : 0);
            focus(editor, noFocus);
          }}
        />
      </div>
      <PanelRow label="Lines tall" hint="How many lines the letter spans">
        <Track
          label="Lines tall"
          value={lines}
          onChange={(n) => {
            setDropCap(editor, n as (typeof DROP_CAPS)[number]);
            focus(editor, noFocus);
          }}
          options={DROP_CAPS.filter((n) => n > 0).map((n) => ({ value: n, label: String(n) }))}
        />
      </PanelRow>
      <PanelRow label="Position">
        <Track
          label="Position"
          wide
          value={st.dropCapStyle}
          onChange={(v) => look({ dropCapStyle: v })}
          options={[
            { value: null, label: 'Dropped' },
            { value: 'raised', label: 'Raised' },
          ]}
        />
      </PanelRow>
      <PanelRow label="Colour" hint="Same as text, or a palette colour">
        <button
          type="button"
          className="dk-rb-colourbtn"
          aria-expanded={colours}
          aria-label={`Drop cap colour: ${colourName}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setColours((c) => !c)}
        >
          <span
            style={{
              background: st.dropCapColor ? (hexOf('text', st.dropCapColor, '#FFFFFF') ?? '#1E2A22') : '#1E2A22',
            }}
          />
          {colourName}
        </button>
      </PanelRow>
      {colours && (
        <div className="dk-rb-dropcolours" role="radiogroup" aria-label="Drop cap colour">
          {DROP_COLORS.map((c) => (
            <button
              key={String(c)}
              type="button"
              role="radio"
              aria-checked={st.dropCapColor === c}
              aria-label={c ? colorLabel(c) : 'Same as text'}
              title={c ? colorLabel(c) : 'Same as text'}
              className={st.dropCapColor === c ? 'on' : undefined}
              style={{ background: c ? (hexOf('text', c, '#FFFFFF') ?? '#1E2A22') : '#FFFFFF' }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                look({ dropCapColor: c });
                setColours(false);
              }}
            >
              {c ? '' : 'A'}
            </button>
          ))}
        </div>
      )}
      <PanelRow label="Font">
        <select
          className="dk-rb-pselect"
          aria-label="Drop cap font"
          value={st.dropCapFont ?? ''}
          onChange={(e) => look({ dropCapFont: e.target.value || null })}
        >
          <option value="">Heading font</option>
          <option value="body">Body font</option>
        </select>
      </PanelRow>
      <div className="dk-rb-pnote">Applies to the first letter of this paragraph.</div>
    </div>
  );
}

/** The numbered list's styles as the board draws them (Editor board, frame 28). */
const LIST_LOOKS = [
  { value: 'decimal', label: '1.' },
  { value: 'lower-alpha', label: 'a.' },
  { value: 'lower-roman', label: 'i.' },
  { value: 'upper-alpha', label: 'A.' },
  { value: 'upper-roman', label: 'I.' },
] as const;

/** The ordered list just before the one with the caret, at the same level, if any. */
function listAbove(editor: Editor): { start: number; count: number } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    if ($from.node(d).type.name !== 'orderedList') continue;
    const index = $from.index(d - 1);
    const before = index > 0 ? $from.node(d - 1).child(index - 1) : null;
    if (before?.type.name !== 'orderedList') return null;
    const start = typeof before.attrs.start === 'number' ? before.attrs.start : 1;
    return { start, count: before.childCount };
  }
  return null;
}

/**
 * The numbered list (Editor board, frame 28): its numbering, the number it starts at and whether it carries on from
 * the list above.
 * @param props.editor - The editor.
 * @param props.st - The format of the selection.
 */
export function ListStartMenu({ editor, st, noFocus }: MenuProps) {
  const ensure = () => {
    if (st.list !== 'ordered') editor.chain().toggleOrderedList().run();
  };
  const cur = st.list === 'ordered' ? st.listStart : 1;
  const style = (editor.getAttributes('orderedList').listStyle as string | null) ?? 'decimal';
  const above = listAbove(editor);
  const next = above ? above.start + above.count : null;
  const start = (n: number) => {
    ensure();
    setListStart(editor, n);
    focus(editor, noFocus);
  };
  return (
    <div className="dk-rb-panel" data-testid="list-start-menu" aria-label="Numbered list">
      <div className="dk-rb-phead">
        <span>Numbered list</span>
      </div>
      <div className="dk-rb-listlooks" role="radiogroup" aria-label="Numbering">
        {LIST_LOOKS.map((l) => (
          <button
            key={l.value}
            type="button"
            role="radio"
            aria-checked={style === l.value}
            className={style === l.value ? 'on' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              ensure();
              editor.commands.updateAttributes('orderedList', { listStyle: l.value === 'decimal' ? null : l.value });
              focus(editor, noFocus);
            }}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="dk-rb-rule dk-rb-rule-wide" />
      <PanelRow label="Start at">
        <span className="dk-rb-stepper">
          <button
            type="button"
            aria-label="Start lower"
            disabled={cur <= 1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => start(cur - 1)}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
          <input
            aria-label="Start at"
            inputMode="numeric"
            key={cur}
            defaultValue={cur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                start(Number(e.currentTarget.value));
              }
            }}
            onBlur={(e) => {
              if (Number(e.currentTarget.value) !== cur) start(Number(e.currentTarget.value));
            }}
          />
          <button
            type="button"
            aria-label="Start higher"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => start(cur + 1)}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </span>
      </PanelRow>
      <PanelRow label="Continue from the list above">
        <Switch
          label="Continue from the list above"
          on={next !== null && cur === next}
          onChange={(v) => {
            if (next === null) return;
            start(v ? next : 1);
          }}
        />
      </PanelRow>
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
