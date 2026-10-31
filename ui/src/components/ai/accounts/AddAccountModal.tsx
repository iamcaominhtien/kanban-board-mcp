import type { AccountCli, AiAccount } from '../../../types/aiAccounts';

/** Add an AI account in three steps: CLI, name, sign in (design/screens/ai-accounts.md, C1). */
export function AddAccountModal(_props: {
  /** Start at the name step for this CLI (opened from "New account…" in the Add AI member window). */
  initialCli?: AccountCli;
  onClose: () => void;
  /** The account exists (made at the end of the name step), signed in or not. */
  onCreated?: (account: AiAccount) => void;
}) {
  return null; // replaced by the real window
}
