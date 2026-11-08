import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { aiApi, isActive, useAiMutation, useAiRun, useLoadSteps } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { AiRunFull, RunStep } from '../../../types/ai';
import { useToast } from '../../Toast';
import { QuestionCard } from '../QuestionCard';
import { RunMessageBox, RunMessages, RunReportCard } from '../RunView';
import { RunChip } from './RunHistoryTable';
import { LineIcon } from '../../ui/LineIcon';
import { hhmm, money, testsOf, useAiBoardState, useNow } from '../aiUi';
import { elapsedWords } from './runFormat';
import './design/designBlocks.css';

const MONO = "'JetBrains Mono',monospace";
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
  // "Read the ticket and acceptance criteria" is a sentence, not a file: only a path or a command is code
  if (m && (m[1] === 'Read' || m[1] === 'Searched') && /\s/.test(m[2])) return null;
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

const ROLE_COLORS = ['#2E6F40', '#3A5FA8', '#9C5B16', '#7A4B9C', '#B0457A', '#2A7F86'];
const roleColor = (type: string): string => {
  let h = 0;
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ROLE_COLORS[h % ROLE_COLORS.length];
};

/** The steps in the order they happened: a subagent's stretch of work (the same agent, one step after the other) is one group. */
type StepItem = { kind: 'step'; step: RunStep } | { kind: 'group'; agentId: string; steps: RunStep[] };

function groupSteps(steps: RunStep[]): StepItem[] {
  const items: StepItem[] = [];
  for (const step of steps) {
    const last = items[items.length - 1];
    if (!step.agentId) items.push({ kind: 'step', step });
    else if (last?.kind === 'group' && last.agentId === step.agentId) last.steps.push(step);
    else items.push({ kind: 'group', agentId: step.agentId, steps: [step] });
  }
  return items;
}

/**
 * The steps of a run as the lead tells them, with what each subagent did folded under the line that handed it the
 * work: "dev · 12 steps · 1m 20s" and its last words. A group that is working is open, a finished one is closed;
 * `opened` holds the clicks (a step by its seq, a group by minus the seq of its first step) and `allOpen` is "Expand all".
 */
function StepList({
  run,
  steps,
  opened,
  allOpen,
  onToggle,
}: {
  run: AiRunFull;
  steps: RunStep[];
  opened: Record<number, boolean>;
  allOpen: boolean;
  onToggle: (key: number, wasOpen: boolean) => void;
}) {
  const items = groupSteps(steps);
  const lastSeq = steps.length ? steps[steps.length - 1].seq : -1;
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'step')
          return (
            <StepRow
              key={item.step.seq}
              run={run}
              step={item.step}
              role={null}
              open={opened[item.step.seq] ?? allOpen}
              onToggle={() => onToggle(item.step.seq, opened[item.step.seq] ?? allOpen)}
              last={item.step.seq === lastSeq}
            />
          );
        const first = item.steps[0];
        const end = item.steps[item.steps.length - 1];
        const agent = run.agents.find((a) => a.id === item.agentId);
        const type = agent?.agentType ?? 'role';
        const color = roleColor(type);
        const span = agent?.spans?.[agent.spans.length - 1];
        const working = isActive(run.state) && end.seq === lastSeq && (span ? span.end == null : !agent?.endedAt);
        const key = -first.seq;
        const open = opened[key] ?? (allOpen || working);
        const failedCount = item.steps.filter(stepFailed).length;
        const said = [...item.steps].reverse().find((x) => x.kind === 'text');
        return (
          <div
            key={key}
            data-testid="step-group"
            data-open={open ? 'true' : 'false'}
            style={{ borderLeft: `3px solid ${color}`, borderRadius: 2, margin: '3px 0' }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => onToggle(key, open)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(key, open);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 8px',
                cursor: 'pointer',
                background: '#F6FAF7',
              }}
            >
              <Svg size={12} stroke="#9AA8A0" w={2.2}>
                <path d={open ? 'M6 9L12 15L18 9' : 'M9 6L15 12L9 18'} />
              </Svg>
              {working ? (
                <span className="ai-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
              ) : (
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              )}
              <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#1E2A22' }}>{type}</span>
              <span style={{ fontSize: '11.5px', color: '#5B6B60', whiteSpace: 'nowrap' }}>
                {item.steps.length} step{item.steps.length === 1 ? '' : 's'} ·{' '}
                {elapsedWords({ startedAt: first.at, endedAt: working ? null : end.at }, Date.now())}
                {failedCount > 0 && <span style={{ color: '#C4432A' }}> · {failedCount} failed</span>}
                {working && ' · working'}
              </span>
              {!open && said && (
                <span
                  style={{
                    fontSize: '12px',
                    color: '#5B6B60',
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  “{plainTitle(said.title)}”
                </span>
              )}
              {open && <span style={{ flex: 1 }} />}
              <span style={{ fontFamily: MONO, fontSize: '10.5px', color: '#9AA8A0' }}>
                {new Date(first.at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                })}
              </span>
            </div>
            {open && (
              <div style={{ marginLeft: '10px', borderLeft: `3px solid ${color}55` }}>
                {item.steps.map((x) => (
                  <StepRow
                    key={x.seq}
                    run={run}
                    step={x}
                    role={null}
                    open={opened[x.seq] ?? allOpen}
                    onToggle={() => onToggle(x.seq, opened[x.seq] ?? allOpen)}
                    last={x.seq === lastSeq}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The steps of one run, whole, for the ticket's full history: the request that started it, its steps and its report. It loads the steps the run's first answer left out (the
 * newest 50 come first) and shows each one like the run panel does. `allOpen` opens every step.
 */
export function RunStepsBlock({ runId, allOpen }: { runId: string; allOpen: boolean }) {
  const run = useAiRun(runId).data;
  const loadSteps = useLoadSteps(runId);
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  // the run's steps are folded behind their count; "Expand all" / "Collapse all" of the page opens or folds them
  const [showSteps, setShowSteps] = useState(allOpen);
  useEffect(() => setShowSteps(allOpen), [allOpen]);
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {run.instruction.trim() && (
        <Notice tone="blue" testId="run-request">
          <b>Request</b> {run.instruction}
        </Notice>
      )}
      <RunMessages runId={runId} />
      <button
        type="button"
        aria-expanded={showSteps}
        data-testid="full-history-steps"
        onClick={() => setShowSteps((v) => !v)}
        style={{
          alignSelf: 'flex-start',
          border: 'none',
          background: 'none',
          padding: 0,
          fontFamily: 'inherit',
          fontSize: '12px',
          color: '#5B6B60',
          cursor: steps.length ? 'pointer' : undefined,
        }}
      >
        {steps.length === 0
          ? 'No steps yet.'
          : `${steps.length}${isActive(run.state) ? ' steps so far' : steps.length === 1 ? ' step' : ' steps'}`}
      </button>
      {showSteps && steps.length > 0 && (
        <StepList
          run={run}
          steps={steps}
          opened={opened}
          allOpen={allOpen}
          onToggle={(key, wasOpen) => setOpened((o) => ({ ...o, [key]: !wasOpen }))}
        />
      )}
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
  const [noMoreEarlier, setNoMoreEarlier] = useState(false);
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
  const steps = run.steps.filter((s) => !['hook', 'start', 'end', 'role'].includes(s.kind));
  const commands = run.steps.filter((s) => s.kind === 'command').slice(-6);
  const tests = testsOf(run);
  const tokens = run.tokensIn + run.tokensOut;
  // a load that brought nothing new (the run holds fewer rows than it counted) ends the offer
  const earlierMissing = !noMoreEarlier && run.steps.filter((s) => s.kind !== 'role').length < run.stepsCount;
  const showEarlier = async () => {
    setLoadingEarlier(true);
    try {
      let after = 0;
      for (;;) {
        const page = await loadSteps({ after, limit: 500 });
        if (page.length < 500) break;
        after = page[page.length - 1].seq;
      }
      setNoMoreEarlier(true);
    } catch (err) {
      toast.error('The earlier steps could not be loaded', extractError(err));
    } finally {
      setLoadingEarlier(false);
    }
  };
  const usageWords = `${run.costUsd > 0 ? money(run.costUsd) : 'Not metered'}${tokens > 0 ? ` · ${fmtElapsedTokens(tokens)} tokens` : ''}`;
  // a run that is only waiting or just starting is one line; the facts strip is for a run that goes on
  const started = !!run.startedAt && run.state !== 'starting';
  const stepsBlock = (
    <div
      style={{
        flex: '1 1 320px',
        minWidth: 0,
        border: '1px solid #E3E8E5',
        borderRadius: '11px',
        padding: '10px 12px',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}
      data-testid="run-steps"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <Label>
          Steps{' '}
          <b style={{ color: '#1E2A22' }} data-testid="step-count">
            {noMoreEarlier || run.steps.filter((s) => s.kind !== 'role').length >= run.stepsCount
              ? steps.length
              : `${steps.length} of ${run.stepsCount}`}
          </b>
        </Label>
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
        {steps.length === 0 && (
          <span style={{ fontSize: '12px', color: '#9AA8A0', padding: '6px 4px' }} data-testid="no-steps">
            {run.state === 'starting' ? 'Starting Claude Code…' : 'No steps yet.'}
          </span>
        )}
        <StepList
          run={run}
          steps={steps}
          opened={opened}
          allOpen={allOpen}
          onToggle={(key, wasOpen) => setOpened((o) => ({ ...o, [key]: !wasOpen }))}
        />
      </div>
    </div>
  );
  const rail = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '250px', flex: 'none' }}>
      <RailCard
        title="Files touched"
        note={`${run.files.length} changed`}
        testId="run-files"
        empty={run.files.length === 0 ? 'None yet.' : null}
      >
        {run.files.map((f) => (
          <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px' }}>
            <Svg size={13} stroke="#5B6B60">
              <path d="M6 3H14L19 8V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
              <path d="M14 3V8H19" />
            </Svg>
            <span
              title={f.path}
              style={{
                fontFamily: MONO,
                fontSize: '11.5px',
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {f.path.split('/').pop()}
            </span>
            <span style={{ fontFamily: MONO, fontSize: '10.5px', whiteSpace: 'nowrap' }}>
              <span style={{ color: '#2E6F40' }}>
                +{f.added}
                {f.new ? ' new' : ''}
              </span>{' '}
              {!f.new && f.removed > 0 && <span style={{ color: '#C4432A' }}>−{f.removed}</span>}
            </span>
          </div>
        ))}
      </RailCard>
      <RailCard title="Commands" testId="run-commands" empty={commands.length === 0 ? 'None.' : null}>
        {commands.map((c, i) => {
          const code = typeof c.detail?.exitCode === 'number' ? c.detail.exitCode : null;
          const now2 = i === commands.length - 1 && run.state === 'running' && code == null;
          return (
            <div key={c.seq} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '11.5px' }}>
              <span className="ai-chip" style={{ ...(now2 || code === 0 ? CHIP_OK : CHIP_BAD), height: 18 }}>
                {now2 ? (
                  <>
                    <span
                      className="ai-pulse"
                      style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2E6F40' }}
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
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: '11px',
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
      </RailCard>
      {tests && (
        <RailCard title="Test results" testId="run-tests">
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
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
            <div style={{ fontSize: '11.5px', color: '#5B6B60' }}>
              Failing:{' '}
              {tests.failing!.map((f) => (
                <span key={f} className="m-code" style={{ marginRight: 6 }}>
                  {f}
                </span>
              ))}
            </div>
          )}
        </RailCard>
      )}
    </div>
  );
  return (
    <div className="dz dz-tw" data-testid="run-view">
      <div
        style={{
          boxSizing: 'border-box',
          border: '1px solid #E3E8E5',
          borderRadius: '12px',
          background: '#fff',
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '15px', color: '#1E2A22', fontWeight: 700 }}>
            {run.mode === 'ask' ? 'Answer' : 'Run'} #{run.number}
          </span>
          <RunChip state={run.state} />
          <span style={{ flex: 1 }} />
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
              <Svg size={12} stroke="currentColor">
                <path d="M20 11A8 8 0 1 0 18.3 16.2" />
                <path d="M20 4.5V11H13.5" />
              </Svg>
              {run.state === 'failed' || run.state === 'timed_out' ? 'Retry' : 'Run again'}
            </button>
          )}
        </div>
        {started ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              rowGap: '8px',
              padding: '9px 0',
              borderRadius: '10px',
              background: '#F6F8F6',
            }}
            data-testid="run-facts"
          >
            <Fact label="Team" first>
              <TeamTile size={20} />
              <b>{team?.name ?? 'Team'}</b>
            </Fact>
            <Fact label="Started">
              {hhmm(run.startedAt)} · {run.startedBy}
            </Fact>
            <Fact label="Time">
              <span style={{ fontFamily: MONO, color: '#2E6F40', fontWeight: 700 }}>
                {elapsedWords(run, now || Date.now())}
              </span>
            </Fact>
            <Fact label="Usage">{usageWords}</Fact>
            {run.report?.branch && (
              <Fact label="Branch">
                <span style={{ fontFamily: MONO, fontSize: '11.5px' }}>{run.report.branch}</span>
              </Fact>
            )}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flexWrap: 'wrap',
              fontSize: '12px',
              color: '#3A4A3E',
            }}
            data-testid="run-facts"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <TeamTile size={16} />
              <b>{team?.name ?? 'Team'}</b>
            </span>
            <span style={{ color: '#9AA8A0' }}>·</span>
            <span>
              {run.startedAt ? `started ${hhmm(run.startedAt)}` : `queued ${hhmm(run.queuedAt)}`} by {run.startedBy}
            </span>
            <span style={{ color: '#9AA8A0' }}>·</span>
            <span>{usageWords}</span>
          </div>
        )}
        {run.instruction && (
          <div style={{ borderLeft: '3px solid #7FB0DC', padding: '2px 0 2px 12px' }} data-testid="run-instruction">
            <div
              style={{
                fontSize: '9.5px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: '#2F6FB0',
                textTransform: 'uppercase',
              }}
            >
              {run.mode === 'ask' ? 'Question' : 'Instruction'}
            </div>
            <div style={{ fontSize: '13px', lineHeight: 1.5, color: '#244E78' }}>{run.instruction}</div>
          </div>
        )}
        {run.state === 'queued' && run.waitingReason && (
          <Notice tone="amber" testId="why-waiting">
            {run.waitingReason}
          </Notice>
        )}
        {!live && run.endedReason && (
          <Notice tone={run.state === 'finished' ? 'blue' : run.state === 'cancelled' ? 'grey' : 'red'}>
            {run.endedReason}
          </Notice>
        )}
        {run.state === 'needs_input' && run.question && !run.answer && <QuestionCard run={{ ...run }} />}
        <RunReportCard run={run} />
        {run.state !== 'queued' && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
            {stepsBlock}
            {rail}
          </div>
        )}
        {run.state === 'queued' && (
          <span style={{ fontSize: '12px', color: '#9AA8A0' }} data-testid="no-steps">
            No steps yet.
          </span>
        )}
        <RunMessages runId={runId} />
        <RunMessageBox run={run} />
        <div style={{ fontSize: '11.5px', color: '#9AA8A0', display: 'flex', alignItems: 'center', gap: '7px' }}>
          <LineIcon name="lock" size={12} />
          Secrets, tokens and key-like strings are masked before the log is stored or shown.
        </div>
      </div>
    </div>
  );
}

const CHIP_OK: CSSProperties = { background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' };
const CHIP_BAD: CSSProperties = { background: '#FDF1EE', color: '#C4432A', border: '1px solid #F0C4B8' };

const NOTICE_TONES = {
  amber: { bg: '#FDF3E3', fg: '#8A5A00', border: '#EBD3A4' },
  blue: { bg: '#E8F1FA', fg: '#244E78', border: '#C9DDF0' },
  grey: { bg: '#F1F3F1', fg: '#3A4A3E', border: '#DCE3DE' },
  red: { bg: '#FDF1EE', fg: '#C4432A', border: '#F0C4B8' },
} as const;

/** A line under the run's facts: why it waits (amber), why it ended (blue finished, grey stopped, red did not finish). */
function Notice({ tone, children, testId }: { tone: keyof typeof NOTICE_TONES; children: ReactNode; testId?: string }) {
  const t = NOTICE_TONES[tone];
  return (
    <div
      data-testid={testId ?? 'run-notice'}
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        padding: '8px 11px',
        borderRadius: '8px',
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        fontSize: '12.5px',
        lineHeight: 1.5,
      }}
    >
      <span style={{ display: 'flex', paddingTop: 2 }}>
        <Svg size={13} stroke="currentColor" w={2}>
          {tone === 'amber' ? (
            <>
              <path d="M12 3.5L22 20H2Z" />
              <path d="M12 10V14M12 17.2V17.3" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11V16M12 7.8V7.9" />
            </>
          )}
        </Svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** One cell of the facts strip: a small label over the value. */
function Fact({ label, children, first }: { label: string; children: ReactNode; first?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '0 14px',
        borderLeft: first ? undefined : '1px solid #E3E8E5',
      }}
    >
      <span
        style={{
          fontSize: '9.5px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: '#9AA8A0',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span
        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', whiteSpace: 'nowrap' }}
      >
        {children}
      </span>
    </div>
  );
}

/** The team's rounded square with a sparkle (a person's avatar is round). */
function TeamTile({ size }: { size: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        background: '#DCEEE1',
        color: '#2E6F40',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
        <path
          d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** One of the small cards at the right of the steps: Files touched, Commands, Test results. */
function RailCard({
  title,
  note,
  children,
  empty,
  testId,
}: {
  title: string;
  note?: string;
  children?: ReactNode;
  empty?: string | null;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        border: '1px solid #E3E8E5',
        borderRadius: '11px',
        background: '#fff',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '7px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Label>{title}</Label>
        <span style={{ flex: 1 }} />
        {note && <span style={{ fontSize: '11px', color: '#9AA8A0' }}>{note}</span>}
      </div>
      {empty ? (
        <span style={{ fontSize: '11.5px', color: '#9AA8A0' }}>{empty}</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>{children}</div>
      )}
    </div>
  );
}

/** 12345 → "12.3k". */
function fmtElapsedTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
