import type { ReactNode } from 'react';
import './accountsMember.css';

const INFO = 'M12 8V8.01M11 12H12V16H13M12 21A9 9 0 1 0 12 3A9 9 0 0 0 12 21Z';
const ALERT =
  'M12 9V13M12 17V17.01M10.3 4L2.6 17.5A2 2 0 0 0 4.3 20.5H19.7A2 2 0 0 0 21.4 17.5L13.7 4A2 2 0 0 0 10.3 4Z';

/** The design's boxed notice: a title, a line of text and optional buttons. Blue is information, red is a
 * signed-out account, amber is a warning. */
export function AccountNote({
  tone = 'info',
  title,
  children,
  actions,
  testId,
}: {
  tone?: 'info' | 'error' | 'warn';
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div className={`acm-note ${tone === 'info' ? '' : `acm-note-${tone}`}`} data-testid={testId} role="note">
      <span className="acm-note-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d={tone === 'error' ? ALERT : INFO} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="acm-note-body">
        <span className="acm-note-title">{title}</span>
        {children && <span className="acm-note-text">{children}</span>}
        {actions && <div className="acm-note-actions">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * Banner above the AI list for one signed-out account (design E1): one banner however many members it hits, with
 * the two ways out.
 */
export function AccountBanner({
  title,
  text,
  onSignIn,
  onChoose,
  busy,
}: {
  title: string;
  text: string;
  onSignIn: () => void;
  onChoose: () => void;
  busy?: boolean;
}) {
  return (
    <div className="acm-banner" data-testid="account-banner">
      <AccountNote
        tone="error"
        title={title}
        actions={
          <>
            <button type="button" className="ai-btn ai-btn-sm ai-btn-primary" onClick={onSignIn} disabled={busy}>
              Sign in again
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={onChoose}>
              Choose another account
            </button>
          </>
        }
      >
        {text}
      </AccountNote>
    </div>
  );
}
