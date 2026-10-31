import { useEffect, useMemo, useRef, useState } from 'react';
import { accountsApi, useAccountActions, useAiAccounts } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AccountCli, AccountCliCard, AiAccount } from '../../../types/aiAccounts';
import { ADD_STEPS, CLI_INFO, cardBlurb } from '../../../utils/signInCopy';
import { openLink } from './SignInLinks';
import { ICON_PATHS, Icon } from './SignInStatusBar';
import { SignInWindow } from './SignInWindow';
import '../ai.css';
import './signIn.css';

/** One CLI of step 1: its avatar, what it is for, whether it is installed and whether its runs start yet. */
function CliCard({ card, selected, onPick }: { card: AccountCliCard; selected: boolean; onPick: () => void }) {
  const info = CLI_INFO[card.cli];
  const off = !!card.unavailable;
  return (
    <button
      type="button"
      className={`sg-cli ${selected && !off ? 'sg-cli-on' : ''}`}
      onClick={onPick}
      disabled={off}
      aria-pressed={selected}
      data-testid={`cli-card-${card.cli}`}
    >
      <span className="sg-avatar" title={info.label} style={{ background: info.bg, color: info.color }}>
        {info.initials}
      </span>
      <span className="sg-cli-text">
        <span className="sg-cli-name">{info.label}</span>
        <div className="sg-cli-hint">{cardBlurb(card.cli, card.blurb, card.unavailable)}</div>
      </span>
      <span className="sg-chips">
        {off ? (
          <span className="sg-chip sg-chip-off">{card.unavailable}</span>
        ) : (
          <>
            <span className={`sg-chip ${card.found ? '' : 'sg-chip-warn'}`}>
              {card.found ? 'found' : 'not installed'}
            </span>
            {!card.runnable && <span className="sg-chip sg-chip-warn">Not ready</span>}
          </>
        )}
      </span>
    </button>
  );
}

/** The stepper of the add window: CLI, name, sign in. */
function Steps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="sg-steps" data-testid="add-account-steps">
      {ADD_STEPS.map((label, i) => {
        const n = i + 1;
        const cls = step === n ? 'sg-step-on' : step > n ? 'sg-step-done' : '';
        return (
          <span key={label} style={{ display: 'contents' }}>
            {i > 0 && <span className="sg-step-line" />}
            <span className={`sg-step ${cls}`}>
              <span className="sg-step-n">
                {step > n ? (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                ) : (
                  n
                )}
              </span>
              {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** "<CLI> is not installed": the install command and Detect again, as the Add AI member flow does. */
function InstallPanel({
  card,
  detecting,
  onBack,
  onDetect,
  onClose,
}: {
  card: AccountCliCard;
  detecting: boolean;
  onBack: () => void;
  onDetect: () => void;
  onClose: () => void;
}) {
  const info = CLI_INFO[card.cli];
  return (
    <div className="sg-win sg-win-small" role="dialog" aria-label={`${info.label} is not installed`}>
      <div className="sg-head">
        <div className="sg-head-title">
          <b>{info.label} is not installed</b>
        </div>
        <button type="button" className="ai-icobtn" aria-label="Close" onClick={onClose}>
          <Icon d={ICON_PATHS.close} size={15} />
        </button>
      </div>
      <div className="sg-body">
        <div className="sg-callout sg-callout-warn">
          <Icon d={ICON_PATHS.warn} size={16} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="sg-callout-title">“{info.command}” was not found on this computer</span>
            <span className="sg-callout-text">
              Install it, then detect again. You do not need to leave this window.
            </span>
          </div>
        </div>
        {info.install ? (
          <div className="sg-cmd">$ {info.install}</div>
        ) : (
          <ol className="ai-hint" style={{ margin: 0, paddingLeft: 18 }} data-testid="install-steps">
            {info.installSteps.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        )}
      </div>
      <div className="sg-foot">
        <button type="button" className="ai-btn ai-btn-sm" onClick={onBack}>
          Back
        </button>
        <span className="sg-grow" />
        <button type="button" className="ai-btn ai-btn-sm" onClick={onDetect} disabled={detecting}>
          Detect again
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => openLink(info.guideUrl)}>
          Installation guide
        </button>
      </div>
    </div>
  );
}

/**
 * Add an AI account in three steps: CLI, name, sign in (design/screens/ai-accounts.md, C1). The account is made at the
 * end of the name step (a folder of its own for the CLI, signed out); step 3 is the sign-in window with the terminal.
 * Names are unique per computer, checked while typing.
 */
export function AddAccountModal({
  initialCli,
  onClose,
  onCreated,
}: {
  /** Start at the name step for this CLI (opened from "New account…" in the Add AI member window). */
  initialCli?: AccountCli;
  onClose: () => void;
  /** The account exists (made at the end of the name step), signed in or not. */
  onCreated?: (account: AiAccount) => void;
}) {
  const overview = useAiAccounts();
  const { create, refresh } = useAccountActions();
  const cards = useMemo(() => overview.data?.clis ?? [], [overview.data?.clis]);
  const taken = useMemo(() => overview.data?.accounts ?? [], [overview.data?.accounts]);
  const [step, setStep] = useState<1 | 2>(initialCli ? 2 : 1);
  const [cli, setCli] = useState<AccountCli | null>(initialCli ?? null);
  const [installFor, setInstallFor] = useState<AccountCli | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [name, setName] = useState('');
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AiAccount | null>(null);

  const card = cards.find((c) => c.cli === cli) ?? null;

  // Claude Code is chosen for the person unless something else is asked for or it is not there
  useEffect(() => {
    if (cli || !cards.length) return;
    setCli((cards.find((c) => c.found && !c.unavailable) ?? cards.find((c) => !c.unavailable))?.cli ?? null);
  }, [cli, cards]);

  // Opened for a CLI that is not installed: say so before asking for a name
  useEffect(() => {
    if (initialCli && card && !card.found && !card.unavailable && !installFor) setInstallFor(initialCli);
  }, [initialCli, card, installFor]);

  // The name must be free on this computer
  useEffect(() => {
    const clean = name.trim().replace(/\s+/g, ' ');
    setNameProblem(null);
    if (!clean) return;
    if (taken.some((a) => a.name.toLowerCase() === clean.toLowerCase())) {
      setNameProblem('An account with this name exists.');
      return;
    }
    const id = setTimeout(() => {
      accountsApi
        .nameCheck(clean)
        .then((r) => setNameProblem(r.ok ? null : (r.message ?? 'An account with this name exists.')))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(id);
  }, [name, taken]);

  async function detectAgain() {
    setDetecting(true);
    try {
      const fresh = await overview.refetch();
      const now = fresh.data?.clis.find((c) => c.cli === installFor);
      if (now?.found) {
        setInstallFor(null);
        setStep(2);
      }
    } finally {
      setDetecting(false);
    }
  }

  async function makeAccount() {
    if (!cli) return;
    setError(null);
    try {
      const account = await create.mutateAsync([{ name: name.trim().replace(/\s+/g, ' '), cli }]);
      setCreated(account);
      onCreated?.(account);
    } catch (err) {
      const message = extractError(err);
      if (/name exists/i.test(message)) setNameProblem(message);
      else setError(message);
    }
  }

  function next() {
    if (!card) return;
    if (!card.found) setInstallFor(card.cli);
    else setStep(2);
  }

  // Esc leaves the first two steps (step 3 is the sign-in window, which asks before it stops anything)
  const leave = useRef(onClose);
  leave.current = () => {
    if (!created) onClose();
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) leave.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (created) {
    return (
      <SignInWindow
        account={created}
        onClose={() => {
          void refresh();
          onClose();
        }}
      />
    );
  }

  const installCard = installFor ? (cards.find((c) => c.cli === installFor) ?? null) : null;
  const canSignIn = !!name.trim() && !nameProblem && !create.isPending;

  return (
    <div className="ai-overlay" data-testid="add-account-modal">
      {installCard ? (
        <InstallPanel
          card={installCard}
          detecting={detecting}
          onBack={() => {
            setInstallFor(null);
            if (initialCli) onClose();
            else setStep(1);
          }}
          onDetect={() => void detectAgain()}
          onClose={onClose}
        />
      ) : (
        <div className="sg-win sg-win-add" role="dialog" aria-label="Add an AI account">
          <div className="sg-head">
            <div className="sg-head-title">
              <b>Add an AI account</b>
            </div>
            <button type="button" className="ai-icobtn" aria-label="Close" onClick={onClose}>
              <Icon d={ICON_PATHS.close} size={15} />
            </button>
          </div>
          <div className="sg-body">
            <Steps step={step} />
            {step === 1 && (
              <>
                <div style={{ fontSize: 12.5, color: '#3A4A3E' }}>Which CLI is this account for?</div>
                {overview.isLoading && <div className="ai-hint">Looking for the CLIs on this computer…</div>}
                {overview.isError && (
                  <div className="ai-notice ai-notice-error">Could not ask the board which CLIs are installed.</div>
                )}
                {cards.map((c) => (
                  <CliCard key={c.cli} card={c} selected={cli === c.cli} onPick={() => setCli(c.cli)} />
                ))}
              </>
            )}
            {step === 2 && (
              <>
                <label className="ai-field" style={{ gap: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#3A4A3E' }}>Name</span>
                  <input
                    className={`ai-input ${nameProblem ? 'ai-input-error' : ''}`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && canSignIn) void makeAccount();
                    }}
                    placeholder={
                      cli ? `For example ${cli === 'claude' ? 'Work Claude' : `Work ${CLI_INFO[cli].label}`}` : ''
                    }
                    maxLength={60}
                    autoFocus
                    aria-invalid={!!nameProblem}
                    data-testid="account-name"
                  />
                  {nameProblem && <span className="ai-error-text">{nameProblem}</span>}
                  <span className="sg-note">
                    Shown when you pick an account for an AI member. Claude Code reports who is signed in, so its email
                    is shown as well. Codex, opencode and Antigravity do not, so for them the name is how you tell
                    accounts apart. Use the person or plan, not a secret.
                  </span>
                </label>
                <div className="sg-callout">
                  <Icon d={ICON_PATHS.info} size={16} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span className="sg-callout-title">Where the login is kept</span>
                    <span className="sg-callout-text">
                      This account gets its own folder for the CLI, so it never mixes with the login you already use on
                      this computer. The CLI keeps the login for this account: in its folder, or for Claude Code on
                      macOS in the system keychain under its own entry. Kanban starts the CLI and never reads, shows or
                      sends the login. A file in the folder can be read by any program running as you, so keep the
                      folder out of cloud sync and backups.
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#5B6B60' }}>
                  Next you sign in, in a terminal inside this window.
                </div>
                {error && <div className="ai-error-text">{error}</div>}
              </>
            )}
          </div>
          <div className="sg-foot">
            {step === 2 && !initialCli && (
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setStep(1)}>
                Back
              </button>
            )}
            <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
              Cancel
            </button>
            <span className="sg-grow" />
            {step === 1 ? (
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                onClick={next}
                disabled={!card || !!card.unavailable}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                onClick={() => void makeAccount()}
                disabled={!canSignIn}
                data-testid="account-sign-in"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
