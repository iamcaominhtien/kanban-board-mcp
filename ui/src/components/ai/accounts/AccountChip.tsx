import type { AccountStatus } from '../../../types/aiAccounts';
import { accountChip } from '../../../utils/memberAccount';
import './accountsMember.css';

/** A small pill: "Signed in", "Needs sign-in", "Signing in" or "CLI not installed" (design B1, D). */
export function AccountStatusChip({ status }: { status: AccountStatus }) {
  const look = accountChip(status);
  return (
    <span className="acm-chip" style={{ background: look.bg, color: look.color }} data-status={status}>
      {look.dot && <span className="acm-chip-dot" style={{ background: look.dot }} />}
      {look.label}
    </span>
  );
}

/** A neutral pill ("as before", "no login", "not installed", "2 accounts"). */
export function GreyChip({ children }: { children: React.ReactNode }) {
  return <span className="acm-chip">{children}</span>;
}

/** The amber "Not ready" pill of a type whose runs do not start yet. */
export function NotReadyChip() {
  return (
    <span className="acm-chip" style={{ background: '#FEF3D9', color: '#7A5A06' }} data-testid="not-ready-chip">
      Not ready
    </span>
  );
}
