import { useState } from 'react';
import { accountKeys, useAccountActions, useAiAccounts, useComputerLogins } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AiTeam, AiProvider } from '../../../types/ai';
import type { AiAccount } from '../../../types/aiAccounts';
import {
  CLI_OF_PROVIDER,
  accountReady,
  joinNames,
  accountSub,
  accountsFor,
  profileSub,
  sharedHint,
} from '../../../utils/memberAccount';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../Toast';
import { AddAccountModal } from './AddAccountModal';
import { AccountNote } from './AccountBanner';
import { AccIcon, ICONS } from './AccountParts';
import { AccountStatusChip } from './AccountChip';
import { SignInWindow } from './SignInWindow';
import './accountsMember.css';

function Radio({ on }: { on: boolean }) {
  return <span className="acm-radio">{on && <i />}</span>;
}

/**
 * The accounts of the team type's CLI (design E, frames 28–32), the login that
 * is already on this computer (kept last, as before), and “New account…”, which opens
 * the same window as Add an account. A signed-out choice offers “Sign in again” and, while it is chosen, the parent
 * keeps Next off (`accountReady`). `value` is an account id, or null for the CLI's own login.
 */
export function AccountPicker({
  provider,
  value,
  onChange,
  projectId,
  currentAccountId,
  profile,
}: {
  provider: AiProvider;
  value: string | null;
  onChange: (accountId: string | null, account: AiAccount | null) => void;
  /** Splits “members using it” into this project and others. */
  projectId?: string;
  /** The account the edited member already runs as, so it is not counted twice as a sharer. */
  currentAccountId?: string | null;
  /** On the team page: the chosen account says how many teams share it, and no blue box repeats it (frame 36). */
  profile?: boolean;
}) {
  const accounts = useAiAccounts(projectId);
  const logins = useComputerLogins();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [signing, setSigning] = useState<AiAccount | null>(null);
  const spec = { label: 'Claude Code', binary: 'claude' };
  const cli = CLI_OF_PROVIDER[provider];
  const list = accountsFor(accounts.data?.accounts ?? [], provider);
  const chosen = list.find((a) => a.id === value) ?? null;
  const own = logins.data?.find((l) => l.cli === cli);
  const hint = chosen && !profile ? sharedHint(chosen, chosen.id === currentAccountId) : null;
  const actions = useAccountActions();
  const refresh = () => void qc.invalidateQueries({ queryKey: accountKeys.all });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="account-picker">
      <div className="acm-choices" role="radiogroup" aria-label="AI account">
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
              <div className={`acm-choice-sub ${a.status === 'needs_sign_in' ? 'acm-warn-text' : ''}`}>
                {profile && value === a.id ? profileSub(a) : accountSub(a, false)}
              </div>
            </div>
            <AccountStatusChip status={a.status} />
          </button>
        ))}
        {
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
          </button>
        }
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
      {list.length === 0 && (
        <AccountNote
          title={`No account for ${spec.label} yet`}
          testId="account-none-yet"
          actions={
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setAdding(true)}>
              Add an account
            </button>
          }
        >
          This AI team will use the login already on this computer, as before. Add an account to share one login between
          teams or to keep work and personal apart.
        </AccountNote>
      )}
      {chosen && chosen.status === 'needs_sign_in' && (
        <AccountNote
          tone="error"
          title={`${chosen.name} is signed out`}
          testId="account-signed-out"
          actions={
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-primary"
              onClick={() => setSigning(chosen)}
              data-testid="account-sign-in"
            >
              <AccIcon paths={[...ICONS.refresh]} size={13} />
              Sign in again
            </button>
          }
        >
          Pick another account, or sign in again now.
        </AccountNote>
      )}
      {chosen && chosen.status === 'signing_in' && (
        <AccountNote title={`${chosen.signingInBy ?? 'Someone'} is signing in`} testId="account-signing-in">
          Wait until they finish, or pick another account.
        </AccountNote>
      )}
      {chosen && chosen.status === 'cli_missing' && (
        <AccountNote
          tone="warn"
          title={`The ${spec.binary} CLI was not found for ${chosen.name}`}
          testId="account-cli-missing"
          actions={
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={actions.check.isPending}
              onClick={() => actions.check.mutate([chosen.id])}
            >
              Detect again
            </button>
          }
        >
          Install it, then detect again.
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
export function ChangeAccountDialog({ members, onClose }: { members: AiTeam[]; onClose: () => void }) {
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
          ? `${members.length} teams moved`
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
            {many ? `Choose another account for ${members.length} teams` : 'Change account'}
          </h2>
          <div className="ai-hint" style={{ marginTop: 3 }}>
            {many ? `${joinNames(members.map((m) => m.name))}.` : first.name}
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
