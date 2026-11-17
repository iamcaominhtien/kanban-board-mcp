/**
 * Text colour and highlight (Editor board D): Automatic (or No highlight) first, then the 12 named colours, the last
 * five used, and a custom colour with its hex, its red, green and blue, and its contrast on this page. A low contrast
 * warns and never blocks.
 */

import { useState } from 'react';
import {
  HIGHLIGHT_NAMES,
  TEXT_COLOR_NAMES,
  checkContrast,
  colorLabel,
  hexOf,
  hexToRgb,
  normalizeHex,
  recentColors,
  rgbToHex,
  type ColorKind,
} from './palette';
import { Glyph } from './parts';

interface Props {
  kind: ColorKind;
  /** The colour of the selection: a name, `#rrggbb`, `null` (Automatic / none) or `'mixed'`. */
  value: unknown;
  /** The page colour, for the swatches and the contrast. */
  pageHex: string;
  /** Called with the chosen colour (`null` = Automatic, or No highlight). */
  onPick: (value: string | null) => void;
  /** Larger swatches for a phone sheet. */
  touch?: boolean;
}

/**
 * The colour picker of the ribbon, the selection toolbar and the phone sheet.
 * @param props.kind - `text` or `highlight`.
 * @param props.value - The selection's colour.
 * @param props.pageHex - The page colour.
 * @param props.onPick - Called with the colour chosen.
 * @param props.touch - 44 px targets.
 */
export function ColorPicker({ kind, value, pageHex, onPick, touch }: Props) {
  const [custom, setCustom] = useState<string | null>(null);
  const names = kind === 'text' ? TEXT_COLOR_NAMES : HIGHLIGHT_NAMES;
  const recent = recentColors(kind);
  const cur = typeof value === 'string' ? value : null;
  const swatch = (v: string) => hexOf(kind, v, pageHex) ?? v;

  if (custom !== null) {
    const hex = normalizeHex(custom);
    const rgb = hex ? hexToRgb(hex) : null;
    const check = hex && kind === 'text' ? checkContrast(hex, pageHex) : null;
    const setChannel = (i: number, v: string) => {
      const base = rgb ?? [0, 0, 0];
      const next = [...base] as [number, number, number];
      next[i] = Number(v);
      setCustom(rgbToHex(...next));
    };
    return (
      <div className="dk-cp" data-testid={`color-custom-${kind}`}>
        <button type="button" className="dk-cp-back" onClick={() => setCustom(null)}>
          <Glyph name="back" size={14} /> Back to palette
        </button>
        <div className="dk-cp-custom">
          <span className="dk-cp-big" style={{ background: hex ?? 'transparent' }} aria-hidden="true" />
          <label className="dk-cp-field">
            <span>HEX</span>
            <input
              aria-label="Hex colour"
              value={custom}
              spellCheck={false}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hex) {
                  e.preventDefault();
                  onPick(hex);
                }
              }}
            />
          </label>
          {(['R', 'G', 'B'] as const).map((ch, i) => (
            <label key={ch} className="dk-cp-field dk-cp-ch">
              <span>{ch}</span>
              <input
                aria-label={ch === 'R' ? 'Red' : ch === 'G' ? 'Green' : 'Blue'}
                type="number"
                min={0}
                max={255}
                value={rgb ? rgb[i] : ''}
                onChange={(e) => setChannel(i, e.target.value)}
              />
            </label>
          ))}
        </div>
        {check && (
          <div className={`dk-cp-contrast${check.ok ? '' : ' dk-cp-warn'}`} role="status" data-testid="color-contrast">
            {check.message}
          </div>
        )}
        <div className="dk-cp-actions">
          <button type="button" className="st-btn st-btn-sm" onClick={() => setCustom(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            disabled={!hex}
            onClick={() => hex && onPick(hex)}
          >
            Use colour
          </button>
        </div>
      </div>
    );
  }

  const Swatch = ({ v, label }: { v: string; label?: string }) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={cur === v}
      aria-label={label ?? colorLabel(v)}
      title={label ?? colorLabel(v)}
      className={`dk-cp-sw${cur === v ? ' dk-cp-sw-on' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(v)}
    >
      <span
        className={kind === 'text' ? 'dk-cp-dot dk-cp-dot-text' : 'dk-cp-dot'}
        style={kind === 'text' ? { color: swatch(v) } : { background: swatch(v) }}
      >
        {kind === 'text' ? 'A' : null}
      </span>
      {touch && <span className="dk-cp-name">{label ?? colorLabel(v)}</span>}
    </button>
  );

  return (
    <div
      className={`dk-cp${touch ? ' dk-cp-touch' : ''}`}
      role="menu"
      aria-label={kind === 'text' ? 'Text colour' : 'Highlight'}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={value === null}
        className={`dk-cp-auto${value === null ? ' dk-cp-sw-on' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(null)}
      >
        {kind === 'text' ? (
          <>
            <span className="dk-cp-dot dk-cp-dot-text">A</span>
            <span>Automatic</span>
            <span className="dk-cp-hint">follows the page</span>
          </>
        ) : (
          <>
            <span className="dk-cp-dot dk-cp-none" />
            <span>No highlight</span>
          </>
        )}
      </button>
      <div className="dk-cp-head">Named colours</div>
      <div className="dk-cp-grid">
        {names.map((n) => (
          <Swatch key={n} v={n} />
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <div className="dk-cp-head">Recent</div>
          <div className="dk-cp-grid">
            {recent.map((v) => (
              <Swatch key={v} v={v} />
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        className="dk-cp-more"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setCustom(typeof value === 'string' && value.startsWith('#') ? value : '#2e6f40')}
      >
        Custom…
      </button>
    </div>
  );
}
