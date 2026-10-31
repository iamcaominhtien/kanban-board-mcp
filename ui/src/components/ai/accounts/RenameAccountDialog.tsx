import { useState } from 'react';
import { accountsApi, useAccountActions } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AiAccount } from '../../../types/aiAccounts';
import { nameProblem } from '../../../utils/accountList';
import { AccountDialog } from './AccountParts';

/** Rename an account. Names are unique per computer; a taken name is said here, without leaving the dialog. */
export function RenameAccountDialog({
  account,
  accounts,
  onClose,
}: {
  account: AiAccount;
  accounts: AiAccount[];
  onClose: () => void;
}) {
  const actions = useAccountActions();
  const [name, setName] = useState(account.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clean = name.split(/\s+/).filter(Boolean).join(' ');

  const save = async () => {
    const problem = nameProblem(clean, accounts, account.id);
    if (problem) return setError(problem);
    if (clean === account.name) return onClose();
    setBusy(true);
    setError(null);
    try {
      const free = await accountsApi.nameCheck(clean);
      if (!free.ok) return setError(free.message ?? 'An account with this name exists.');
      await actions.rename.mutateAsync([account.id, clean]);
      onClose();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccountDialog
      title={`Rename ${account.name}`}
      narrow
      onClose={onClose}
      body={
        <label className="ai-field">
          <span className="ai-label ai-label-dark">Name</span>
          <input
            className={`ai-input ${error ? 'ai-input-error' : ''}`}
            value={name}
            maxLength={60}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
          {error ? (
            <span className="ai-error-text">{error}</span>
          ) : (
            <span className="acc-hint">
              Shown when you pick an account for an AI member. Use the person or plan, not a secret.
            </span>
          )}
        </label>
      }
      foot={
        <>
          <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" disabled={busy} onClick={() => void save()}>
            Rename
          </button>
        </>
      }
    />
  );
}
