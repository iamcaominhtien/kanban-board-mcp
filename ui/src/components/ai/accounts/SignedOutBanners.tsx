import { useState } from 'react';
import { useAiAccounts } from '../../../api/aiAccounts';
import type { AiMember } from '../../../types/ai';
import type { AiAccount } from '../../../types/aiAccounts';
import { bannerCopy, blockedAccounts } from '../../../utils/memberAccount';
import { AccountBanner } from './AccountBanner';
import { ChangeAccountDialog } from './AccountPicker';
import { SignInWindow } from './SignInWindow';

/**
 * One banner per signed-out account among `members`, however many members it hits (design E1, E3): “Sign in again”
 * opens the sign-in window, “Choose another account” moves those members. Renders nothing while every account works.
 */
export function SignedOutBanners({ projectId, members }: { projectId: string; members: AiMember[] }) {
  const accounts = useAiAccounts(projectId);
  const [signingIn, setSigningIn] = useState<AiAccount | null>(null);
  const [moving, setMoving] = useState<AiMember[] | null>(null);
  const blocked = blockedAccounts(members);
  return (
    <>
      {blocked.map((b) => {
        const copy = bannerCopy(b);
        return (
          <AccountBanner
            key={b.account.id}
            title={copy.title}
            text={copy.text}
            onSignIn={() => {
              const full = accounts.data?.accounts.find((a) => a.id === b.account.id);
              if (full) setSigningIn(full);
            }}
            onChoose={() => setMoving(b.members)}
          />
        );
      })}
      {signingIn && <SignInWindow account={signingIn} onClose={() => setSigningIn(null)} />}
      {moving && <ChangeAccountDialog members={moving} onClose={() => setMoving(null)} />}
    </>
  );
}

/**
 * “Sign in again” for the account of one AI member, with the sign-in window it opens. Renders nothing when the
 * member's account works, so it can sit next to Retry on a failed run.
 */
export function SignInAgainButton({ member, primary }: { member: AiMember; primary?: boolean }) {
  const accounts = useAiAccounts(member.projectId);
  const [open, setOpen] = useState(false);
  const full = accounts.data?.accounts.find((a) => a.id === member.accountId);
  if (member.accountRef?.status !== 'needs_sign_in' || !full) return null;
  return (
    <>
      <button
        type="button"
        className={`ai-btn ai-btn-sm ${primary ? 'ai-btn-primary' : ''}`}
        onClick={() => setOpen(true)}
        data-testid="run-sign-in-again"
      >
        Sign in again
      </button>
      {open && <SignInWindow account={full} onClose={() => setOpen(false)} />}
    </>
  );
}
