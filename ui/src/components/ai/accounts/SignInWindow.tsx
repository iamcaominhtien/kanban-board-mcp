import type { AiAccount } from '../../../types/aiAccounts';

/** The sign-in window of an existing account: a real terminal and a status bar (design C2, C2b, C3). Used by
 * "Sign in again" everywhere, and as step 3 of Add an AI account. */
export function SignInWindow(_props: {
  account: AiAccount;
  /** `signed_in` when the CLI confirmed it; `closed` when the person stopped or closed the window. */
  onClose: (result: 'signed_in' | 'closed') => void;
}) {
  return null; // replaced by the real window
}
