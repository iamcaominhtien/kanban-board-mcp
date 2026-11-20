/**
 * The colour popover of the floating selection toolbar (Start board, frame 16): Text and Highlight tabs, the 12 text
 * colours and the 12 highlights by name, the colours used last, a free value with its name, and "No colour". A swatch
 * sets its own kind (a highlight swatch highlights even on the Text tab); the tab says what the free value and "No
 * colour" act on. The ribbon keeps its own picker (Editor board, frame 11).
 */

import { useState } from 'react';
import {
  HIGHLIGHT_NAMES,
  TEXT_COLOR_NAMES,
  backgroundOf,
  colorLabel,
  hexOf,
  normalizeHex,
  recentColors,
  type ColorKind,
} from './palette';

interface Props {
  /** The tab it opens on: `text` from the colour button, `highlight` from the highlight caret. */
  initial: ColorKind;
  /** The selection's text colour and highlight: a name, `#rrggbb`, `null` or `'mixed'`. */
  text: unknown;
  highlight: unknown;
  /** The page colour, for the swatches. */
  pageHex: string;
  /** Called with the colour chosen for a kind (`null` = no colour). */
  onPick: (kind: ColorKind, value: string | null) => void;
}

/**
 * The popover.
 * @param props.initial - The tab shown first.
 * @param props.onPick - Called with the kind and the colour.
 */
export function BubbleColors({ initial, text, highlight, pageHex, onPick }: Props) {
  const [tab, setTab] = useState<ColorKind>(initial);
  const cur = (kind: ColorKind) => {
    const v = kind === 'text' ? text : highlight;
    return typeof v === 'string' && v !== 'mixed' ? v : null;
  };
  const hexFor = (kind: ColorKind, v: string) => hexOf(kind, v, pageHex) ?? v;
  const active = cur(tab);
  const activeHex = (
    active ? hexFor(tab, active) : tab === 'text' ? hexFor('text', 'green') : hexFor('highlight', 'yellow')
  ).toUpperCase();
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? activeHex;
  const typedHex = normalizeHex(shown);
  // the name of the free value, when it is one of the page's named colours
  const names = tab === 'text' ? TEXT_COLOR_NAMES : HIGHLIGHT_NAMES;
  const named = typedHex ? names.find((n) => hexFor(tab, n).toLowerCase() === typedHex) : undefined;
  const page = colorLabel(backgroundOf(pageHex));
  const recent = [
    ...recentColors('text').map((v) => ({ kind: 'text' as const, v })),
    ...recentColors('highlight').map((v) => ({ kind: 'highlight' as const, v })),
  ].slice(0, 6);

  const grid = (kind: ColorKind, list: readonly string[]) => (
    <div className="dk-bcp-grid" role="radiogroup" aria-label={kind === 'text' ? 'Text colours' : 'Highlights'}>
      {list.map((n) => {
        const on = cur(kind) === n;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${colorLabel(n)} ${kind === 'text' ? 'text' : 'highlight'}`}
            className={`dk-bcp-cell${on ? ' on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(kind, n)}
          >
            <span className="dk-bcp-sw" style={{ background: hexFor(kind, n) }} />
            <span className="dk-bcp-name">{colorLabel(n)}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="dk-bcp" data-testid="bubble-colours">
      <div className="dk-bcp-tabs" role="tablist" aria-label="Colour of">
        {(['text', 'highlight'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'on' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setTab(k);
              setTyped(null);
            }}
          >
            {k === 'text' ? 'Text' : 'Highlight'}
          </button>
        ))}
      </div>
      <div>
        <div className="dk-bcp-label">Text colour · {page} page</div>
        {grid('text', TEXT_COLOR_NAMES)}
      </div>
      <div>
        <div className="dk-bcp-label">Highlight</div>
        {grid('highlight', HIGHLIGHT_NAMES)}
      </div>
      <div>
        <div className="dk-bcp-label">Recent</div>
        <div className="dk-bcp-recent">
          {recent.length === 0 && <span className="dk-bcp-none">Colours you use show here</span>}
          {recent.map((r) => (
            <button
              key={`${r.kind}-${r.v}`}
              type="button"
              aria-label={`${colorLabel(r.v)} ${r.kind === 'text' ? 'text' : 'highlight'}`}
              title={colorLabel(r.v)}
              style={{ background: hexFor(r.kind, r.v) }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(r.kind, r.v)}
            />
          ))}
        </div>
      </div>
      <div className="dk-bcp-free">
        <span className="dk-bcp-sw" style={{ background: typedHex ?? 'transparent' }} aria-hidden="true" />
        <input
          aria-label={tab === 'text' ? 'Text colour hex' : 'Highlight hex'}
          spellCheck={false}
          value={shown}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typedHex) {
              e.preventDefault();
              onPick(tab, named ?? typedHex);
            }
          }}
        />
        <span className="dk-bcp-freename">{named ? colorLabel(named) : typedHex ? 'Custom' : ''}</span>
      </div>
      <button
        type="button"
        className="dk-bcp-clear"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(tab, null)}
      >
        <svg
          aria-hidden="true"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M6 6L18 18M18 6L6 18" />
        </svg>
        No colour
      </button>
    </div>
  );
}
