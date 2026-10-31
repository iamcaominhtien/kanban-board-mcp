import { useEffect, useRef } from 'react';
import { useAiAccounts } from '../../api/aiAccounts';
import type { AiMember } from '../../types/ai';
import type { AccountStatus } from '../../types/aiAccounts';
import { accountEvents, eventCopy } from '../../utils/memberAccount';
import { useToast } from '../Toast';

/**
 * One toast per account when it goes signed out, and one when it is signed in again (with how many held runs
 * restart), not one per member (design E3). The first poll only records, so opening the app never replays old news.
 * “Sign in again” opens the AI accounts tab, where the same window as adding an account is one click away.
 */
export function useAccountNotifications(projectId: string, members: AiMember[] | undefined, openAccounts: () => void) {
  const toast = useToast();
  const accounts = useAiAccounts(projectId || undefined);
  const seen = useRef<Map<string, AccountStatus> | undefined>(undefined);
  // Queued runs held per account, kept fresh while it is signed out
  const held = useRef<Map<string, number>>(new Map());
  const list = accounts.data?.accounts;

  useEffect(() => {
    if (!list) return;
    for (const a of list) {
      if (a.status === 'needs_sign_in') {
        const n = (members ?? []).filter((m) => m.accountId === a.id).reduce((sum, m) => sum + m.queued, 0);
        held.current.set(a.id, Math.max(n, held.current.get(a.id) ?? 0));
      }
    }
    for (const e of accountEvents(seen.current, list, held.current)) {
      const copy = eventCopy(e);
      if (e.kind === 'signed_out')
        toast.showToast({
          variant: 'warning',
          title: copy.title,
          message: copy.message,
          duration: 12000,
          action: { label: 'Sign in again', onClick: openAccounts },
        });
      else {
        toast.success(copy.title, copy.message, 8000);
        held.current.delete(e.account.id);
      }
    }
    seen.current = new Map(list.map((a) => [a.id, a.status]));
  }, [list, members, toast, openAccounts]);
}
