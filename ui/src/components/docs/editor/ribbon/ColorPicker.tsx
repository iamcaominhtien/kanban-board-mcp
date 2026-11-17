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
        <div className="dk-cp-title">
          <span>Custom colour</span>
          <button type="button" className="dk-cp-backlink" onClick={() => setCustom(null)}>
            Back to palette
          </button>
        </div>
        <div className="dk-cp-preview" style={{ background: hex ?? 'transparent' }} aria-hidden="true" />
        <div className="dk-cp-custom">
          <label className="dk-cp-field dk-cp-hex">
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

  const Swatch = ({ v, label, named }: { v: string; label?: string; named?: boolean }) => {
    const on = cur === v;
    const name = label ?? colorLabel(v);
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={on}
        aria-label={name}
        title={name}
        className={`dk-cp-sw${on ? ' dk-cp-sw-on' : ''}${named ? '' : ' dk-cp-sw-recent'}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(v)}
      >
        <span
          className={`dk-cp-dot${kind === 'highlight' ? ' dk-cp-dot-hl' : ''}`}
          style={{
            background: swatch(v),
            boxShadow: on ? `0 0 0 2px #FFFFFF, 0 0 0 3.5px ${kind === 'text' ? swatch(v) : '#2E6F40'}` : undefined,
          }}
        >
          {on && (
            <svg
              aria-hidden="true"
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke={kind === 'text' ? '#FFFFFF' : '#1E2A22'}
              strokeWidth={2.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12.5L10 17.5L19 7" />
            </svg>
          )}
        </span>
        {named && <span className="dk-cp-name">{name}</span>}
      </button>
    );
  };
  const currentHex = typeof value === 'string' && value !== 'mixed' ? swatch(value) : null;
  const openCustom = () => setCustom(currentHex ?? '#2e6f40');

  return (
    <div
      className={`dk-cp${touch ? ' dk-cp-touch' : ''}`}
      role="menu"
      aria-label={kind === 'text' ? 'Text colour' : 'Highlight'}
    >
      <div className="dk-cp-title">
        <span>{kind === 'text' ? 'Text colour' : 'Highlight'}</span>
        <span className="dk-cp-title-hint">Named colours</span>
      </div>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={value === null}
        className={`dk-cp-auto${value === null ? ' dk-cp-auto-on' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(null)}
      >
        {kind === 'text' ? (
          <>
            <span className="dk-cp-autobox">A</span>
            <span className="dk-cp-autolabel">Automatic</span>
            <span className="dk-cp-hint">follows the page</span>
          </>
        ) : (
          <>
            <span className="dk-cp-autobox">
              <svg
                aria-hidden="true"
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9AA8A0"
                strokeWidth={1.8}
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="8" />
                <path d="M6.5 17.5l11-11" />
              </svg>
            </span>
            <span className="dk-cp-autolabel">No highlight</span>
          </>
        )}
      </button>
      <div className="dk-cp-rule" />
      <div className="dk-cp-grid">
        {names.map((n) => (
          <Swatch key={n} v={n} named />
        ))}
      </div>
      {recent.length > 0 && (
        <div className="dk-cp-sec">
          <div className="dk-cp-head">Recent</div>
          <div className="dk-cp-recent">
            {recent.map((v) => (
              <Swatch key={v} v={v} />
            ))}
          </div>
        </div>
      )}
      <div className="dk-cp-sec">
        <div className="dk-cp-head">Custom</div>
        <div className="dk-cp-customrow">
          <button
            type="button"
            className="dk-cp-plus"
            aria-label="Custom…"
            title="Custom colour"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openCustom}
          >
            <svg
              aria-hidden="true"
              width={15}
              height={15}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className="dk-cp-hexbox"
            aria-label="Edit the custom colour"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openCustom}
          >
            <span className="dk-cp-chip" style={{ background: currentHex ?? '#2E6F40' }} />
            {(currentHex ?? '#2E6F40').toUpperCase()}
          </button>
        </div>
      </div>
    </div>
  );
}
