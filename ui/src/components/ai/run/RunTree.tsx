import { useMemo, useState } from 'react';
import { aiApi, useLoadSteps } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { AiRunFull, RunAgent, RunStep } from '../../../types/ai';
import { hhmm } from '../aiUi';
import { StepIcon } from './StepIcon';
import { buildTree, diffWords, hasEarlierLead, hasMoreChildren, lastSeq, stepTone, type TreeNode } from './treeLogic';
import '../ticketWork.css';

const PAGE = 200;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      style={{ transform: open ? 'rotate(90deg)' : undefined }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** One line of a step: its title, the size of an edit, the exit code of a command. */
function StepText({ step }: { step: RunStep }) {
  const diff = diffWords(step);
  const exit = step.detail.exitCode;
  const tone = stepTone(step);
  return (
    <span
      style={{
        minWidth: 0,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: step.kind === 'text' ? 'normal' : 'nowrap',
        color: tone === 'quiet' ? '#5B6B60' : tone === 'bad' ? '#A5321E' : undefined,
      }}
    >
      {step.title}
      {diff && (
        <span className="ai-mono" style={{ marginLeft: 10, fontSize: 11.5, color: '#2E6F40' }}>
          {diff}
        </span>
      )}
      {typeof exit === 'number' && (
        <span style={{ color: exit === 0 ? '#5B6B60' : '#C4432A', fontWeight: exit === 0 ? 400 : 700 }}>
          {' '}
          · exit {exit}
        </span>
      )}
    </span>
  );
}

/** A step row; a step with output opens it on click (the output is fetched then, not before). */
function StepRow({
  runId,
  step,
  working,
  indent,
  right,
  onToggle,
  isOpen,
  children,
}: {
  runId: string;
  step: RunStep;
  working?: boolean;
  indent?: boolean;
  right?: React.ReactNode;
  onToggle?: () => void;
  isOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [output, setOutput] = useState<{ text: string } | { error: string } | 'loading' | null>(null);
  const [open, setOpen] = useState(false);
  const expandable = step.hasOutput;
  const toggleOutput = async () => {
    if (!expandable) return;
    if (open) return setOpen(false);
    setOpen(true);
    if (output && output !== 'loading' && 'text' in output) return;
    setOutput('loading');
    try {
      const full = await aiApi.stepOutput(runId, step.seq);
      setOutput({ text: full.output ?? '' });
    } catch (e) {
      setOutput({ error: extractError(e) });
    }
  };
  const canToggle = expandable || !!onToggle;
  return (
    <div data-testid="run-step" data-seq={step.seq} style={indent ? { paddingLeft: 22 } : undefined}>
      <div className="ai-step-row">
        {canToggle ? (
          <button
            type="button"
            className="tw-chev"
            aria-expanded={onToggle ? isOpen : open}
            aria-label={
              onToggle ? (isOpen ? 'Hide its steps' : 'Show its steps') : open ? 'Hide output' : 'Show output'
            }
            data-testid="step-toggle"
            onClick={() => (onToggle ? onToggle() : void toggleOutput())}
          >
            <Chevron open={onToggle ? !!isOpen : open} />
          </button>
        ) : (
          <span style={{ width: 20, flexShrink: 0 }} />
        )}
        <StepIcon step={step} working={working} />
        <StepText step={step} />
        {right}
        <span className="ai-step-time">{hhmm(step.at)}</span>
      </div>
      {open && expandable && (
        <pre className="tw-term" data-testid="step-output">
          {typeof step.detail.command === 'string' && (
            <span style={{ color: '#7BC48F' }}>
              $ {step.detail.command}
              {'\n'}
            </span>
          )}
          {output === 'loading' || output === null
            ? 'Loading…'
            : 'error' in output
              ? `Could not load the output: ${output.error}`
              : output.text || '(nothing printed)'}
        </pre>
      )}
      {children}
    </div>
  );
}

function AgentBadge({ agent, active }: { agent: RunAgent | null; active: boolean }) {
  if (!agent) return null;
  return (
    <span className="ai-muted" style={{ whiteSpace: 'nowrap' }} data-testid="agent-meta">
      {agent.agentType}
      {' · '}
      {agent.stepsCount} step{agent.stepsCount === 1 ? '' : 's'}
      {active ? ' · working' : ''}
    </span>
  );
}

/**
 * The run's steps as a two-level tree: what the lead did, and under each role (`subagent` step) what that role did.
 * The run holds its newest steps; a role's steps and the earlier steps of the lead are fetched by page.
 */
export function RunTree({ run, compact }: { run: AiRunFull; compact?: boolean }) {
  const load = useLoadSteps(run.id);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = run.state === 'running' || run.state === 'starting';
  const nodes = useMemo(() => buildTree(run.steps, run.agents), [run.steps, run.agents]);
  const shown = compact ? nodes.slice(-5) : nodes;
  const earlier = !compact && hasEarlierLead(run.steps, run.stepsCount);

  const guarded = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(null);
    }
  };
  /** The lead's older steps, a page at a time from the start up to the first step held. */
  const loadEarlier = () =>
    guarded('earlier', async () => {
      const firstHeld = run.steps.find((s) => !s.agentId)?.seq ?? Number.POSITIVE_INFINITY;
      let cursor = 0;
      for (let i = 0; i < 25; i += 1) {
        const page = await load({ agent: 'lead', after: cursor, limit: PAGE });
        if (page.length < PAGE) break;
        cursor = lastSeq(page);
        if (cursor >= firstHeld) break;
      }
    });
  const loadChildren = (node: TreeNode) =>
    guarded(node.key, async () => {
      const id = node.agent?.id ?? node.step?.toolId;
      if (id) await load({ agent: id, after: lastSeq(node.children), limit: PAGE });
    });

  if (!shown.length) return <div className="ai-muted">{live ? 'Starting Claude Code…' : 'No steps recorded.'}</div>;
  return (
    <div className="ai-steps" data-testid="run-steps">
      {earlier && (
        <button
          type="button"
          className="ai-link"
          disabled={busy === 'earlier'}
          onClick={() => void loadEarlier()}
          data-testid="load-earlier"
        >
          {busy === 'earlier' ? 'Loading…' : 'Show earlier steps'}
        </button>
      )}
      {shown.map((node, i) => {
        const isLast = i === shown.length - 1;
        const agentActive = !!node.agent && !node.agent.endedAt && live;
        const hasKids =
          node.children.length > 0 || hasMoreChildren(node) || (!!node.agent && node.agent.stepsCount > 0);
        const open = toggled[node.key] ?? agentActive;
        const kids = open ? (
          <div data-testid="agent-steps">
            {node.children.map((c) => (
              <StepRow
                key={c.seq}
                runId={run.id}
                step={c}
                indent
                working={live && isLast && c === node.children[node.children.length - 1] && agentActive}
              />
            ))}
            {hasMoreChildren(node) && (
              <button
                type="button"
                className="ai-link"
                style={{ marginLeft: 22 }}
                disabled={busy === node.key}
                onClick={() => void loadChildren(node)}
                data-testid="load-agent-steps"
              >
                {busy === node.key
                  ? 'Loading…'
                  : `Show ${(node.agent?.stepsCount ?? 0) - node.children.length} more step${(node.agent?.stepsCount ?? 0) - node.children.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        ) : null;
        if (!node.step) {
          // an agent whose own step is older than what is held
          return (
            <div key={node.key} data-testid="agent-orphan">
              <div className="ai-step-row">
                <button
                  type="button"
                  className="tw-chev"
                  aria-expanded={open}
                  data-testid="step-toggle"
                  onClick={() => setToggled((t) => ({ ...t, [node.key]: !open }))}
                >
                  <Chevron open={open} />
                </button>
                <span style={{ color: '#5B3AA6', fontWeight: 800, width: 13, textAlign: 'center' }}>⑂</span>
                <span style={{ flex: 1 }}>{node.agent?.agentType ?? 'A role'}</span>
                <AgentBadge agent={node.agent} active={agentActive} />
              </div>
              {kids}
            </div>
          );
        }
        const step = node.step;
        if (step.kind === 'subagent' && hasKids) {
          return (
            <StepRow
              key={node.key}
              runId={run.id}
              step={step}
              working={agentActive && !node.children.length}
              right={<AgentBadge agent={node.agent} active={agentActive} />}
              isOpen={open}
              onToggle={() => setToggled((t) => ({ ...t, [node.key]: !open }))}
            >
              {kids}
            </StepRow>
          );
        }
        return <StepRow key={node.key} runId={run.id} step={step} working={live && isLast} />;
      })}
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
