import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { aiApi, isActive, useAiMutation, useAiRun, useLoadSteps } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { AiRunFull, RunStep } from '../../../types/ai';
import { useToast } from '../../Toast';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { QuestionCard } from '../QuestionCard';
import { RunMessageBox, RunMessages, RunReportCard } from '../RunView';
import { hhmm, money, testsOf, useAiBoardState, useNow } from '../aiUi';
import { elapsedWords } from './runFormat';
import './design/designBlocks.css';

const MONO = "'JetBrains Mono',monospace";
const DOT: CSSProperties = { fontSize: '12px', color: '#9AA8A0', fontWeight: 400, lineHeight: 1.5 };
const CHECK = 'M5 12.5L10 17.5L19 7';

const Svg = ({
  size,
  stroke,
  w = 1.8,
  children,
}: {
  size: number;
  stroke: string;
  w?: number;
  children: ReactNode;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={stroke}
    strokeWidth={w}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    {children}
  </svg>
);

/** A step's title is one line of plain text: the lead's `**bold**` and `code` marks would show as stray characters. */
function plainTitle(title: string): string {
  return title.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

/** "Ran npm test" → ["Ran ", "npm test"]: the verb in plain text and the thing it acted on as code. */
function splitTitle(title: string): [string, string] | null {
  const m = /^(Ran|Edited|Created|Read|Searched|Deleted|Running) (.+)$/.exec(title);
  return m ? [`${m[1]} `, m[2]] : null;
}

function stepFailed(s: RunStep): boolean {
  return s.kind === 'error' || (typeof s.detail?.exitCode === 'number' && s.detail.exitCode !== 0);
}

function StepRow({
  run,
  step,
  role,
  open,
  onToggle,
  last,
}: {
  run: AiRunFull;
  step: RunStep;
  role: string | null;
  open: boolean;
  onToggle: () => void;
  last: boolean;
}) {
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const going = last && run.state === 'running' && step.kind === 'command' && step.detail?.exitCode == null;
  const failed = stepFailed(step);
  const parts = splitTitle(step.title);
  const added = step.detail?.added;
  const removed = step.detail?.removed;
  const code = step.detail?.exitCode;
  // the row is one line; the whole command (or the whole sentence) shows when it is opened
  const fullText = step.kind === 'command' ? (step.detail?.command ?? step.title) : step.title;
  const expandable = step.hasOutput || (typeof fullText === 'string' && fullText.length > 70);
  // a step's output loads when the row is open, by a click or by "Expand all"
  useEffect(() => {
    if (!open || !step.hasOutput || output != null || loading) return;
    setLoading(true);
    aiApi
      .stepOutput(run.id, step.seq)
      .then((r) => setOutput(r.output ?? ''))
      .catch(() => setOutput('(the output could not be loaded)'))
      .finally(() => setLoading(false));
  }, [open, step.hasOutput, step.seq, run.id, output, loading]);
  const toggle = onToggle;
  return (
    <div style={{ borderBottom: '1px solid #EEF3EF', padding: '6px 4px' }} data-testid="run-step" data-kind={step.kind}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: expandable ? 'pointer' : undefined }}
        onClick={expandable ? toggle : undefined}
      >
        <Svg size={12} stroke="#9AA8A0" w={2.2}>
          <path d={open ? 'M6 9L12 15L18 9' : 'M9 6L15 12L9 18'} />
        </Svg>
        {going ? (
          <span
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              border: '2px solid #2E6F4033',
              borderTopColor: '#2E6F40',
              boxSizing: 'border-box',
              flexShrink: 0,
            }}
            className="mc-spin mc-spin-dark"
          />
        ) : failed ? (
          <span style={{ color: '#C4432A', display: 'flex' }}>
            <Svg size={13} stroke="currentColor" w={2.2}>
              <path d="M12 3.5L22 20H2Z" />
              <path d="M12 10V14M12 17.2V17.3" />
            </Svg>
          </span>
        ) : (
          <span style={{ color: '#2E6F40', display: 'flex' }}>
            <Svg size={13} stroke="currentColor" w={2.6}>
              <path d={CHECK} />
            </Svg>
          </span>
        )}
        <span
          style={{
            fontSize: '12.5px',
            color: '#1E2A22',
            fontWeight: going ? 600 : 500,
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {role && <span style={{ color: '#5B6B60', fontWeight: 600, marginRight: 6 }}>{role} ·</span>}
          {parts ? (
            <>
              {going ? 'Running ' : parts[0]}
              <span className="m-code">{parts[1]}</span>
            </>
          ) : (
            plainTitle(step.title)
          )}
          {step.kind === 'command' && typeof code === 'number' && ` · exit ${code}`}
        </span>
        {(added || removed) && (
          <span style={{ fontFamily: MONO, fontSize: '10.5px' }}>
            {added ? <span style={{ color: '#2E6F40' }}>+{added}</span> : null}{' '}
            {removed ? <span style={{ color: '#C4432A' }}>−{removed}</span> : null}
          </span>
        )}
        <span style={{ fontFamily: MONO, fontSize: '10.5px', color: '#9AA8A0' }}>
          {new Date(step.at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })}
        </span>
      </div>
      {open && expandable && (
        <div
          className="mc-code"
          style={{
            margin: '6px 0 4px 22px',
            fontSize: '11px',
            padding: '8px 10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          data-testid="step-full"
        >
          {fullText}
          {step.hasOutput && (
            <>
              {'\n\n'}
              {loading ? 'Loading…' : (output ?? '')}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const Label = ({ children }: { children: ReactNode }) => <div className="td-label">{children}</div>;
const Chip = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
  <span
    className="ai-chip"
    style={
      ok
        ? { background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }
        : { background: '#FDF1EE', color: '#C4432A', border: '1px solid #F0C4B8' }
    }
  >
    {children}
  </span>
);

/**
 * The steps of one run, whole, for the ticket's full history: the request that started it, its steps and its report. It loads the steps the run's first answer left out (the
 * newest 50 come first) and shows each one like the run panel does. `allOpen` opens every step.
 */
export function RunStepsBlock({ runId, allOpen }: { runId: string; allOpen: boolean }) {
  const run = useAiRun(runId).data;
  const loadSteps = useLoadSteps(runId);
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const asked = useRef(false);
  const missing = !!run && run.steps.filter((s) => s.kind !== 'role').length < run.stepsCount;
  useEffect(() => {
    if (!missing || asked.current) return;
    asked.current = true;
    void (async () => {
      let after = 0;
      for (;;) {
        const page = await loadSteps({ after, limit: 500 });
        if (page.length < 500) break;
        after = page[page.length - 1].seq;
      }
    })().catch(() => {
      asked.current = false;
    });
  }, [missing, loadSteps]);
  if (!run) return <span className="ai-spin" />;
  const steps = run.steps.filter((s) => !['hook', 'start', 'end', 'role'].includes(s.kind));
  const roleOf = (id: string | null) => (id ? (run.agents.find((a) => a.id === id)?.agentType ?? 'role') : null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {run.instruction.trim() && (
        <div className="tw-card" data-testid="run-request">
          <div className="ai-label ai-label-dark" style={{ marginBottom: 6 }}>
            Request
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            <MarkdownRenderer plain>{run.instruction}</MarkdownRenderer>
          </div>
        </div>
      )}
      <RunMessages runId={runId} />
      {!steps.length && <span style={{ fontSize: '12px', color: '#9AA8A0' }}>No steps.</span>}
      {steps.map((s, i) => (
        <StepRow
          key={s.seq}
          run={run}
          step={s}
          role={roleOf(s.agentId)}
          open={opened[s.seq] ?? allOpen}
          onToggle={() => setOpened((o) => ({ ...o, [s.seq]: !(o[s.seq] ?? allOpen) }))}
          last={i === steps.length - 1}
        />
      ))}
      <RunReportCard run={run} />
    </div>
  );
}

/**
 * One run, whole, in the canvas design's look ("2. Run panel in ticket detail"): its title, state and actions; who ran
 * it, since when and for how long; the steps (the lead's and its roles', newest 50, a command's output opens on a
 * click) beside the files, commands and test results. The lead's report, its question and a message box (v2) sit above.
 */
export function RunPanel({ runId }: { runId: string }) {
  const q = useAiRun(runId);
  const run = q.data;
  const loadSteps = useLoadSteps(runId);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const { members } = useAiBoardState();
  const toast = useToast();
  const cancel = useAiMutation(() => aiApi.cancel(runId));
  const retry = useAiMutation(() => aiApi.retry(runId));
  // `opened` is what a click changed; every other row follows `allOpen` ("Expand all")
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const [allOpen, setAllOpen] = useState(false);
  const live = !!run && isActive(run.state);
  const now = useNow(1000, run?.state === 'running');
  if (q.isError) return <div className="ai-muted">The run could not be loaded.</div>;
  // a tall placeholder: a short one shrinks the page while another run loads and the browser scrolls it to the top
  if (!run)
    return (
      <div style={{ minHeight: '640px' }}>
        <span className="ai-spin" />
      </div>
    );
  const act = async (fn: () => Promise<unknown>, fail: string) => {
    try {
      await fn();
    } catch (err) {
      toast.error(fail, extractError(err));
    }
  };
  const team = members.get(run.memberId);
  const roleOf = (id: string | null) => (id ? (run.agents.find((a) => a.id === id)?.agentType ?? 'role') : null);
  const steps = run.steps.filter((s) => !['hook', 'start', 'end', 'role'].includes(s.kind));
  const commands = run.steps.filter((s) => s.kind === 'command').slice(-6);
  const tests = testsOf(run);
  const tokens = run.tokensIn + run.tokensOut;
  const earlierMissing = run.steps.filter((s) => s.kind !== 'role').length < run.stepsCount;
  const showEarlier = async () => {
    setLoadingEarlier(true);
    try {
      let after = 0;
      for (;;) {
        const page = await loadSteps({ after, limit: 500 });
        if (page.length < 500) break;
        after = page[page.length - 1].seq;
      }
    } catch (err) {
      toast.error('The earlier steps could not be loaded', extractError(err));
    } finally {
      setLoadingEarlier(false);
    }
  };
  const stateLabel: Record<string, string> = {
    queued: 'Queued',
    starting: 'Starting',
    running: 'Running',
    needs_input: 'Needs input',
    finished: 'Finished',
    failed: 'Failed',
    cancelled: 'Cancelled',
    timed_out: 'Timed out',
  };
  const good = run.state === 'finished' || run.state === 'running' || run.state === 'starting';
  return (
    <div className="dz dz-tw" data-testid="run-view">
      <div style={{ padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '15px', color: '#1E2A22', fontWeight: 700, lineHeight: 1.5 }}>
            {run.mode === 'ask' ? 'Answer' : 'Run'} #{run.number}
          </span>
          <span
            className="ai-chip"
            style={
              good
                ? { background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }
                : { background: '#F1F3F1', color: '#5B6B60', border: '1px solid #DCE3DE' }
            }
          >
            {run.state === 'running' && (
              <span
                className="ai-pulse"
                style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#2E6F40', flexShrink: 0 }}
              />
            )}
            {stateLabel[run.state] ?? run.state}
          </span>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {live && (
              <button
                type="button"
                className="st-btn st-btn-danger-outline st-btn-sm"
                disabled={cancel.isPending}
                data-testid="run-cancel"
                onClick={() => void act(() => cancel.mutateAsync(undefined), "Couldn't cancel the run")}
              >
                <Svg size={12} stroke="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </Svg>
                {run.state === 'queued' ? 'Cancel run' : 'Stop run'}
              </button>
            )}
            {!live && (
              <button
                type="button"
                className="st-btn st-btn-sm"
                disabled={retry.isPending}
                data-testid="run-retry"
                onClick={() => void act(() => retry.mutateAsync(undefined), "Couldn't start a new run")}
              >
                {run.state === 'failed' || run.state === 'timed_out' ? 'Retry' : 'Run again'}
              </button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }} data-testid="run-facts">
          <span
            style={{
              display: 'inline-flex',
              width: '18px',
              height: '18px',
              borderRadius: '5px',
              background: '#DCEEE1',
              color: '#2E6F40',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <path
                d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span style={{ fontSize: '12px', color: '#1E2A22', fontWeight: 600, lineHeight: 1.5 }}>
            {team?.name ?? 'Team'}
          </span>
          <span style={DOT}>·</span>
          <span style={{ fontSize: '12px', color: '#5B6B60', fontWeight: 400, lineHeight: 1.5 }}>
            {run.startedAt ? `started ${hhmm(run.startedAt)}` : `queued ${hhmm(run.queuedAt)}`} by {run.startedBy}
          </span>
          {run.startedAt && (
            <>
              <span style={DOT}>·</span>
              <span style={{ fontSize: '12px', color: '#2E6F40', fontWeight: 700, lineHeight: 1.5, fontFamily: MONO }}>
                {elapsedWords(run, now || Date.now())}
              </span>
            </>
          )}
          <span style={DOT}>·</span>
          <span style={{ fontSize: '12px', color: '#5B6B60', fontWeight: 400, lineHeight: 1.5 }}>
            {run.costUsd > 0 ? money(run.costUsd) : 'Not metered'}
            {tokens > 0 ? ` · ${fmtElapsedTokens(tokens)} tokens` : ''}
          </span>
          {run.report?.branch && (
            <>
              <span style={DOT}>·</span>
              <span
                style={{ fontSize: '11.5px', color: '#1E2A22', fontWeight: 600, lineHeight: 1.5, fontFamily: MONO }}
              >
                {run.report.branch}
              </span>
            </>
          )}
        </div>
        <div className="ai-root" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {run.instruction && (
            <div className="ai-notice ai-notice-info" style={{ fontSize: 12 }} data-testid="run-instruction">
              <b>{run.mode === 'ask' ? 'Question' : 'Instruction'}:</b> {run.instruction}
            </div>
          )}
          {run.state === 'queued' && run.waitingReason && (
            <div className="ai-notice ai-notice-warn" data-testid="why-waiting">
              {run.waitingReason}
            </div>
          )}
          {!live && run.endedReason && (
            <div
              className={`ai-notice ${run.state === 'finished' ? 'ai-notice-info' : run.state === 'cancelled' ? 'ai-notice-slate' : 'ai-notice-error'}`}
            >
              {run.endedReason}
            </div>
          )}
          {run.state === 'needs_input' && run.question && !run.answer && <QuestionCard run={{ ...run }} />}
          <RunReportCard run={run} />
          <RunMessageBox run={run} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '22px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Label>Steps</Label>
              <span
                style={{ fontSize: '11px', color: '#9AA8A0', fontWeight: 400, lineHeight: 1.5 }}
                data-testid="step-count"
              >
                {run.steps.filter((s) => s.kind !== 'role').length >= run.stepsCount
                  ? steps.length
                  : `${steps.length} of ${run.stepsCount}`}
              </span>
              <span style={{ flex: 1 }} />
              {earlierMissing && (
                <button
                  type="button"
                  className="mc-link"
                  onClick={showEarlier}
                  disabled={loadingEarlier}
                  data-testid="show-earlier-steps"
                >
                  {loadingEarlier ? 'Loading…' : 'Show earlier steps'}
                </button>
              )}
              <button
                type="button"
                className="mc-link"
                data-testid="expand-all-steps"
                onClick={async () => {
                  setOpened({});
                  setAllOpen(true);
                  if (earlierMissing) await showEarlier();
                }}
              >
                Expand all
              </button>
              <button
                type="button"
                className="mc-link"
                onClick={() => {
                  setOpened({});
                  setAllOpen(false);
                }}
              >
                Collapse all
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {steps.length === 0 && <span style={{ fontSize: '12px', color: '#9AA8A0' }}>No steps yet.</span>}
              {steps.map((s, i) => (
                <StepRow
                  key={s.seq}
                  run={run}
                  step={s}
                  role={roleOf(s.agentId)}
                  open={opened[s.seq] ?? allOpen}
                  onToggle={() => setOpened((o) => ({ ...o, [s.seq]: !(o[s.seq] ?? allOpen) }))}
                  last={i === steps.length - 1}
                />
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '236px', flexShrink: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Label>Files touched</Label>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: '11px', color: '#9AA8A0', fontWeight: 400, lineHeight: 1.5 }}>
                  {run.files.length} changed
                </span>
              </div>
              {run.files.length === 0 && <span style={{ fontSize: '11.5px', color: '#9AA8A0' }}>None yet.</span>}
              {run.files.map((f) => (
                <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <Svg size={13} stroke="#5B6B60">
                    <path d="M6 3H14L19 8V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
                    <path d="M14 3V8H19" />
                  </Svg>
                  <span
                    title={f.path}
                    style={{
                      fontSize: '12px',
                      color: '#1E2A22',
                      fontWeight: 600,
                      lineHeight: 1.5,
                      fontFamily: MONO,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {f.path.split('/').pop()}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: MONO, fontSize: '10.5px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: '#2E6F40' }}>
                      +{f.added}
                      {f.new ? ' new' : ''}
                    </span>{' '}
                    {!f.new && f.removed > 0 && <span style={{ color: '#C4432A' }}>−{f.removed}</span>}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }} data-testid="run-commands">
              <Label>Commands</Label>
              {commands.length === 0 && <span style={{ fontSize: '11.5px', color: '#9AA8A0' }}>None.</span>}
              {commands.map((c, i) => {
                const code = typeof c.detail?.exitCode === 'number' ? c.detail.exitCode : null;
                const now2 = i === commands.length - 1 && run.state === 'running' && code == null;
                return (
                  <div key={c.seq} style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                    <Chip ok={now2 || code === 0}>
                      {now2 ? (
                        <>
                          <span
                            className="ai-pulse"
                            style={{
                              width: '7px',
                              height: '7px',
                              borderRadius: '50%',
                              background: '#2E6F40',
                              flexShrink: 0,
                            }}
                          />
                          now
                        </>
                      ) : (
                        <>
                          {code === 0 && (
                            <Svg size={11} stroke="currentColor" w={2.6}>
                              <path d={CHECK} />
                            </Svg>
                          )}
                          {code != null ? `exit ${code}` : '—'}
                        </>
                      )}
                    </Chip>
                    <span
                      style={{
                        fontSize: '11.5px',
                        color: '#1E2A22',
                        fontWeight: 500,
                        lineHeight: 1.5,
                        fontFamily: MONO,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.title.replace(/^Ran /, '')}
                    </span>
                  </div>
                );
              })}
            </div>
            {tests && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }} data-testid="run-tests">
                <Label>Test results</Label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {(tests.passed > 0 || tests.failed === 0) && (
                    <Chip ok>
                      <Svg size={11} stroke="currentColor" w={2.6}>
                        <path d={CHECK} />
                      </Svg>
                      {tests.passed} passed
                    </Chip>
                  )}
                  {tests.failed > 0 && (
                    <Chip ok={false}>
                      <Svg size={11} stroke="currentColor" w={2.2}>
                        <path d="M12 3.5L22 20H2Z" />
                        <path d="M12 10V14" />
                        <path d="M12 17.2V17.3" />
                      </Svg>
                      {tests.failed} failed
                    </Chip>
                  )}
                </div>
                {(tests.failing?.length ?? 0) > 0 && (
                  <span style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: 400, lineHeight: 1.5 }}>
                    Failing:{' '}
                    {tests.failing!.map((f) => (
                      <span key={f} className="m-code" style={{ marginRight: 6 }}>
                        {f}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div style={{ fontSize: '11px', color: '#9AA8A0', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Svg size={12} stroke="currentColor">
            <path d="M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z" />
          </Svg>
          Secrets, tokens and key-like strings are masked before the log is stored or shown.
        </div>
      </div>
    </div>
  );
}

/** 12345 → "12.3k". */
function fmtElapsedTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
