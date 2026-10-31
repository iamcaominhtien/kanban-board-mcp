import { useState } from 'react';
import { useAccountActions } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AiAccount } from '../../../types/aiAccounts';
import { cantRunClause } from '../../../utils/accountList';
import { AccountDialog } from './AccountParts';

/** “Sign out <account>?”: the CLI forgets the login, the account stays in the list (design B2). */
export function SignOutDialog({ account, onClose }: { account: AiAccount; onClose: () => void }) {
  const actions = useAccountActions();
  const [error, setError] = useState<string | null>(null);
  const clause = cantRunClause(account, 'until someone signs in again');
  return (
    <AccountDialog
      title={`Sign out ${account.name}?`}
      narrow
      onClose={onClose}
      body={
        <>
          <div>The CLI forgets this account. {clause && `${clause} `}The account stays in the list.</div>
          {error && <div className="ai-error-text">{error}</div>}
        </>
      }
      foot={
        <>
          <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ai-btn ai-btn-danger ai-btn-sm"
            disabled={actions.signOut.isPending}
            onClick={async () => {
              setError(null);
              try {
                await actions.signOut.mutateAsync([account.id]);
                onClose();
              } catch (e) {
                setError(extractError(e));
              }
            }}
          >
            Sign out
          </button>
        </>
      }
    />
  );
}
