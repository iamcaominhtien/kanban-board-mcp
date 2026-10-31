import { useEffect, useMemo, useState } from 'react';
import { aiApi, useAiMutation, useTicketRuns } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiRun, RunStep } from '../../types/ai';
import type { Ticket } from '../../types';
import { useToast } from '../Toast';
import { RaiseLimitButton, TakeOverButton, UndoRunDialog } from './RunActions';
import { SignInAgainButton } from './accounts/SignedOutBanners';
import { testsOf, TestChips } from './ReviewGate';
import {
  ACTIVE_RUN_STATES,
  AiAvatar,
  RunStateChip,
  STATUS_NAMES,
  fmtElapsed,
  hhmm,
  money,
  secondsSince,
  shortDate,
  useAiBoardState,
  useNow,
} from './aiUi';
import './ticketWork.css';

function stepIcon(step: RunStep, last: boolean, live: boolean) {
  if (last && live) return <span className="ai-spin" />;
  if (step.kind === 'error' || step.kind === 'blocked')
    return <span style={{ color: '#C4432A', fontWeight: 800, width: 13, textAlign: 'center' }}>!</span>;
  if (step.kind === 'question' || step.kind === 'approval')
    return <span style={{ color: '#34455A', fontWeight: 800, width: 13, textAlign: 'center' }}>?</span>;
  if (step.kind === 'say') return <span style={{ color: '#9AA8A0', width: 13, textAlign: 'center' }}>“</span>;
  if (step.kind === 'paused' || step.kind === 'resumed')
    return (
      <span style={{ color: '#5B6B60', fontWeight: 800, width: 13, textAlign: 'center' }}>
        {step.kind === 'paused' ? '⏸' : '▷'}
      </span>
    );
  if (step.kind === 'command' && step.exitCode != null && step.exitCode !== 0)
    return <span style={{ color: '#C4432A', fontWeight: 800, width: 13, textAlign: 'center' }}>✕</span>;
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#2E6F40"
      strokeWidth="2.6"
      style={{ flexShrink: 0 }}
    >
      <path d="M5 12.5L10 17.5L19 7" />
    </svg>
  );
}

function StepText({ step, run }: { step: RunStep; run: AiRun }) {
  const m = step.text.match(/^(Edited|Wrote|Read|Ran|Searched) (.+)$/);
  const file = step.kind === 'edit' || step.kind === 'create' ? run.files.find((f) => m && f.path === m[2]) : undefined;
  if (m && ['read', 'edit', 'create', 'command', 'search'].includes(step.kind))
    return (
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {m[1]} <span className="ai-code">{m[2]}</span>
        {step.exitCode != null && (
          <span
            style={{ color: step.exitCode === 0 ? '#5B6B60' : '#C4432A', fontWeight: step.exitCode === 0 ? 400 : 700 }}
          >
            {' '}
            · exit {step.exitCode}
          </span>
        )}
        {file && (
          <span className="ai-mono" style={{ marginLeft: 10, fontSize: 11.5 }}>
            <span style={{ color: '#2E6F40' }}>+{file.added}</span>
            {!file.new && file.removed > 0 && <span style={{ color: '#C4432A' }}> −{file.removed}</span>}
          </span>
        )}
      </span>
    );
  return (
    <span
      style={{
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: step.kind === 'say' ? 'normal' : 'nowrap',
        color: step.kind === 'say' ? '#5B6B60' : undefined,
        flex: 1,
      }}
    >
      {step.text}
      {step.detail ? <span className="ai-muted"> · {step.detail}</span> : null}
    </span>
  );
}

/**
 * The live list of what the run did. A command's step opens to show what it printed (masked) and its exit code;
 * the failing one opens by itself. `collapseKey` changing collapses every row (“Collapse all”).
 */
export function RunSteps({ run, compact, collapseKey = 0 }: { run: AiRun; compact?: boolean; collapseKey?: number }) {
  const steps = compact ? run.steps.slice(-5) : run.steps;
  const live = run.state === 'running' || run.state === 'starting';
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => setOpen(new Set()), [collapseKey]);
  if (!steps.length) return <div className="ai-muted">{live ? 'Starting the CLI…' : 'No steps recorded.'}</div>;
  const offset = run.steps.length - steps.length;
  return (
    <div className="ai-steps" data-testid="run-steps">
      {steps.map((s, i) => {
        const n = offset + i;
        const expandable = !!s.output;
        const failing = s.kind === 'command' && s.exitCode != null && s.exitCode !== 0;
        const isOpen = expandable && (open.has(n) || (failing && !open.has(-n - 1)));
        const toggle = () =>
          setOpen((cur) => {
            const next = new Set(cur);
            // a failing step is open by default: closing it is remembered with the negative index
            if (failing && !open.has(n)) {
              if (next.has(-n - 1)) next.delete(-n - 1);
              else next.add(-n - 1);
            } else if (next.has(n)) next.delete(n);
            else next.add(n);
            return next;
          });
        return (
          <div key={n} data-testid="run-step">
            <div className="ai-step-row">
              {expandable ? (
                <button
                  type="button"
                  className="tw-chev"
                  aria-expanded={isOpen}
                  aria-label={isOpen ? 'Hide output' : 'Show output'}
                  data-testid="step-toggle"
                  onClick={toggle}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    style={{ transform: isOpen ? 'rotate(90deg)' : undefined }}
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              ) : (
                <span style={{ width: 20, flexShrink: 0 }} />
              )}
              {stepIcon(s, i === steps.length - 1, live)}
              <StepText step={s} run={run} />
              <span className="ai-step-time">{s.at}</span>
            </div>
            {isOpen && (
              <pre className="tw-term" data-testid="step-output">
                <span style={{ color: '#7BC48F' }}>$ {s.text.replace(/^Ran /, '')}</span>
                {'\n'}
                {s.output}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** “main branch → status” sentence of a run's status changes: To Do → In Progress → To Do. */
export function statusPath(run: AiRun): string {
  if (!run.statusChanges.length) return '';
  return [run.statusChanges[0].from, ...run.statusChanges.map((c) => c.to)]
    .map((s) => STATUS_NAMES[s] ?? s)
    .join(' → ');
}

/** Who or what ended a run, in words (the archive, a take-over, a person's Cancel). */
function endedWords(run: AiRun): string {
  if (run.stopCode === 'archive') return `Cancelled by archive${run.endedBy ? ` (${run.endedBy})` : ''}`;
  if (run.stopCode === 'deleted') return 'Cancelled: the ticket was deleted';
  if (run.stopCode === 'takeover') return `Taken over by ${run.endedBy ?? 'a person'}`;
  if (run.stopCode === 'reassigned') return `Cancelled: ${run.endedReason ?? 'the ticket was reassigned'}`;
  return `${run.endedReason ?? ''}${run.endedBy && !run.endedReason?.includes(run.endedBy) ? ` (by ${run.endedBy})` : ''}`;
}

/** The run stopped on a budget limit mid-way (the agent loop writes “Stopped · budget at step N”). */
export function budgetStop(run: AiRun): { step: number | null } | null {
  if (run.state !== 'failed' || !/^Stopped · budget/.test(run.endedReason ?? '')) return null;
  const m = (run.endedReason ?? '').match(/at step (\d+)/);
  return { step: m ? Number(m[1]) : null };
}

/** Amber box under a run that a budget stopped: work is kept, Continue at 00:00 / Raise budget (H4). */
export function BudgetStopBox({ run }: { run: AiRun }) {
  const stop = budgetStop(run);
  const { members, openAiPage } = useAiBoardState();
  const ai = members.get(run.memberId);
  const toast = useToast();
  const retry = useAiMutation(() => aiApi.retry(run.id));
  if (!stop) return null;
  const of = run.stepEstimate ? ` of about ${run.stepEstimate}` : '';
  return (
    <div className="ai-notice ai-notice-warn" style={{ alignItems: 'flex-start' }} data-testid="budget-stop">
      <div style={{ flex: 1 }}>
        <b>Run stopped{stop.step ? ` at step ${stop.step}${of}` : ''}</b>
        <div>
          {run.endedReason!.replace(/^Stopped · budget(?: at step \d+)?:?\s*/, '') || 'The budget was reached mid-run.'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={retry.isPending}
            data-testid="budget-continue"
            onClick={async () => {
              try {
                await retry.mutateAsync(undefined);
                toast.success(`Run #${run.number + 1} queued`, 'It waits for the budget to reset, then continues.');
              } catch (err) {
                toast.error("Couldn't queue the run", extractError(err));
              }
            }}
          >
            Continue at 00:00
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            data-testid="budget-raise"
            onClick={() => openAiPage?.(ai?.id ?? run.memberId)}
          >
            Raise budget
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tokens, cost and the member's daily budget (D3); a local runner is “Not metered”. */
export function UsageCard({ run }: { run: AiRun }) {
  const { members } = useAiBoardState();
  const ai = members.get(run.memberId);
  const budget = ai?.dailyBudget ?? null;
  const spent = ai?.usage.costToday ?? 0;
  const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const full = !!budget && spent >= budget;
  return (
    <div className="tw-usage" data-testid="usage-card">
      <div className="ai-label">Usage</div>
      <div style={{ fontSize: 12, color: '#5B6B60', margin: '2px 0 8px' }}>
        {run.memberName} · run #{run.number} on <span className="ai-mono">{run.ticketId}</span>
      </div>
      {run.metered ? (
        <>
          <div className="tw-usage-grid">
            <div>
              <div className="ai-muted">Tokens in</div>
              <b className="ai-mono">{fmtTokens(run.tokensIn)}</b>
            </div>
            <div>
              <div className="ai-muted">Tokens out</div>
              <b className="ai-mono">{fmtTokens(run.tokensOut)}</b>
            </div>
            <div>
              <div className="ai-muted">Cost</div>
              <b className="ai-mono">{money(run.costUsd)}</b>
            </div>
          </div>
          {budget != null && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span className="ai-muted">Daily budget</span>
                <span className="ai-mono" style={{ fontWeight: 700, color: full ? '#B4571F' : '#1E2A22' }}>
                  {money(spent)} of {money(budget)}
                </span>
              </div>
              <div className="tw-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${pct}%`, background: full ? '#C4432A' : pct > 80 ? '#B4791E' : '#2E6F40' }} />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="ai-hint">Not metered: a local runner uses your signed-in CLI.</div>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(Math.round(n / 100) / 10).toString()}k` : String(n);
}

/** Run panel in ticket detail (D2): steps, files, commands, tests, usage and the actions of its state. */
export function RunView({ run, ticket }: { run: AiRun; ticket: Ticket }) {
  const toast = useToast();
  const { members } = useAiBoardState();
  const ai = members.get(run.memberId);
  const cancel = useAiMutation(() => aiApi.cancel(run.id));
  const retry = useAiMutation(() => aiApi.retry(run.id));
  const pause = useAiMutation(() => aiApi.pauseRun(run.id));
  const resume = useAiMutation(() => aiApi.resumeRun(run.id));
  const startNow = useAiMutation(() => aiApi.startNow(run.id));
  const [terminal, setTerminal] = useState(false);
  const [undo, setUndo] = useState(false);
  const [collapseKey, setCollapseKey] = useState(0);
  const live = ACTIVE_RUN_STATES.includes(run.state);
  const running = run.state === 'running' || run.state === 'starting';
  useNow(1000, running);
  const commands = run.steps.filter((s) => s.kind === 'command' && s.text.startsWith('Ran '));
  const elapsed = running ? secondsSince(run.startedAt) : run.elapsedS;
  const tests = testsOf(run);
  const branch = (ticket.branches ?? [])
    .map((b) => String((b as { name?: string }).name ?? ''))
    .find((n) => n.startsWith('ai/'));
  const act = async (fn: () => Promise<unknown>, failure: string) => {
    try {
      await fn();
    } catch (err) {
      toast.error(failure, extractError(err));
    }
  };
  const canUndo = run.mode === 'work' && !live && (run.statusChanges.length > 0 || run.files.length > 0);
  const waitingForHold = run.state === 'queued' && !!run.behindRunId;
  return (
    <div className="ai-run-panel ai-root" data-testid="run-view">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800 }}>
          {run.mode === 'ask' ? 'Answer' : 'Run'} #{run.number}
        </span>
        <RunStateChip state={run.state} />
        {run.paused && <RunStateChip state="paused" />}
        {run.stopCode === 'archive' && (
          <span
            className="ai-chip"
            style={{ background: '#F1F3F2', color: '#5B6B60' }}
            data-testid="cancelled-by-archive"
          >
            Cancelled by archive
          </span>
        )}
        {budgetStop(run) && (
          <span className="ai-chip" style={{ background: '#FDF0E6', color: '#B4571F' }}>
            Stopped · budget
          </span>
        )}
        <span style={{ flex: 1 }} />
        {run.state === 'running' && run.mode === 'work' && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={pause.isPending || resume.isPending}
            data-testid={run.paused ? 'run-resume' : 'run-pause'}
            onClick={() =>
              act(
                () => (run.paused ? resume : pause).mutateAsync(undefined),
                run.paused ? "Couldn't resume" : "Couldn't pause",
              )
            }
          >
            {run.paused ? '▷ Resume' : '⏸ Pause'}
          </button>
        )}
        {run.state === 'queued' && !waitingForHold && (
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={startNow.isPending}
            data-testid="run-start-now"
            onClick={() => act(() => startNow.mutateAsync(undefined), "Can't start it now")}
          >
            ▷ Start now
          </button>
        )}
        {live && (
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-danger-outline"
            onClick={() => cancel.mutate(undefined)}
            disabled={cancel.isPending}
            data-testid="run-cancel"
          >
            ◻ Cancel run
          </button>
        )}
        {!live && run.mode === 'work' && (
          <>
            {ai && ['failed', 'timed_out'].includes(run.state) && <SignInAgainButton member={ai} primary />}
            <button
              type="button"
              className={`ai-btn ai-btn-sm ${run.state === 'failed' || run.state === 'timed_out' ? 'ai-btn-primary' : ''}`}
              data-testid="run-retry"
              onClick={() => act(() => retry.mutateAsync(undefined), "Couldn't start a new run")}
            >
              {run.state === 'failed' || run.state === 'timed_out' ? 'Retry' : 'Run again'}
            </button>
            {['failed', 'timed_out'].includes(run.state) && (
              <TakeOverButton ticketId={run.ticketId} projectId={run.projectId} />
            )}
            {run.state === 'timed_out' && <RaiseLimitButton run={run} />}
            {canUndo && (
              <button type="button" className="ai-btn ai-btn-sm" data-testid="run-undo" onClick={() => setUndo(true)}>
                ↶ Undo changes
              </button>
            )}
          </>
        )}
        {run.sessionId && ai?.connection === 'local' && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => setTerminal(!terminal)}>
            ▭ Open in terminal
          </button>
        )}
      </div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5B6B60', flexWrap: 'wrap' }}
      >
        {ai && <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={20} />}
        <b style={{ color: '#1E2A22' }}>{run.memberName}</b>·
        <span>
          {run.startedAt ? `started ${hhmm(run.startedAt)}` : `queued ${hhmm(run.queuedAt)}`} by {run.startedBy}
        </span>
        ·
        <span className="ai-mono" style={{ color: '#2E6F40', fontWeight: 600 }}>
          {fmtElapsed(elapsed)}
        </span>
        ·
        <span>
          {run.metered
            ? `${money(run.costUsd)} · ${Math.round(run.tokensIn / 1000)}k in · ${Math.round(run.tokensOut / 100) / 10}k out`
            : 'Not metered'}
        </span>
        {branch && (
          <>
            · <span className="ai-mono">{branch}</span>
          </>
        )}
        {run.model && (
          <>
            · <span className="ai-mono">{run.model}</span>
          </>
        )}
      </div>
      {run.instruction && (
        <div className="ai-notice ai-notice-info" style={{ fontSize: 12 }}>
          <b>{run.mode === 'ask' ? 'Question' : 'Instruction'}:</b> {run.instruction}
        </div>
      )}
      {run.state === 'queued' && run.waitingReason && (
        <div className="ai-notice ai-notice-slate">
          {run.queuePosition ? `#${run.queuePosition} in the queue · ` : ''}
          {run.waitingReason}
        </div>
      )}
      {run.paused && (
        <div className="ai-notice ai-notice-slate" data-testid="run-paused-note">
          Paused: the agent is stopped where it was and its time limits are not running. Resume continues from here.
        </div>
      )}
      {run.endedReason && !live && !budgetStop(run) && (
        <div
          className={`ai-notice ${run.state === 'finished' ? 'ai-notice-info' : run.state === 'cancelled' ? 'ai-notice-slate' : 'ai-notice-error'}`}
        >
          {endedWords(run)}
          {run.state === 'cancelled' && run.statusChanges.some((c) => c.kind === 'cancel')
            ? ` · the status returned to ${STATUS_NAMES[run.statusBefore ?? ''] ?? run.statusBefore}; files stay on the branch`
            : ''}
        </div>
      )}
      <BudgetStopBox run={run} />
      {run.contextNotes.length > 0 && (
        <div className="ai-notice ai-notice-warn" style={{ fontSize: 12.5 }} data-testid="context-notes">
          <div>
            {run.contextNotes.map((n, i) => (
              <div key={i}>
                {n.by} edited {n.what}.{' '}
                {n.delivered ? `Run #${run.number} refreshed its context.` : `It gets the new text at its next step.`}
              </div>
            ))}
          </div>
        </div>
      )}
      {terminal && run.sessionId && (
        <div className="ai-card" style={{ padding: 12, background: '#F6FAF7' }}>
          <div className="ai-hint">
            Opens a terminal in <span className="ai-code">{ai?.workingDir}</span> and resumes this run’s session, as if
            you had typed:
          </div>
          <div className="ai-term" style={{ marginTop: 6 }}>
            $ cd {ai?.workingDir} && claude --resume {run.sessionId}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(`cd ${ai?.workingDir} && claude --resume ${run.sessionId}`);
                toast.success('Command copied');
              }}
            >
              Copy command
            </button>
            <span className="ai-muted">Cancel the board’s run first if you want the hold.</span>
          </div>
        </div>
      )}
      <div className="tw-runcols">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span className="ai-label">Steps</span>
            <span className="ai-muted" data-testid="step-count">
              {run.steps.length}
              {live && run.stepEstimate ? ` of ~${Math.max(run.stepEstimate, run.steps.length)}` : ''}
            </span>
            <span style={{ flex: 1 }} />
            {run.steps.some((s) => s.output) && (
              <button
                type="button"
                className="ai-link"
                onClick={() => setCollapseKey((k) => k + 1)}
                data-testid="collapse-all"
              >
                Collapse all
              </button>
            )}
          </div>
          <RunSteps run={run} collapseKey={collapseKey} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="ai-label">Files touched</span>
              <span className="ai-muted">{run.files.length} changed</span>
            </div>
            {run.files.length === 0 && <div className="ai-muted">None yet.</div>}
            {run.files.map((f) => (
              <div key={f.path} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '4px 0' }}>
                <span className="ai-mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {f.path}
                </span>
                <span className="ai-mono" style={{ color: '#2E6F40' }}>
                  +{f.added}
                </span>
                {f.new ? (
                  <span className="ai-mono" style={{ color: '#2E6F40' }}>
                    new
                  </span>
                ) : (
                  f.removed > 0 && (
                    <span className="ai-mono" style={{ color: '#C4432A' }}>
                      −{f.removed}
                    </span>
                  )
                )}
              </div>
            ))}
          </div>
          <div>
            <span className="ai-label">Commands</span>
            {commands.length === 0 && <div className="ai-muted">None.</div>}
            {commands.slice(-6).map((c, i) => {
              const last = i === commands.slice(-6).length - 1 && running && c.exitCode == null;
              return (
                <div key={i} className="tw-cmd">
                  <span
                    className="tw-exit"
                    style={
                      last
                        ? { background: '#F1F8F3', color: '#2E6F40' }
                        : c.exitCode === 0
                          ? { background: '#F1F8F3', color: '#2E6F40' }
                          : { background: '#FBEEEA', color: '#C4432A' }
                    }
                  >
                    {last ? '● now' : c.exitCode != null ? `${c.exitCode === 0 ? '✓ ' : ''}exit ${c.exitCode}` : '—'}
                  </span>
                  <span
                    className="ai-mono"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {c.text.replace(/^Ran /, '')}
                  </span>
                </div>
              );
            })}
          </div>
          {tests && (
            <div data-testid="run-tests">
              <span className="ai-label">Test results</span>
              <div style={{ margin: '6px 0' }}>
                <TestChips counts={tests.counts} />
              </div>
              {(tests.counts.failing?.length ?? 0) > 0 && (
                <div style={{ fontSize: 12.5, color: '#5B6B60' }}>
                  Failing:{' '}
                  {tests.counts.failing!.map((f) => (
                    <span key={f} className="ai-code" style={{ marginRight: 6 }}>
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {run.statusChanges.length > 0 && (
            <div>
              <span className="ai-label">Status changes</span>
              <div style={{ fontSize: 12.5, marginTop: 4 }} data-testid="run-status-path">
                {statusPath(run)}
                {run.statusChanges.some((c) => c.kind === 'cancel') && (
                  <span className="ai-muted"> · returned at cancel</span>
                )}
              </div>
            </div>
          )}
          <UsageCard run={run} />
        </div>
      </div>
      <div className="ai-muted">
        🛡 Secrets, tokens and key-like strings are masked before the log is stored or shown.
      </div>
      {undo && <UndoRunDialog run={run} onClose={() => setUndo(false)} />}
    </div>
  );
}

/** What a run did to the ticket, as a note under its status change in the history (D5). */
function historyNote(r: AiRun): string {
  if (r.mode === 'ask') return 'no changes (answer only)';
  const notes: string[] = [];
  if (r.statusChanges.some((c) => c.kind === 'cancel')) notes.push('status returned at cancel');
  else if (['failed', 'timed_out'].includes(r.state) && r.files.length) notes.push('partial changes kept');
  else if (r.files.length) notes.push(`${r.files.length} file${r.files.length === 1 ? '' : 's'}`);
  if (r.stopCode === 'archive') notes.push('cancelled by archive');
  return notes.join(' · ');
}

/** Every run on this ticket, newest first, with the status changes each one made and its own Undo (D5). */
export function RunHistory({
  runs,
  onSelect,
  selectedId,
}: {
  runs: AiRun[];
  onSelect: (id: string) => void;
  selectedId?: string;
}) {
  const [undo, setUndo] = useState<AiRun | null>(null);
  return (
    <>
      <table className="ai-table" data-testid="run-history">
        <thead>
          <tr>
            <th>Run</th>
            <th>Agent</th>
            <th>Started by</th>
            <th>State</th>
            <th>Time</th>
            <th>Usage</th>
            <th>Status change</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const note = historyNote(r);
            const undoable = r.mode === 'work' && !ACTIVE_RUN_STATES.includes(r.state) && r.statusChanges.length > 0;
            return (
              <tr
                key={r.id}
                onClick={() => onSelect(r.id)}
                style={{ cursor: 'pointer', background: selectedId === r.id ? '#F6FAF7' : undefined }}
                data-testid="run-history-row"
              >
                <td style={{ fontWeight: 700 }}>#{r.number}</td>
                <td>{r.memberName}</td>
                <td className="ai-muted">
                  {r.mode === 'ask' ? 'Ask' : r.trigger === 'assign' ? 'Assigned' : r.trigger.replace(/_/g, ' ')} by{' '}
                  {r.startedBy},{' '}
                  {r.queuedAt && new Date(r.queuedAt).toDateString() !== new Date().toDateString()
                    ? shortDate(r.queuedAt)
                    : hhmm(r.queuedAt)}
                </td>
                <td>
                  <RunStateChip state={r.state} />
                </td>
                <td>{fmtElapsed(r.elapsedS)}</td>
                <td className="ai-muted">{r.metered ? money(r.costUsd) : 'Not metered'}</td>
                <td className="ai-muted">
                  {r.statusChanges.length ? statusPath(r) : null}
                  {note && (
                    <div>
                      {r.statusChanges.length ? '· ' : ''}
                      {note}
                    </div>
                  )}
                  {!r.statusChanges.length && !note && '—'}
                  {undoable && (
                    <button
                      type="button"
                      className="ai-link"
                      style={{ display: 'block', marginTop: 2 }}
                      data-testid="history-undo"
                      onClick={(e) => {
                        e.stopPropagation();
                        setUndo(r);
                      }}
                    >
                      Undo run’s changes
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {undo && <UndoRunDialog run={undo} onClose={() => setUndo(null)} />}
    </>
  );
}

/** The AI tab of ticket detail: the selected (or the holder's latest) run and the run history. */
export function TicketRunsTab({ ticket, runId }: { ticket: Ticket; runId?: string | null }) {
  const runs = useTicketRuns(ticket.id);
  const [selected, setSelected] = useState<string | null>(runId ?? null);
  useEffect(() => {
    if (runId) setSelected(runId);
  }, [runId]);
  const list = useMemo(() => runs.data ?? [], [runs.data]);
  const run = useMemo(
    () =>
      list.find((r) => r.id === selected) ??
      list.find((r) => r.mode === 'work' && !r.behindRunId) ??
      list.find((r) => r.mode === 'work') ??
      list[0],
    [list, selected],
  );
  if (runs.isLoading) return <span className="ai-spin" />;
  if (!run)
    return (
      <div className="ai-card ai-root" style={{ padding: 20 }}>
        <b>No AI runs on this ticket yet</b>
        <div className="ai-hint">Assign it to an AI member, or @mention one in a comment and pick “Do the work”.</div>
      </div>
    );
  return (
    <div className="ai-root" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }}>
      <RunView run={run} ticket={ticket} />
      <div className="ai-card" style={{ padding: 12 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>Run history for {ticket.id}</div>
        <RunHistory runs={list} onSelect={setSelected} selectedId={run.id} />
      </div>
    </div>
  );
}
