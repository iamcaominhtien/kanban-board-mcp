import { useState } from 'react';
import { accountKeys, useAccountActions, useAiAccounts, useComputerLogins } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AiMember, AiProvider } from '../../../types/ai';
import type { AiAccount } from '../../../types/aiAccounts';
import { CLI_OF_PROVIDER, accountReady, accountSub, accountsFor, sharedHint } from '../../../utils/memberAccount';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../Toast';
import { PROVIDERS } from '../aiUi';
import { AddAccountModal } from './AddAccountModal';
import { AccountNote } from './AccountBanner';
import { AccountStatusChip, GreyChip } from './AccountChip';
import { SignInWindow } from './SignInWindow';
import './accountsMember.css';

function Radio({ on }: { on: boolean }) {
  return <span className="acm-radio">{on && <i />}</span>;
}

/**
 * “Which account should this AI member use?” (design D2–D6): the accounts of the member type's CLI, the login that
 * is already on this computer (kept last, as before; for opencode the free models), and “New account…”, which opens
 * the same window as Add an account. A signed-out choice offers “Sign in again” and, while it is chosen, the parent
 * keeps Next off (`accountReady`). `value` is an account id, or null for the CLI's own login.
 */
export function AccountPicker({
  provider,
  value,
  onChange,
  projectId,
  currentAccountId,
}: {
  provider: AiProvider;
  value: string | null;
  onChange: (accountId: string | null, account: AiAccount | null) => void;
  /** Splits “members using it” into this project and others. */
  projectId?: string;
  /** The account the edited member already runs as, so it is not counted twice as a sharer. */
  currentAccountId?: string | null;
}) {
  const accounts = useAiAccounts(projectId);
  const logins = useComputerLogins();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [signing, setSigning] = useState<AiAccount | null>(null);
  const spec = PROVIDERS[provider];
  const cli = CLI_OF_PROVIDER[provider];
  const list = accountsFor(accounts.data?.accounts ?? [], provider);
  const chosen = list.find((a) => a.id === value) ?? null;
  const own = logins.data?.find((l) => l.cli === cli);
  const free = provider === 'opencode';
  const hint = chosen ? sharedHint(chosen, chosen.id === currentAccountId) : null;
  const refresh = () => void qc.invalidateQueries({ queryKey: accountKeys.all });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="account-picker">
      <div style={{ fontSize: 12.5, color: '#3A4A3E' }}>Which account should this AI member use?</div>
      <div className="acm-choices" role="radiogroup" aria-label="AI account">
        {free && (
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            className={`acm-choice ${value === null ? 'acm-choice-on' : ''}`}
            onClick={() => onChange(null, null)}
            data-testid="account-choice-none"
          >
            <Radio on={value === null} />
            <div className="acm-choice-main">
              <div className="acm-choice-name">Free models · no account</div>
              <div className="acm-choice-sub">opencode/*-free: no sign-in needed</div>
            </div>
            <GreyChip>no login</GreyChip>
          </button>
        )}
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={value === a.id}
            className={`acm-choice ${value === a.id ? 'acm-choice-on' : ''}`}
            onClick={() => onChange(a.id, a)}
            data-testid={`account-choice-${a.name}`}
          >
            <Radio on={value === a.id} />
            <div className="acm-choice-main">
              <div className="acm-choice-name">{a.name}</div>
              <div className="acm-choice-sub">{accountSub(a, value === a.id)}</div>
            </div>
            <AccountStatusChip status={a.status} />
          </button>
        ))}
        {!free && (
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            className={`acm-choice ${value === null ? 'acm-choice-on' : ''}`}
            onClick={() => onChange(null, null)}
            data-testid="account-choice-none"
          >
            <Radio on={value === null} />
            <div className="acm-choice-main">
              <div className="acm-choice-name">The login already on this computer</div>
              <div className="acm-choice-sub">as before{own?.signedInWith ? ` · ${own.signedInWith}` : ''}</div>
            </div>
            <GreyChip>as before</GreyChip>
          </button>
        )}
        <button type="button" className="acm-new" onClick={() => setAdding(true)} data-testid="account-new">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 5V19M5 12H19" strokeLinecap="round" />
          </svg>
          New account…
        </button>
      </div>

      {hint && (
        <AccountNote title={hint.title} testId="account-shared-hint">
          {hint.text}
        </AccountNote>
      )}
      {!free && list.length === 0 && (
        <AccountNote
          title={`No account for ${spec.label} yet`}
          testId="account-none-yet"
          actions={
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setAdding(true)}>
              Add an account
            </button>
          }
        >
          This AI member will use the login already on this computer, as before. Add an account to share one login
          between members or to keep work and personal apart.
        </AccountNote>
      )}
      {chosen && !accountReady(chosen) && (
        <AccountNote
          tone="error"
          title={
            chosen.status === 'cli_missing'
              ? `The ${spec.binary ?? 'CLI'} CLI was not found for ${chosen.name}`
              : `${chosen.name} is signed out`
          }
          testId="account-signed-out"
          actions={
            chosen.status === 'cli_missing' ? undefined : (
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                disabled={chosen.status === 'signing_in'}
                onClick={() => setSigning(chosen)}
                data-testid="account-sign-in"
              >
                Sign in again
              </button>
            )
          }
        >
          {chosen.status === 'cli_missing'
            ? 'Install it, then detect again. Next stays off until this account works.'
            : chosen.status === 'signing_in'
              ? `${chosen.signingInBy ?? 'Someone'} is signing in. Next stays off until this account works.`
              : 'Pick another account, or sign in again now. Next stays off until this account works.'}
        </AccountNote>
      )}
      {free && value === null && (
        <AccountNote tone="warn" title="Free models may use your prompts" testId="opencode-privacy">
          Some free models (for example Big Pickle, MiMo, Flint) may use prompts to improve the model. Keep confidential
          data out of them; others say they do not train on data. Check the model’s page before you use it.
        </AccountNote>
      )}

      {adding && cli && (
        <AddAccountModal
          initialCli={cli}
          onClose={() => {
            setAdding(false);
            refresh();
          }}
          onCreated={(a) => {
            refresh();
            onChange(a.id, a);
          }}
        />
      )}
      {signing && (
        <SignInWindow
          account={signing}
          onClose={() => {
            setSigning(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Change the account of one or several AI members (profile “Change”, the banner's “Choose another account”): the same
 * list as when creating a member, then Save.
 */
export function ChangeAccountDialog({ members, onClose }: { members: AiMember[]; onClose: () => void }) {
  const first = members[0];
  const [value, setValue] = useState<string | null>(first.accountId);
  const accounts = useAiAccounts(first.projectId);
  const chosen = accounts.data?.accounts.find((a) => a.id === value) ?? null;
  const [error, setError] = useState<string | null>(null);
  const { assign } = useAccountActions();
  const toast = useToast();
  const many = members.length > 1;
  const same = members.every((m) => m.accountId === value);

  async function save() {
    setError(null);
    try {
      for (const m of members) await assign.mutateAsync([m.id, value]);
      toast.success(
        many
          ? `${members.length} AI members moved`
          : `${first.name} now runs as ${chosen?.name ?? 'the login on this computer'}`,
      );
      onClose();
    } catch (err) {
      setError(extractError(err));
    }
  }

  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Choose an account"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">
            {many ? `Choose another account for ${members.length} AI members` : 'Change account'}
          </h2>
          <div className="ai-hint" style={{ marginTop: 3 }}>
            {many ? members.map((m) => m.name).join(', ') : first.name}
          </div>
        </div>
        <div className="ai-modal-body">
          <AccountPicker
            provider={first.provider}
            value={value}
            projectId={first.projectId}
            currentAccountId={many ? undefined : first.accountId}
            onChange={(id) => setValue(id)}
          />
          {error && <div className="ai-error-text">{error}</div>}
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={assign.isPending || same || (!!chosen && !accountReady(chosen))}
            onClick={save}
            data-testid="account-save"
          >
            {assign.isPending && <span className="ai-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
