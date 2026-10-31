import { useEffect, type ReactNode } from 'react';
import type { AccountCli } from '../../../types/aiAccounts';
import { CLI_BADGE } from '../../../utils/accountList';
import './accounts.css';

/** One stroke icon of the design (24 × 24 grid, 1.7 stroke). */
export function AccIcon({ paths, size = 14, children }: { paths: string[]; size?: number; children?: ReactNode }) {
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
      {children}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const ICONS = {
  plus: ['M12 5v14M5 12h14'],
  refresh: ['M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  rename: ['M4 20h4L19 9l-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  people: ['M3 20c0-3.5 3-6 6-6s6 2.5 6 6M16 5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3 2.6 3 5'],
  lock: ['M8 11V8a4 4 0 0 1 8 0v3'],
  trash: ['M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6'],
  warn: ['M12 4l9 16H3L12 4z', 'M12 10v4M12 17v.5'],
  info: ['M12 11v5M12 8h.01'],
  close: ['M6 6l12 12M18 6L6 18'],
} as const;

/** The two-letter badge of a CLI (CC, CX, OC, AG), in its colour. */
export function AccountBadge({ cli, label, size = 30 }: { cli: AccountCli; label: string; size?: number }) {
  const b = CLI_BADGE[cli];
  return (
    <span
      className="acc-badge"
      title={label}
      style={{
        width: size,
        height: size,
        background: b.bg,
        color: b.color,
        borderColor: b.color,
        fontSize: size > 24 ? 10 : 7,
        borderRadius: size > 24 ? 9 : 6,
      }}
    >
      {b.short}
    </span>
  );
}

/** A coloured notice with a title, a sentence and optional buttons (signed out, signing in, web build, CLI not found). */
export function AccountNote({
  tone,
  title,
  children,
  actions,
  testId,
}: {
  tone: 'bad' | 'info' | 'warn';
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div className={`acc-note acc-note-${tone}`} role={tone === 'bad' ? 'alert' : 'status'} data-testid={testId}>
      <span className="acc-note-icon">
        {tone === 'info' ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d={ICONS.info[0]} />
          </svg>
        ) : (
          <AccIcon paths={[...ICONS.warn]} size={16} />
        )}
      </span>
      <div className="acc-note-main">
        <span className="acc-note-title">{title}</span>
        <span className="acc-note-body">{children}</span>
        {actions && <div className="acc-note-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** The dialog shell of the design: a title with a close button, a body and a footer. Esc and a click outside close it. */
export function AccountDialog({
  title,
  narrow,
  onClose,
  body,
  foot,
}: {
  title: string;
  narrow?: boolean;
  onClose: () => void;
  body: ReactNode;
  foot: ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="ai-overlay ai-root" onMouseDown={onClose}>
      <div
        className={`acc-dlg ${narrow ? 'acc-dlg-narrow' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="acc-dlg-head">
          <h2 className="acc-dlg-title">{title}</h2>
          <button type="button" className="ai-icobtn" aria-label="Close" onClick={onClose}>
            <AccIcon paths={[...ICONS.close]} size={15} />
          </button>
        </div>
        <div className="acc-dlg-body">{body}</div>
        <div className="acc-dlg-foot">{foot}</div>
      </div>
    </div>
  );
}
