import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accountsApi, useAccountActions, useAiAccounts, useSignInTerminal } from '../../../api/aiAccounts';
import { extractError } from '../../../api/extractError';
import type { AiAccount, SignInState } from '../../../types/aiAccounts';
import {
  CLI_INFO,
  KEY_CODES,
  closingNeedsConfirm,
  keyRow,
  offersLink,
  offersPaste,
  signInView,
  statusLine,
  stepDots,
  type SignInView,
} from '../../../utils/signInCopy';
import { copyText, openLink, readClipboard } from './SignInLinks';
import { ICON_PATHS, Icon, SignInDots, SignInKeyRow, SignInStatusBar } from './SignInStatusBar';
import { TerminalPane, type TerminalHandle } from './TerminalPane';
import '../ai.css';
import './signIn.css';

type Mode = 'terminal' | 'no_terminal' | 'fallback' | 'busy';

/** What the window reports when it closes. */
export interface SignInClose {
  /** The person chose the account that already has this login ("Use Work Claude"): the new account was removed. */
  useExisting?: AiAccount;
}

/** The person making requests (the same one the API client sends as X-Actor). */
function currentActor(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'user';
  } catch {
    return 'user';
  }
}

/**
 * The sign-in window of an existing account: a real terminal and a status bar (design C2, C2b, C3). Used by "Sign in
 * again" everywhere, and as step 3 of Add an AI account. It never reads the screen to decide it is done: the server
 * asks the CLI who is signed in, and only that answer is saved.
 *
 * Keys: everything typed goes to the CLI, Esc included. Shift+Esc moves the focus out of the terminal; Esc anywhere
 * else in the window asks to stop signing in.
 */
export function SignInWindow({
  account,
  onClose,
}: {
  account: AiAccount;
  /** `signed_in` when the CLI confirmed it; `closed` when the person stopped or closed the window. */
  onClose: (result: 'signed_in' | 'closed', extra?: SignInClose) => void;
}) {
  const info = CLI_INFO[account.cli];
  const overview = useAiAccounts();
  const { refresh } = useAccountActions();
  const term = useRef<TerminalHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const startedFor = useRef(-1);

  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>('terminal');
  const [socketId, setSocketId] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [command, setCommand] = useState('');
  const [busyBy, setBusyBy] = useState<string | null>(null);
  const [sawOutput, setSawOutput] = useState(false);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [exitedAt, setExitedAt] = useState<number | null>(null);
  const [extendedS, setExtendedS] = useState(0);
  const [duplicateAccepted, setDuplicateAccepted] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [fallbackSigned, setFallbackSigned] = useState<AiAccount | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const write = useCallback((data: string) => {
    setSawOutput(true);
    term.current?.write(data);
  }, []);
  const terminal = useSignInTerminal(socketId, write);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The socket closing while the CLI was running means the server lost the sign-in (it restarted): say it stopped.
  const state: SignInState | null = useMemo(() => {
    const s = terminal.state;
    if (s && terminal.link === 'closed' && !s.ended && !s.signedIn) {
      return { ...s, running: false, ended: 'exited', exitCode: null };
    }
    return s;
  }, [terminal.state, terminal.link]);

  useEffect(() => {
    if (state?.ended === 'exited') setExitedAt((t) => t ?? Date.now());
  }, [state?.ended]);

  const view: SignInView = useMemo(() => {
    if (mode === 'busy') return 'busy';
    if (mode === 'no_terminal') return 'no_terminal';
    if (mode === 'fallback') return fallbackSigned ? 'fallback_signed' : 'fallback';
    return signInView({
      cli: account.cli,
      state,
      sawOutput,
      waitedS: (now - startedAt) / 1000,
      exitedForS: exitedAt === null ? null : (now - exitedAt) / 1000,
      extendedS,
      duplicateAccepted,
    });
  }, [mode, fallbackSigned, account.cli, state, sawOutput, now, startedAt, exitedAt, extendedS, duplicateAccepted]);

  const signedAccount = fallbackSigned ?? state?.account ?? account;
  const existing = useMemo(
    () => overview.data?.accounts.find((a) => a.name === state?.duplicateOf && a.id !== account.id) ?? null,
    [overview.data, state?.duplicateOf, account.id],
  );

  // --- starting, restarting ---------------------------------------------------------------------------------------

  const begin = useCallback(
    async (size: { cols: number; rows: number }, n: number) => {
      if (startedFor.current === n) return; // the pane mounts twice in development
      startedFor.current = n;
      setStartedAt(Date.now());
      try {
        const r = await accountsApi.startSignIn(account.id, size.cols, size.rows);
        if (r.mode === 'fallback') {
          setCommand(r.command);
          setProblem(r.reason);
          setMode(overview.data?.terminal === false ? 'fallback' : 'no_terminal');
        } else {
          setMode('terminal');
          setSocketId(account.id);
        }
      } catch (err) {
        const detail = (err as { response?: { status?: number; data?: { detail?: { code?: string; by?: string } } } })
          .response;
        if (detail?.status === 409 && detail.data?.detail?.code === 'signing_in') {
          const by = detail.data.detail.by ?? 'Someone';
          if (by === currentActor()) {
            // our own earlier window: pick the sign-in up again (the server replays what the terminal showed)
            setMode('terminal');
            setSocketId(account.id);
          } else {
            setBusyBy(by);
            setMode('busy');
          }
        } else {
          setProblem(extractError(err));
          setMode('no_terminal');
        }
      }
    },
    [account.id, overview.data?.terminal],
  );

  async function restart() {
    setWorking(true);
    try {
      await accountsApi.cancelSignIn(account.id).catch(() => undefined);
    } finally {
      setWorking(false);
    }
    setSocketId(null);
    setSawOutput(false);
    setExitedAt(null);
    setExtendedS(0);
    setDuplicateAccepted(false);
    setFallbackSigned(null);
    setProblem('');
    setNote(null);
    term.current?.reset();
    setMode('terminal');
    setAttempt((n) => n + 1);
  }

  // --- the fallback: the person signs in with their own terminal and the window asks the CLI ---------------------------

  const poll = useCallback(async () => {
    try {
      const a = await accountsApi.check(account.id);
      if (a.status === 'signed_in') {
        setFallbackSigned(a);
        void refresh();
      }
    } catch {
      /* the next try will do */
    }
  }, [account.id, refresh]);

  useEffect(() => {
    if (mode !== 'fallback' || fallbackSigned) return;
    const id = setInterval(() => void poll(), 3000);
    return () => clearInterval(id);
  }, [mode, fallbackSigned, poll]);

  // --- closing ----------------------------------------------------------------------------------------------------------

  async function close(result: 'signed_in' | 'closed', extra?: SignInClose) {
    setWorking(true);
    try {
      if (result === 'signed_in') {
        if (mode === 'terminal') await accountsApi.finishSignIn(account.id).catch(() => undefined);
      } else if (mode === 'terminal') {
        await accountsApi.cancelSignIn(account.id).catch(() => undefined);
      }
      await refresh();
    } finally {
      setWorking(false);
    }
    onClose(result, extra);
  }

  const signedView = view === 'done' || view === 'fallback_signed' || view === 'trust_folder';

  function requestClose() {
    if (signedView) void close('signed_in');
    else if (mode === 'terminal' && closingNeedsConfirm(view)) setConfirmStop(true);
    else void close('closed');
  }

  // Esc anywhere in the window asks to stop signing in, except inside the terminal, where it belongs to the CLI
  // (Shift+Esc there moves the focus out). A document listener, because a click on plain text leaves the focus on <body>.
  const escape = useRef(() => {});
  escape.current = () => {
    if (confirmStop) setConfirmStop(false);
    else requestClose();
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.shiftKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sg-term')) return;
      escape.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function chooseExistingAccount() {
    setWorking(true);
    try {
      await accountsApi.cancelSignIn(account.id).catch(() => undefined);
      await accountsApi.remove(account.id, 'login');
      await refresh();
    } finally {
      setWorking(false);
    }
    onClose('closed', { useExisting: existing ?? undefined });
  }

  // --- helpers on the status bar --------------------------------------------------------------------------------------

  async function pasteCode() {
    const text = await readClipboard();
    if (text === null) {
      setNote('The browser would not let this window read the clipboard: paste inside the terminal (Ctrl+V or ⌘V).');
    } else {
      setNote(null);
      terminal.paste(`${text.trim()}\r`);
    }
    term.current?.focus();
  }

  async function copy(text: string, what: string) {
    setNote((await copyText(text)) ? `${what} copied.` : 'Copying was blocked by the browser.');
  }

  const line = statusLine(view, {
    cli: account.cli,
    accountName: account.name,
    signedIn: signedAccount,
    exitCode: state?.exitCode ?? null,
    duplicateOf: state?.duplicateOf ?? null,
    by: busyBy,
  });
  const showTerminal = mode === 'terminal';
  const dim = ['done', 'duplicate', 'timed_out', 'stopped', 'rejected'].includes(view) && !state?.running;

  const actions = (() => {
    const btn = (label: string, onClick: () => void, o: { primary?: boolean; icon?: keyof typeof ICON_PATHS } = {}) => (
      <button
        key={label}
        type="button"
        className={`ai-btn ai-btn-sm ${o.primary ? 'ai-btn-primary' : ''}`}
        onClick={onClick}
        disabled={working}
      >
        {o.icon && <Icon d={ICON_PATHS[o.icon]} />}
        {label}
      </button>
    );
    switch (view) {
      case 'browser':
        return offersLink(view) && state?.url
          ? [
              btn('Open in browser', () => openLink(state.url!), { icon: 'external' }),
              btn('Copy link', () => void copy(state.url!, 'Link'), { icon: 'copy' }),
            ]
          : null;
      case 'paste_code':
        return offersPaste(view) ? btn('Paste code', () => void pasteCode(), { primary: true, icon: 'paste' }) : null;
      case 'rejected':
        return btn('Start again', () => void restart(), { primary: true, icon: 'refresh' });
      case 'stopped':
        return [
          btn('Start again', () => void restart(), { primary: true, icon: 'refresh' }),
          btn('Copy output', () => void copy(term.current?.text() ?? '', 'Output'), { icon: 'copy' }),
        ];
      case 'timed_out':
        return [
          btn('Keep waiting', () => setExtendedS((s) => s + 300)),
          btn('Start again', () => void restart(), { primary: true, icon: 'refresh' }),
        ];
      case 'duplicate':
        return [
          btn(`Use ${state?.duplicateOf ?? 'the other account'}`, () => void chooseExistingAccount()),
          btn('Add anyway', () => setDuplicateAccepted(true)),
        ];
      case 'no_terminal':
        return [
          btn('Sign in in my own terminal', () => setMode('fallback'), { primary: true, icon: 'terminal' }),
          btn('Try again', () => void restart(), { icon: 'refresh' }),
        ];
      case 'fallback':
        return btn('Check now', () => void poll(), { icon: 'refresh' });
      default:
        return null;
    }
  })();

  const done = (
    <button
      type="button"
      className="ai-btn ai-btn-sm ai-btn-primary"
      onClick={() => void close('signed_in')}
      disabled={working}
    >
      Done
    </button>
  );

  return (
    <div className="ai-overlay" data-testid="sign-in-window">
      <div
        className="sg-win"
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={`Sign in: ${account.name}`}
        tabIndex={-1}
      >
        <div className="sg-head">
          <div className="sg-head-title">
            <b>Sign in: {account.name}</b>
            <div className="ai-hint" style={{ fontSize: 12, marginTop: 2 }}>
              {info.label} · on this computer
            </div>
          </div>
          <button type="button" className="ai-icobtn" aria-label="Close" onClick={requestClose}>
            <Icon d={ICON_PATHS.close} size={15} />
          </button>
        </div>
        <div className="sg-body">
          {view !== 'busy' && <SignInDots dots={stepDots(account.cli, view)} />}
          <SignInStatusBar
            tone={line.tone}
            title={line.title}
            body={line.body}
            actions={actions}
            spinning={view === 'starting' || view === 'confirming' || view === 'fallback'}
          />
          {view === 'no_terminal' && problem && <div className="sg-reason">{problem}</div>}
          {mode === 'fallback' && (
            <>
              <div className="sg-cmd-row">
                <span data-testid="sign-in-command">{command}</span>
                <button type="button" className="ai-btn ai-btn-sm" onClick={() => void copy(command, 'Command')}>
                  <Icon d={ICON_PATHS.copy} />
                  Copy
                </button>
              </div>
              {!fallbackSigned && (
                <div className="sg-note">
                  The command uses this account’s own folder, so the login lands in the right account and not in the one
                  already on this computer. Nothing you type there is seen by Kanban.
                </div>
              )}
            </>
          )}
          {showTerminal && (
            <TerminalPane
              key={attempt}
              ref={term}
              command={info.command}
              dim={dim}
              onReady={(size) => void begin(size, attempt)}
              onInput={terminal.input}
              onResize={terminal.resize}
              onLeave={() => root.current?.focus()}
            />
          )}
          {showTerminal && <SignInKeyRow keys={keyRow(view)} onKey={(k) => terminal.input(KEY_CODES[k])} />}
          {note && (
            <div className="sg-note" role="status">
              {note}
            </div>
          )}
        </div>
        <div className="sg-foot">
          {!(view === 'done' || view === 'fallback_signed') && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={requestClose} disabled={working}>
              Cancel sign-in
            </button>
          )}
          <span className="sg-grow" />
          {signedView ? (
            done
          ) : view === 'fallback' ? (
            <button type="button" className="ai-btn ai-btn-sm ai-btn-primary" disabled style={{ opacity: 0.5 }}>
              Done
            </button>
          ) : showTerminal ? (
            <span className="sg-note">
              The terminal is the real CLI. Kanban only watches whether it ends up signed in.
            </span>
          ) : null}
        </div>
      </div>
      {confirmStop && (
        <div className="ai-overlay" style={{ zIndex: 1100 }} role="presentation">
          <div className="sg-win sg-win-small" role="alertdialog" aria-label="Stop signing in?">
            <div className="sg-head">
              <div className="sg-head-title">
                <b>Stop signing in?</b>
              </div>
              <button type="button" className="ai-icobtn" aria-label="Close" onClick={() => setConfirmStop(false)}>
                <Icon d={ICON_PATHS.close} size={15} />
              </button>
            </div>
            <div className="sg-body">
              <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                The terminal is closed and the CLI is stopped. The account is not saved as signed in. You can sign in
                again from the list.
              </div>
            </div>
            <div className="sg-foot">
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setConfirmStop(false)} autoFocus>
                Keep signing in
              </button>
              <span className="sg-grow" />
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-danger"
                onClick={() => {
                  setConfirmStop(false);
                  void close('closed');
                }}
                disabled={working}
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type { SignInView };
