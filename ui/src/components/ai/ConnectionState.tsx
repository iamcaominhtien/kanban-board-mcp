import { useEffect, useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { useAiAccounts } from '../../api/aiAccounts';
import { extractError } from '../../api/extractError';
import type { AiMember, DetectResult } from '../../types/ai';
import { useToast } from '../Toast';
import { currentPerson } from '../assist/assistUi';
import { displayStatus } from '../../utils/memberAccount';
import { ChangeAccountDialog } from './accounts/AccountPicker';
import { SignInWindow } from './accounts/SignInWindow';
import { PROVIDERS, StatusLabel, fmtElapsed, inWords, money, secondsSince, shortDate, useNow, ago } from './aiUi';

/** Where “Configuration” should put the cursor when a state's action sends the person there. */
export type ConfigFocus = 'key' | 'budget' | 'model';

interface Copy {
  text: string;
  action: { label: string; testId: string; run: () => void | Promise<void> } | null;
}

/** Plain steps to bring a missing CLI back (the Runner not detected state). */
function InstallStepsDialog({
  member,
  onClose,
  onCheck,
}: {
  member: AiMember;
  onClose: () => void;
  onCheck: () => void;
}) {
  const spec = PROVIDERS[member.provider];
  const [detect, setDetect] = useState<DetectResult | null>(null);
  useEffect(() => {
    void aiApi
      .detect(member.provider)
      .then(setDetect)
      .catch(() => setDetect(null));
  }, [member.provider]);
  const steps = detect?.installSteps ?? [];
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 500 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Install and relaunch"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">“{spec.binary}” was not found on this computer</h2>
          <div className="ai-hint">
            Checked PATH and the usual install folders. The desktop runner needs the official CLI installed and signed
            in.
          </div>
        </div>
        <div className="ai-modal-body">
          <div className="ai-label ai-label-dark">Install and sign in</div>
          {steps.length > 0 ? (
            <ol className="ai-hint" style={{ margin: 0, paddingLeft: 18 }}>
              {steps.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          ) : (
            <div className="ai-term">
              $ {detect?.install ?? spec.install ?? 'install the CLI'}
              {'\n'}$ {spec.binary} # sign in once, then come back
            </div>
          )}
          <div className="ai-hint">
            Closed the desktop app? Open it again: assigned tickets wait in the queue and start by themselves once the
            runner is back. Installed somewhere unusual? Add its folder to PATH, then check again.
          </div>
        </div>
        <div className="ai-modal-foot">
          {detect?.guideUrl && (
            <a className="ai-link" href={detect.guideUrl} target="_blank" rel="noopener noreferrer">
              Installation guide ↗
            </a>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            onClick={() => {
              onCheck();
              onClose();
            }}
          >
            Check again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The connection-state card of a profile (design/screens/ai-members.md, E1–E10): the state, why, and the one action
 * that moves it on. The state shown is the most blocking one that applies.
 */
export function ConnectionStateCard({
  member,
  onOpenTicket,
  onConfigure,
}: {
  member: AiMember;
  onOpenTicket: (id: string) => void;
  onConfigure: (focus: ConfigFocus) => void;
}) {
  const toast = useToast();
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  // E11: the member's account is signed out. The person signs it in here, or picks another account.
  const [signingIn, setSigningIn] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const accounts = useAiAccounts(member.projectId);
  // “for 3m 12s” keeps counting while it runs
  useNow(1000, member.status.code === 'running');
  const resume = useAiMutation(() => aiApi.resume(member.id));
  const retry = useAiMutation(() => aiApi.retryNow(member.id));
  const test = useAiMutation((full: boolean) => aiApi.test(member.id, full));

  async function check(full: boolean) {
    setBusy(true);
    try {
      const r = await test.mutateAsync(full);
      if (r.ok) toast.success(`${member.name}: connection OK`, r.message);
      else toast.error(`${member.name}: connection failed`, r.message);
    } catch (err) {
      toast.error('Test failed', extractError(err));
    } finally {
      setBusy(false);
    }
  }

  const st = displayStatus(member);
  const accountOut = st.code === 'not_logged_in' && member.accountRef?.status === 'needs_sign_in';
  const fullAccount = accounts.data?.accounts.find((a) => a.id === member.accountId);
  const spec = PROVIDERS[member.provider];
  const run = member.running.find((r) => r.state === 'running' || r.state === 'starting');
  const free = Math.max(0, member.maxParallel - member.slotsInUse);
  const code = /\b(40[13])\b/.exec(member.healthDetail ?? '')?.[1] ?? '401';
  const waiting = member.queued;
  const waitingText = waiting ? ` ${waiting} ticket${waiting === 1 ? ' is' : 's are'} waiting.` : '';
  const by = member.pausedReason?.replace(/^Paused by /, '');

  const copy: Copy = (() => {
    switch (st.code) {
      case 'online':
        return {
          text: member.lastCallAt
            ? `Key is valid and the provider answered the last call ${ago(member.lastCallAt)}. New assignments start at once.`
            : 'Key is valid. New assignments start at once.',
          action: { label: 'Test connection', testId: 'state-action-test', run: () => check(true) },
        };
      case 'idle':
        return {
          text: 'CLI detected and signed in. Nothing is assigned right now. The runner starts it the moment a ticket is assigned.',
          action: { label: 'Test connection', testId: 'state-action-test', run: () => check(true) },
        };
      case 'running':
        return {
          text: `Working on ${run?.ticketTitle ? `“${run.ticketTitle}”` : (run?.ticketId ?? 'a ticket')} for ${fmtElapsed(secondsSince(run?.startedAt))}. ${
            free
              ? `${free === 1 ? 'One more slot is' : `${free} more slots are`} free (${member.slotsInUse} of ${member.maxParallel}).`
              : `All ${member.maxParallel} slots are in use.`
          }`,
          action: run
            ? { label: 'Open ticket', testId: 'state-action-open', run: () => onOpenTicket(run.ticketId) }
            : null,
        };
      case 'runner_missing':
        return {
          text: `The desktop app is closed or the ${spec.binary ?? 'CLI'} CLI is not on PATH. Assigned tickets wait in its queue.`,
          action: { label: 'Show install & relaunch steps', testId: 'state-action-steps', run: () => setSteps(true) },
        };
      case 'not_logged_in':
        if (accountOut)
          return {
            text: `The account ${member.accountRef!.name} is signed out, so this member and any others on it cannot run. Assigned tickets wait; held runs start again by themselves after sign-in. An AI cannot sign in; a person does it here.`,
            action: {
              label: 'Sign in again',
              testId: 'state-action-sign-in',
              run: () => setSigningIn(true),
            },
          };
        return {
          text: `The CLI is installed but its session expired. Run ${spec.binary ?? 'it'} in a terminal and sign in again; Kanban never asks for your login.`,
          action: { label: 'Check again', testId: 'state-action-check', run: () => check(false) },
        };
      case 'key_invalid':
        return {
          text: `${member.providerLabel} returned ${code}: the key was revoked or has expired. Runs are stopped until a new key is saved.`,
          action: { label: 'Replace key', testId: 'state-action-key', run: () => onConfigure('key') },
        };
      case 'rate_limited':
        return {
          text: `The provider returned 429. ${waiting ? `${waiting} run${waiting === 1 ? ' is' : 's are'} queued and` : 'Queued runs'} retry automatically in about ${inWords(member.retryAt)}.`,
          action: {
            label: 'Retry now',
            testId: 'state-action-retry',
            run: () => retry.mutateAsync(undefined).then(() => undefined),
          },
        };
      case 'over_budget': {
        const monthly = /monthly/i.test(st.detail ?? '');
        const local = member.connection === 'local';
        return {
          text: local
            ? `${st.detail?.replace(/;.*$/, '') ?? 'The runs per day are used up'}. New runs are paused until 00:00, running ones finish.${waitingText}`
            : monthly
              ? `Monthly cap of ${money(member.monthlyCap)} reached. New runs are paused until the 1st, running ones finish.${waitingText}`
              : `${/board/i.test(st.detail ?? '') ? 'The board’s cap' : `Daily budget of ${money(member.dailyBudget)}`} reached. New runs are paused until 00:00, running ones finish.${waitingText}`,
          action: {
            label: local ? 'Raise runs per day' : monthly ? 'Raise monthly cap' : 'Raise daily budget',
            testId: 'state-action-budget',
            run: () => onConfigure('budget'),
          },
        };
      }
      case 'paused':
        return {
          text: `${by && by !== 'user' && by !== currentPerson() ? `${by} paused` : 'You paused'} it${member.pausedAt ? ` on ${shortDate(member.pausedAt)}` : ''}. Assigned tickets stay assigned and @mentions are queued, but no run starts.`,
          action: {
            label: 'Resume',
            testId: 'state-action-resume',
            run: () => resume.mutateAsync(undefined).then(() => undefined),
          },
        };
      case 'model_retired':
        return {
          text: `The provider retired ${member.model ?? 'the model'}, the model chosen for this AI member. Runs fail until you pick another model.`,
          action: { label: 'Choose a model', testId: 'state-action-model', run: () => onConfigure('model') },
        };
      case 'paused_all':
        return {
          text: 'AI is paused for this project. Nothing starts until someone resumes it from the banner.',
          action: null,
        };
      case 'not_ready':
        return {
          text: `Runs don’t start yet for ${spec.label}. This AI member keeps its account; assigned tickets wait until runs are supported.`,
          action: null,
        };
      case 'inbox':
        return {
          text: 'Connects through MCP. The board cannot start it; it reads its inbox of assigned tickets and mentions itself.',
          action: null,
        };
      default:
        return { text: st.detail ?? '', action: null };
    }
  })();

  return (
    <div
      className="ai-card"
      data-testid="connection-state"
      data-state={st.code}
      style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16 }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ai-label" style={{ marginBottom: 4 }}>
          Connection
        </div>
        <StatusLabel status={accountOut ? { ...st, label: 'Needs sign-in' } : st} sub={null} />
        <div className="ai-hint" style={{ marginTop: 6 }} data-testid="connection-state-text">
          {copy.text}
        </div>
      </div>
      {copy.action && (
        <button
          type="button"
          className="ai-btn"
          disabled={busy}
          data-testid={copy.action.testId}
          onClick={async () => {
            try {
              await copy.action!.run();
            } catch (err) {
              toast.error(`Could not ${copy.action!.label.toLowerCase()}`, extractError(err));
            }
          }}
        >
          {busy && <span className="ai-spin" />} {copy.action.label}
        </button>
      )}
      {accountOut && (
        <button type="button" className="ai-btn" onClick={() => setChoosing(true)} data-testid="state-action-choose">
          Choose another account
        </button>
      )}
      {signingIn && fullAccount && <SignInWindow account={fullAccount} onClose={() => setSigningIn(false)} />}
      {choosing && <ChangeAccountDialog members={[member]} onClose={() => setChoosing(false)} />}
      {steps && (
        <InstallStepsDialog member={member} onClose={() => setSteps(false)} onCheck={() => void check(false)} />
      )}
    </div>
  );
}
