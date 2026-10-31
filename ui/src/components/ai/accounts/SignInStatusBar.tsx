import type { ReactNode } from 'react';
import { KEY_LABELS, type Dot, type KeyName, type Segments, type Tone } from '../../../utils/signInCopy';

const ICONS: Record<Tone, ReactNode> = {
  // clock: the app or the browser is working
  blue: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  // hand: your turn
  amber: (
    <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2 6-5 6-3 0-4-1.5-5.5-4L4 12a1.5 1.5 0 0 1 2.5-1.5L8 12" />
  ),
  green: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  red: (
    <>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
};

/** The small icons of the sign-in buttons (same drawing style as the rest of the AI screens). */
export function Icon({ d, size = 13 }: { d: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {d}
    </svg>
  );
}

export const ICON_PATHS = {
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  paste: (
    <>
      <rect x="6" y="5" width="12" height="16" rx="2" />
      <path d="M9 5V4h6v1M9 11h6M9 15h4" />
    </>
  ),
  refresh: <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
};

/** The step dots: only the steps that apply to the CLI; the current one is bold. */
export function SignInDots({ dots }: { dots: Dot[] }) {
  return (
    <div className="sg-dots" data-testid="sign-in-dots">
      {dots.map((d, i) => (
        <span key={d.label} style={{ display: 'contents' }}>
          {i > 0 && <span className="sg-dot-line" />}
          <span className={`sg-dot ${d.filled ? 'sg-dot-filled' : ''} ${d.current ? 'sg-dot-now' : ''}`}>
            <i />
            {d.label}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * The one sentence above the terminal: what is happening and, in amber, when it is the person's turn. Blue means the
 * app or the browser is working, green done, red something went wrong. A best-effort reading of the CLI, never a
 * claim the terminal does not back up. `actions` are the few buttons that help right now.
 */
export function SignInStatusBar({
  tone,
  title,
  body,
  actions,
  spinning,
}: {
  tone: Tone;
  title: string;
  body: Segments;
  actions?: ReactNode;
  /** Turn the clock while the app is working. */
  spinning?: boolean;
}) {
  return (
    <div
      className={`sg-status sg-tone-${tone}`}
      role="status"
      aria-live="polite"
      data-testid="sign-in-status"
      data-tone={tone}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={spinning && tone === 'blue' ? 'sg-spin' : undefined}
      >
        {ICONS[tone]}
      </svg>
      <div className="sg-status-text">
        <div className="sg-status-title">{title}</div>
        <div className="sg-status-body">
          {body.map((s, i) => (typeof s === 'string' ? <span key={i}>{s}</span> : <b key={i}>{s.b}</b>))}
        </div>
      </div>
      {actions && <div className="sg-status-actions">{actions}</div>}
    </div>
  );
}

/** Arrow keys, Enter and Esc for people unused to terminal prompts: each sends what they could type. */
export function SignInKeyRow({ keys, onKey }: { keys: KeyName[]; onKey: (key: KeyName) => void }) {
  if (!keys.length) return null;
  return (
    <div className="sg-keys" data-testid="sign-in-keys">
      <span className="sg-note">Send a key:</span>
      {keys.map((k) => (
        <button key={k} type="button" className="sg-key" onClick={() => onKey(k)} aria-label={`Send ${KEY_LABELS[k]}`}>
          {KEY_LABELS[k]}
        </button>
      ))}
    </div>
  );
}
