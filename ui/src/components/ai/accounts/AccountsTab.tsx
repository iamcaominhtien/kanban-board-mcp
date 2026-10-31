import { useEffect, useRef, useState } from 'react';
import { useAiOverview, useRunnerInfo } from '../../../api/ai';
import { useAccountActions, useAiAccounts, useComputerLogins } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AccountCli, AiAccount } from '../../../types/aiAccounts';
import {
  DESKTOP_ONLY,
  GUIDE_URL,
  accountStats,
  bannerText,
  missingClis,
  needsAttention,
  type MenuAction,
} from '../../../utils/accountList';
import { useToast } from '../../Toast';
import { LoadError } from '../aiUi';
import { AccountBadge, AccIcon, AccountNote, ICONS } from './AccountParts';
import { AccountMembersDialog } from './AccountMembersDialog';
import { AccountRow } from './AccountRow';
import { AddAccountModal } from './AddAccountModal';
import { RemoveAccountDialog } from './RemoveAccountDialog';
import { RenameAccountDialog } from './RenameAccountDialog';
import { SignInWindow } from './SignInWindow';
import { SignOutDialog } from './SignOutDialog';
import './accounts.css';

/** Opens a link in the person's browser (the desktop app has its own bridge). */
function openLink(url: string) {
  const open = (window as unknown as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI
    ?.openExternal;
  if (open) open(url);
  else window.open(url, '_blank', 'noopener');
}

type Dialog =
  | { kind: 'rename' | 'remove' | 'sign_out' | 'members'; account: AiAccount }
  | { kind: 'add'; cli?: AccountCli }
  | { kind: 'sign_in'; account: AiAccount };

/**
 * The “AI accounts” tab of the Members page: one row per account with what it is signed in with, its status and the
 * members using it; Sign in again, Check now and a menu per row; banners for what needs attention
 * (design/screens/ai-accounts.md, B1, B2, F). Changing an account needs the desktop app: the web build shows the list read only.
 */
export function AccountsTab({ projectId }: { projectId: string }) {
  const accounts = useAiAccounts(projectId);
  const runner = useRunnerInfo();
  const overview = useAiOverview(projectId);
  const desktop = runner.data?.local !== false;
  const logins = useComputerLogins();
  const actions = useAccountActions();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [checking, setChecking] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);

  // Times such as "Checked 2 min ago" move on while the tab stays open
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const list = accounts.data?.accounts ?? [];
  const stats = accountStats(list);
  const signedOut = needsAttention(list);
  const missing = missingClis(list);
  const signingIn = list.filter((a) => a.status === 'signing_in');

  const check = async (account: AiAccount) => {
    setChecking((c) => [...c, account.id]);
    try {
      await actions.check.mutateAsync([account.id]);
    } catch (e) {
      toast.error(`Could not check ${account.name}`, extractError(e));
    } finally {
      setChecking((c) => c.filter((id) => id !== account.id));
    }
  };

  const act = (account: AiAccount, action: MenuAction) => {
    setMenu(null);
    if (action === 'check') void check(account);
    else if (action === 'sign_in') setDialog({ kind: 'sign_in', account });
    else setDialog({ kind: action === 'sign_out' ? 'sign_out' : action, account });
  };

  const addButton = (
    <button
      type="button"
      className="ai-btn ai-btn-sm ai-btn-primary"
      disabled={!desktop}
      title={desktop ? undefined : DESKTOP_ONLY}
      data-testid="add-account"
      onClick={() => setDialog({ kind: 'add' })}
    >
      <AccIcon paths={[...ICONS.plus]} size={13} />
      Add account
    </button>
  );

  // Members of this project on the login that is already on this computer, per CLI
  const onComputer = (provider: string) =>
    (overview.data?.members ?? []).filter((m) => m.connection === 'local' && m.provider === provider && !m.accountId)
      .length;

  let body;
  if (accounts.isLoading) {
    body = (
      <div aria-busy="true" aria-label="Loading AI accounts">
        {[0, 1, 2].map((i) => (
          <div key={i} className="ai-skel acc-skel" />
        ))}
      </div>
    );
  } else if (accounts.error) {
    body = <LoadError what="AI accounts" error={accounts.error} onRetry={() => void accounts.refetch()} />;
  } else if (!list.length) {
    body = (
      <div className="acc-empty" data-testid="accounts-empty">
        <b style={{ fontSize: 13 }}>No AI accounts yet</b>
        <div className="acc-hint" style={{ fontSize: 12.5 }}>
          AI members use the login already on this computer. Add an account to share one login between members, or to
          keep work and personal apart.
        </div>
        {addButton}
      </div>
    );
  } else {
    body = (
      <>
        <div className="acc-tiles">
          <div className="acc-tile">
            <div className="acc-h">Accounts</div>
            <span className="acc-tile-n">{stats.total}</span>
            <div className="acc-tile-hint">on this computer</div>
          </div>
          <div className="acc-tile">
            <div className="acc-h">Signed in</div>
            <span className="acc-tile-n">{stats.signedIn}</span>
            <div className="acc-tile-hint">of {stats.total}</div>
          </div>
          <div className="acc-tile">
            <div className="acc-h">Need attention</div>
            <span className={`acc-tile-n ${stats.attention.length ? 'acc-tile-n-bad' : ''}`}>
              {stats.attention.length}
            </span>
            <div className="acc-tile-hint">{stats.attention.length ? stats.attention.join(', ') : 'None'}</div>
          </div>
          <div className="acc-tile">
            <div className="acc-h">Members using one</div>
            <span className="acc-tile-n">{stats.using}</span>
            <div className="acc-tile-hint">
              {stats.elsewhere ? `${stats.here} here, ${stats.elsewhere} in other projects` : `${stats.here} here`}
            </div>
          </div>
        </div>
        <div className="acc-table" role="table" aria-label="AI accounts" ref={ref}>
          <div className="acc-grid acc-grid-head" role="row">
            <div className="acc-h">Account</div>
            <div className="acc-h">CLI</div>
            <div className="acc-h">Signed in with</div>
            <div className="acc-h">Status</div>
            <div className="acc-h">Used by</div>
            <div className="acc-h" />
          </div>
          {list.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              checking={checking.includes(a.id)}
              desktop={desktop}
              menuOpen={menu === a.id}
              nowMs={now}
              onMenu={() => setMenu(menu === a.id ? null : a.id)}
              onAction={(action) => act(a, action)}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="acc-root ai-root" data-testid="accounts-tab">
      <div className="acc-intro">
        <div className="acc-intro-text">
          One sign-in of a CLI. Several AI members can use the same account; if it expires you fix it here, once. The
          login stays with the CLI; Kanban never reads or shows it.
        </div>
        {list.length > 0 && addButton}
      </div>

      {!desktop && (
        <AccountNote tone="info" title="AI accounts need the desktop app" testId="accounts-web-build">
          Signing in runs a terminal on your computer. The accounts tab shows the list read only; Add account and Sign
          in are off.
        </AccountNote>
      )}
      {missing.map((m) => (
        <AccountNote
          key={m.cli}
          tone="warn"
          title={`${m.label} was not found`}
          testId={`accounts-cli-missing-${m.cli}`}
          actions={
            <>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                onClick={() => list.filter((a) => a.cli === m.cli).forEach((a) => void check(a))}
              >
                Detect again
              </button>
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => openLink(GUIDE_URL[m.cli])}>
                Installation guide
              </button>
            </>
          }
        >
          Accounts for this CLI show <b>CLI not installed</b> and sign in is off until it is back. Their members are
          paused with the reason, not failed.
        </AccountNote>
      ))}
      {signingIn.map((a) => (
        <AccountNote key={a.id} tone="info" title={`Someone is signing in to ${a.name}`} testId="accounts-signing-in">
          {a.signingInBy ?? 'Someone'} started it on this computer. Sign in again is off until they finish or stop.
        </AccountNote>
      ))}
      {signedOut.map((a) => {
        const text = bannerText(a, now);
        const off = a.status !== 'needs_sign_in' || !desktop;
        return (
          <AccountNote
            key={a.id}
            tone="bad"
            title={text.title}
            testId="accounts-banner"
            actions={
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                disabled={off}
                title={desktop ? undefined : DESKTOP_ONLY}
                onClick={() => setDialog({ kind: 'sign_in', account: a })}
              >
                <AccIcon paths={[...ICONS.refresh]} size={13} />
                Sign in again
              </button>
            }
          >
            {text.body}
          </AccountNote>
        );
      })}

      {body}

      {desktop && (logins.data?.length ?? 0) > 0 && list.length > 0 && (
        <div className="acc-logins" data-testid="accounts-logins">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <b style={{ fontSize: 13 }}>Logins already on this computer</b>
            <span className="acc-hint" style={{ flex: 1 }}>
              What AI members use today when no account is chosen. Not managed here; they keep working as before.
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {logins.data?.map((l) => {
              const n = onComputer(l.cli === 'claude' ? 'claude-code' : l.cli === 'agy' ? 'antigravity' : l.cli);
              return (
                <span key={l.cli} className="acc-login">
                  <AccountBadge cli={l.cli} label={l.label} size={22} />
                  {l.label}
                  {l.signedInWith ? ` · ${l.signedInWith}` : ''}
                  {n > 0 && (
                    <span className="acc-hint">
                      {n} member{n === 1 ? '' : 's'}
                    </span>
                  )}
                  <button type="button" className="acc-link" onClick={() => setDialog({ kind: 'add', cli: l.cli })}>
                    Move to an account
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {dialog?.kind === 'add' && (
        <AddAccountModal
          initialCli={dialog.cli}
          onClose={() => {
            setDialog(null);
            void actions.refresh();
          }}
        />
      )}
      {dialog?.kind === 'sign_in' && (
        <SignInWindow
          account={dialog.account}
          onClose={() => {
            setDialog(null);
            void actions.refresh();
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameAccountDialog account={dialog.account} accounts={list} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveAccountDialog account={dialog.account} accounts={list} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'sign_out' && <SignOutDialog account={dialog.account} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'members' && <AccountMembersDialog account={dialog.account} onClose={() => setDialog(null)} />}
    </div>
  );
}
