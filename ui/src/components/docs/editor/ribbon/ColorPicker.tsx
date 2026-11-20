/**
 * Text colour and highlight (Editor board D): Automatic (or No highlight) first, then the 12 named colours, the last
 * five used, and a custom colour with its hex, its red, green and blue, and its contrast on this page. A low contrast
 * warns and never blocks.
 */

import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
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

/** `#rrggbb` → hue (0-360), saturation and value (0-1). */
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

/** Hue (0-360), saturation and value (0-1) → `#rrggbb`. */
export function hsvToHex(h: number, sat: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * sat * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return rgbToHex(f(5), f(3), f(1));
}

/** The eye dropper of the browser (Chrome, Edge), when it has one. */
type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };
const eyeDropper = (): EyeDropperCtor | null =>
  typeof window !== 'undefined' ? ((window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper ?? null) : null;

/**
 * The saturation and value square and the hue slider of Custom colour (Editor board, frame 13).
 * @param props.hex - The colour now.
 * @param props.onChange - Called with the colour as it is dragged.
 */
function HsvPicker({ hex, onChange }: { hex: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(hex));
  const last = useRef(hex);
  if (hex.toLowerCase() !== last.current.toLowerCase()) {
    // typed in the hex or RGB fields: follow it (keeping the hue of a grey)
    last.current = hex;
    const next = hexToHsv(hex);
    if (next[1] === 0 || next[2] === 0) next[0] = hsv[0];
    setHsv(next);
  }
  const put = (h: number, sat: number, v: number) => {
    setHsv([h, sat, v]);
    const out = hsvToHex(h, sat, v);
    last.current = out;
    onChange(out);
  };
  const drag = (el: HTMLElement, e: RPointerEvent, fn: (x: number, y: number) => void) => {
    const at = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      fn(Math.max(0, Math.min(1, (cx - r.left) / r.width)), Math.max(0, Math.min(1, (cy - r.top) / r.height)));
    };
    at(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => at(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [h, sat, v] = hsv;
  return (
    <>
      <div
        className="dk-cp-sv"
        role="slider"
        aria-label="Saturation and brightness"
        aria-valuetext={hex}
        style={{
          background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${hsvToHex(h, 1, 1)})`,
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          drag(e.currentTarget, e, (x, y) => put(h, x, 1 - y));
        }}
      >
        <span style={{ left: `${sat * 100}%`, top: `${(1 - v) * 100}%`, background: hex }} />
      </div>
      <div
        className="dk-cp-hue"
        role="slider"
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            put((h + (e.key === 'ArrowLeft' ? 355 : 5)) % 360, sat, v);
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          drag(e.currentTarget, e, (x) => put(Math.min(359.9, x * 360), sat, v));
        }}
      >
        <span style={{ left: `${(h / 360) * 100}%`, background: hsvToHex(h, 1, 1) }} />
      </div>
    </>
  );
}

/** The green (or amber) box that says how readable a colour is on this page. */
function ContrastNote({ check }: { check: { ok: boolean; message: string } }) {
  return (
    <div className={`dk-cp-contrast${check.ok ? '' : ' dk-cp-warn'}`} role="status" data-testid="color-contrast">
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {check.ok ? <path d="M5 12.5L10 17.5L19 7" /> : <path d="M12 3.5L22 20H2ZM12 10V14M12 17.2V17.3" />}
      </svg>
      <span>{check.message}</span>
    </div>
  );
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
        <HsvPicker hex={hex ?? '#2e6f40'} onChange={(h) => setCustom(h)} />
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
        {check && <ContrastNote check={check} />}
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
  // the custom box shows the colour in hand, else the kind's first colour (green text, yellow highlight)
  const shownHex = (
    currentHex ?? (kind === 'text' ? '#2E6F40' : (hexOf('highlight', 'yellow', pageHex) ?? '#FFE9A8'))
  ).toUpperCase();
  const openCustom = () => setCustom(shownHex.toLowerCase());
  const shownCheck = kind === 'text' && currentHex ? checkContrast(currentHex, pageHex) : null;
  const Dropper = eyeDropper();

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
            <span className="dk-cp-chip" style={{ background: shownHex }} />
            {shownHex}
          </button>
          <button
            type="button"
            className="dk-cp-drop"
            aria-label="Pick a colour from the screen"
            title={Dropper ? 'Pick a colour from the screen' : 'Your browser cannot pick from the screen'}
            disabled={!Dropper}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!Dropper) return;
              new Dropper()
                .open()
                .then((r) => {
                  const hex = normalizeHex(r.sRGBHex);
                  if (hex) setCustom(hex);
                })
                .catch(() => {});
            }}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14.5 6.5l3 3M4 20l1-4 9.5-9.5 3 3L8 19zM16 5l1.5-1.5a2.1 2.1 0 0 1 3 3L19 8" />
            </svg>
          </button>
        </div>
        {shownCheck && <ContrastNote check={shownCheck} />}
      </div>
    </div>
  );
}
