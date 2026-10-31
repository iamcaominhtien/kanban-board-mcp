import { useState } from 'react';
import { useAccountActions } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AiAccount, RemoveMembersPolicy } from '../../../types/aiAccounts';
import { cantRunClause, namesList, otherAccounts, otherHint, removeReady, usersOf } from '../../../utils/accountList';
import { AccountDialog } from './AccountParts';

const CHOICES: { policy: RemoveMembersPolicy; title: string; hint: string }[] = [
  {
    policy: 'login',
    title: 'Use the login already on this computer',
    hint: ' as before; they keep working if that login is signed in',
  },
  { policy: 'other', title: 'Pick another account for them', hint: '' },
  { policy: 'none', title: 'Leave them without an account', hint: ' they stop until you choose one' },
];

/** “Remove <account>?”: asks what happens to the AI members that use it, so none is left half connected (design B2). */
export function RemoveAccountDialog({
  account,
  accounts,
  onClose,
}: {
  account: AiAccount;
  accounts: AiAccount[];
  onClose: () => void;
}) {
  const actions = useAccountActions();
  const users = usersOf(account);
  const others = otherAccounts(account, accounts);
  const [policy, setPolicy] = useState<RemoveMembersPolicy>('login');
  const [otherId, setOtherId] = useState<string | null>(others[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const names = [...new Map(users.map((u) => [u.id, u])).values()];

  const remove = async () => {
    setError(null);
    try {
      await actions.remove.mutateAsync([account.id, policy, policy === 'other' ? (otherId ?? undefined) : undefined]);
      onClose();
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <AccountDialog
      title={`Remove ${account.name}?`}
      narrow={!users.length}
      onClose={onClose}
      body={
        users.length ? (
          <>
            <div>
              {names.length} AI member{names.length === 1 ? '' : 's'} use{names.length === 1 ? 's' : ''} this account:{' '}
              {names.map((u, i) => (
                <span key={u.id}>
                  {i > 0 && ', '}
                  <b>{u.name}</b>
                </span>
              ))}
              . Choose what happens to {names.length === 1 ? 'it' : 'them'}.
            </div>
            {CHOICES.map((c) => {
              const disabled = c.policy === 'other' && !others.length;
              const on = policy === c.policy;
              return (
                <button
                  key={c.policy}
                  type="button"
                  className={`acc-choice ${on ? 'acc-choice-on' : ''}`}
                  role="radio"
                  aria-checked={on}
                  disabled={disabled}
                  onClick={() => setPolicy(c.policy)}
                >
                  <span className="acc-radio">{on && <i />}</span>
                  <span>
                    <b>{c.title}</b>
                    <span className="acc-hint">
                      {c.policy === 'other'
                        ? ` ${otherHint(others.find((o) => o.id === otherId) ?? others[0])}`
                        : c.hint}
                    </span>
                  </span>
                </button>
              );
            })}
            {policy === 'other' && others.length > 1 && (
              <select
                className="ai-select"
                aria-label="Account for these members"
                value={otherId ?? ''}
                onChange={(e) => setOtherId(e.target.value)}
              >
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {otherHint(o)}
                  </option>
                ))}
              </select>
            )}
            {policy === 'none' && <div className="acc-hint">{cantRunClause(account, 'until you choose one')}</div>}
            <div className="acc-hint">
              Removing signs the CLI out for this account and deletes its saved login (its folder, and for Claude Code
              on macOS its keychain entry). Tickets, runs and history are kept.
            </div>
            {names.length > 3 && <div className="acc-hint">Members: {namesList(users, 99)}.</div>}
          </>
        ) : (
          <div>No AI member uses it. Its saved sign-in is deleted from this computer. You can add it again later.</div>
        )
      }
      foot={
        <>
          <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          {error && <span className="ai-error-text">{error}</span>}
          <button
            type="button"
            className="ai-btn ai-btn-danger ai-btn-sm"
            disabled={actions.remove.isPending || !removeReady(account, policy, otherId, accounts)}
            onClick={() => void remove()}
          >
            Remove account
          </button>
        </>
      }
    />
  );
}
