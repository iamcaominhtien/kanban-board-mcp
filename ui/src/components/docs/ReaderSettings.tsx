/**
 * The "Aa" reader settings (design board "Rich Docs — reading", frames 13-20): a popover on a desktop or a tablet,
 * a bottom sheet on a phone. Changes apply at once and stay on this device (readerPrefs.ts).
 */

import { useEffect, useRef } from 'react';
import { Switch } from '../settings/settingsUi';
import {
  READER_SIZE_MAX,
  READER_SIZE_MIN,
  READER_SIZE_STEPS,
  readerSizeLabel,
  type ReaderFont,
  type ReaderPrefs,
  type ReaderTheme,
  type ReaderWidth,
} from './readerPrefs';
import './reader.css';

const FONT_CHOICES: readonly { value: ReaderFont; label: string }[] = [
  { value: 'page', label: 'Page' },
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans' },
];
const WIDTH_CHOICES: readonly { value: ReaderWidth; label: string }[] = [
  { value: 'page', label: 'Page' },
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
];
const THEME_CHOICES: readonly { value: ReaderTheme; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'night', label: 'Night' },
];

interface PanelProps {
  prefs: ReaderPrefs;
  /** A patch of preferences, or `null` for Reset. */
  onChange: (patch: Partial<ReaderPrefs> | null) => void;
  /** The page's own body size in CSS pixels (shown while the reader keeps it). */
  pagePx: number;
}

function Segmented<T extends string>({
  label,
  value,
  choices,
  onPick,
}: {
  label: string;
  value: T;
  choices: readonly { value: T; label: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="dk-rs-row">
      <span className="dk-rs-label">{label}</span>
      <div className="dk-seg" role="group" aria-label={label}>
        {choices.map((c) => (
          <button key={c.value} type="button" aria-pressed={value === c.value} onClick={() => onPick(c.value)}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The reader settings themselves (inside the popover or the sheet).
 * @param props.prefs - The reader's preferences.
 * @param props.onChange - Called with a patch, or `null` to reset them.
 * @param props.pagePx - The page's own body text size.
 */
export function ReaderSettingsPanel({ prefs, onChange, pagePx }: PanelProps) {
  const size = prefs.size ?? pagePx;
  return (
    <div className="dk-rs" data-testid="reader-settings">
      <div className="dk-rs-head">
        <span className="dk-rs-title">Reading</span>
        <button type="button" className="dk-rs-reset" onClick={() => onChange(null)} data-testid="reader-reset">
          Reset
        </button>
      </div>
      <div className="dk-rs-row">
        <span className="dk-rs-label">
          Text size <span className="dk-rs-value">{readerSizeLabel(prefs, Math.round(pagePx))}</span>
        </span>
        <div className="dk-seg" role="group" aria-label="Text size">
          {READER_SIZE_STEPS.map((s, i) => (
            <button
              key={s.px}
              type="button"
              aria-pressed={prefs.size === s.px}
              aria-label={`${s.label} · ${s.px} px`}
              title={`${s.label} · ${s.px} px`}
              onClick={() => onChange({ size: s.px })}
              style={{ fontSize: 11 + i * 2 }}
            >
              A
            </button>
          ))}
        </div>
        <input
          type="range"
          className="dk-rs-slider"
          aria-label="Text size in pixels"
          min={READER_SIZE_MIN}
          max={READER_SIZE_MAX}
          step={1}
          value={Math.round(size)}
          onChange={(e) => onChange({ size: Number(e.target.value) })}
        />
      </div>
      <Segmented label="Font" value={prefs.font} choices={FONT_CHOICES} onPick={(font) => onChange({ font })} />
      <Segmented
        label="Line width"
        value={prefs.width}
        choices={WIDTH_CHOICES}
        onPick={(width) => onChange({ width })}
      />
      <div className="dk-rs-row">
        <span className="dk-rs-label">Theme</span>
        <div className="dk-rs-themes" role="group" aria-label="Theme">
          {THEME_CHOICES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`dk-rs-theme dk-rs-theme-${t.value}`}
              aria-pressed={prefs.theme === t.value}
              onClick={() => onChange({ theme: t.value })}
              data-testid={`reader-theme-${t.value}`}
            >
              <span className="dk-rs-swatch" aria-hidden="true">
                Aa
              </span>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dk-rs-switch">
        <span>
          <b>Justify text</b>
          <span>Even edges on both sides.</span>
        </span>
        <Switch
          on={prefs.justify}
          label="Justify text"
          testId="reader-justify"
          onChange={(justify) => onChange({ justify })}
        />
      </div>
      <p className="dk-rs-note">
        Only for you, on this device. “Page” keeps the fonts and width the author chose. Sepia and Night are not
        printed.
      </p>
    </div>
  );
}

/**
 * The reader settings as a popover under the "Aa" button; it closes on Escape or a click outside.
 * @param props.onClose - Called to close it.
 */
export function ReaderSettingsPopover({ onClose, ...panel }: PanelProps & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="dk-menu docs-root dk-rs-pop" role="dialog" aria-label="Reading settings" data-popover>
      <ReaderSettingsPanel {...panel} />
    </div>
  );
}

/** The "Aa" glyph of the reader settings button. */
export function AaGlyph() {
  return (
    <span aria-hidden="true" className="dk-aa">
      A<small>a</small>
    </span>
  );
}
