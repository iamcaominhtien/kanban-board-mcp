import type { UsageWindow } from '../../../types/aiWindows';
import { reopensText, usedPct, usedText, windowTone } from './windowFormat';

const COLOR = { unknown: '#9AA8A0', ok: '#2E6F40', warn: '#B4791E', full: '#C4432A' } as const;

/** One window of an account: a bar, "92% used" and when it reopens. Grey and "not known" when nothing was read. */
export function WindowBar({ label, window: w, nowMs }: { label: string; window: UsageWindow; nowMs: number }) {
  const tone = windowTone(w.used);
  const reopens = reopensText(w, nowMs);
  return (
    <div className="win-bar-wrap" data-testid={`win-bar-${label}`} data-tone={tone}>
      <div className="win-bar-line">
        <span className="win-bar-label">{label}</span>
        <div
          className="win-bar"
          role="progressbar"
          aria-label={`${label} window`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={w.used == null ? undefined : usedPct(w.used)}
          aria-valuetext={usedText(w.used)}
        >
          <i style={{ width: `${usedPct(w.used)}%`, background: COLOR[tone] }} />
        </div>
        <span className="win-bar-pct" style={{ color: COLOR[tone] }}>
          {usedText(w.used)}
        </span>
      </div>
      {reopens && <div className="acc-hint win-bar-sub">{reopens}</div>}
    </div>
  );
}
