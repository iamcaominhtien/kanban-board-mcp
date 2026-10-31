import type { AiAccount } from '../../../types/aiAccounts';
import {
  addedOn,
  menuItems,
  signInOffReason,
  signedInWith,
  statusView,
  usersOf,
  type MenuAction,
} from '../../../utils/accountList';
import { AccIcon, AccountBadge, ICONS } from './AccountParts';

/** The icon of each row-menu item (design B2). */
function MenuIcon({ action }: { action: MenuAction }) {
  switch (action) {
    case 'sign_in':
      return <AccIcon paths={[...ICONS.refresh]} />;
    case 'check':
      return <AccIcon paths={[...ICONS.check]} />;
    case 'rename':
      return <AccIcon paths={[...ICONS.rename]} />;
    case 'members':
      return (
        <AccIcon paths={[...ICONS.people]}>
          <circle cx="9" cy="8" r="3.5" />
        </AccIcon>
      );
    case 'sign_out':
      return (
        <AccIcon paths={[...ICONS.lock]}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
        </AccIcon>
      );
    case 'remove':
      return <AccIcon paths={[...ICONS.trash]} />;
  }
}

/** One account in the list: name and CLI, what it is signed in with, status, members, and its buttons (design B1). */
export function AccountRow({
  account,
  checking,
  desktop,
  menuOpen,
  nowMs,
  onMenu,
  onAction,
}: {
  account: AiAccount;
  checking: boolean;
  desktop: boolean;
  menuOpen: boolean;
  nowMs: number;
  onMenu: () => void;
  onAction: (action: MenuAction) => void;
}) {
  const status = statusView(account, checking, nowMs);
  const who = signedInWith(account);
  const members = new Set(usersOf(account).map((u) => u.id)).size;
  const needsSignIn = account.status === 'needs_sign_in' || account.status === 'signing_in';
  const signInOff = signInOffReason(account, desktop);
  return (
    <div className="acc-grid" role="row" data-testid={`account-row-${account.name}`}>
      <div className="acc-name">
        <AccountBadge cli={account.cli} label={account.cliLabel} />
        <div style={{ minWidth: 0 }}>
          <b>{account.name}</b>
          <div className="acc-sub">Added {addedOn(account.createdAt)}</div>
        </div>
      </div>
      <div>{account.cliLabel}</div>
      <div>
        <div>{who.primary}</div>
        {who.secondary && <div className="acc-sub">{who.secondary}</div>}
      </div>
      <div>
        <span className="ai-chip" style={{ background: status.bg, color: status.color }}>
          {status.key === 'checking' ? (
            <span className="ai-spin" style={{ width: 9, height: 9, borderWidth: 1.5 }} />
          ) : (
            <span className="acc-dot" style={{ background: status.dot }} />
          )}
          {status.label}
        </span>
        {status.sub && (
          <div
            className={`acc-sub ${status.subTone === 'bad' ? 'acc-sub-bad' : status.subTone === 'warn' ? 'acc-sub-warn' : ''}`}
          >
            {status.sub}
          </div>
        )}
      </div>
      <div>
        {members ? (
          <>
            <b>{members}</b> member{members === 1 ? '' : 's'}
          </>
        ) : (
          <span className="acc-sub">No members</span>
        )}
      </div>
      <div className="acc-actions">
        {needsSignIn ? (
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={!!signInOff}
            title={signInOff ?? undefined}
            onClick={() => onAction('sign_in')}
          >
            <AccIcon paths={[...ICONS.refresh]} size={13} />
            Sign in again
          </button>
        ) : (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={!desktop || checking}
            title={
              desktop ? undefined : 'AI accounts need the desktop app. Signing in runs a terminal on your computer.'
            }
            onClick={() => onAction('check')}
          >
            <AccIcon paths={[...ICONS.refresh]} size={13} />
            Check now
          </button>
        )}
        <button
          type="button"
          className="ai-icobtn"
          aria-label={`More actions for ${account.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <circle cx="5" cy="12" r="1.3" />
            <circle cx="12" cy="12" r="1.3" />
            <circle cx="19" cy="12" r="1.3" />
          </svg>
        </button>
        {menuOpen && (
          <div className="ai-menu acc-menu" role="menu">
            {menuItems(account, desktop).map((item) => (
              <div key={item.action}>
                {item.divider && <div className="ai-divider" style={{ margin: '4px 2px' }} />}
                <button
                  type="button"
                  role="menuitem"
                  className={`ai-mi ${item.danger ? 'ai-mi-danger' : ''}`}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => onAction(item.action)}
                >
                  <MenuIcon action={item.action} />
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
