import { useState } from 'react';
import { useTddEvidence, useWorkflowMutation, workflowApi } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import type { WorkflowView } from '../../../types/aiWorkflow';
import { hhmm } from '../aiUi';
import { openRun } from '../../aiteam/runLink';
import './workflow.css';

/** Proof that the test went red first (design: I): a red run on an assertion, then a green one, matched by code. */
export function TddCard({ ticketId, view }: { ticketId: string; view: WorkflowView }) {
  const dev = view.steps.find((s) => s.role === 'dev');
  const q = useTddEvidence(ticketId, !!dev);
  const [error, setError] = useState<string | null>(null);
  const send = useWorkflowMutation(ticketId, (note: string) => workflowApi.sendBack(ticketId, 'dev', note));
  const accept = useWorkflowMutation(ticketId, (ruleOff: boolean) => workflowApi.acceptTdd(ticketId, ruleOff));
  if (!dev || !q.data) return null;
  const e = q.data;
  if (e.proven) {
    return (
      <div className="wf-card wf-card-green" data-testid="tdd-card">
        <div className="wf-line">
          <b>Test-first evidence for {ticketId}</b>
          <span className="wf-pill wf-pill-green">Proven</span>
        </div>
        <div className="wf-pair">
          <div className="wf-red-run" data-testid="tdd-red">
            <b style={{ color: '#a5321e' }}>Red &middot; {hhmm(e.red.at)}</b>
            <br />
            <code className="ai-code">{e.red.command}</code>
            <br />
            <b>{e.red.failed} failed</b>
            {e.red.failing.length > 0 && (
              <>
                {' '}
                &middot; <code className="ai-code">{e.red.failing.join(', ')}</code>
              </>
            )}
            <div className="wf-hint">{e.red.why}</div>
          </div>
          <span className="wf-sep" aria-hidden="true">
            &rarr;
          </span>
          <div className="wf-green-run" data-testid="tdd-green">
            <b style={{ color: '#1f5a31' }}>Green &middot; {hhmm(e.green.at)}</b>
            <br />
            <code className="ai-code">{e.green.command}</code>
            <br />
            <b>{e.green.passed} passed</b>
            <div className="wf-hint">Same command, same file{e.file ? ` (${e.file})` : ''}, after the change.</div>
          </div>
        </div>
        <div className="wf-note">
          Matched by <b>the command, the test file, the test name and why it failed</b> &mdash; not by what the AI said
          it did. A red run that died on an import error or a typo is not evidence: the named test has to have run and
          disagreed.
        </div>
        <div className="wf-actions">
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(e.red.run)}>
            Open the red run
          </button>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(e.green.run)}>
            Open the green run
          </button>
        </div>
      </div>
    );
  }
  const unproven = dev.outcome === 'unproven';
  // Taken without the evidence by a person: said once, in green, with no buttons left.
  if (dev.outcome === 'accepted')
    return (
      <div className="wf-card wf-card-green" data-testid="tdd-card">
        <div className="wf-line">
          <b>No test-first evidence for {ticketId}</b>
          <span className="wf-pill wf-pill-green" data-testid="tdd-accepted">
            Accepted without it
          </span>
        </div>
        <div className="wf-note" data-testid="tdd-why">
          {e.why}
        </div>
        <div className="wf-note">
          A person took the step without a red run and a green one. It is recorded on the ticket.
        </div>
      </div>
    );
  // Not proven: only worth saying once the Dev step has had its turn.
  if (!['done', 'failed'].includes(dev.state) && !view.steps.some((s) => s.kind === 'code' && s.state !== 'pending'))
    return null;
  return (
    <div className="wf-card wf-card-red" data-testid="tdd-card">
      <div className="wf-line">
        <b>No test-first evidence for {ticketId}</b>
        <span className="wf-pill wf-pill-red">Not proven</span>
      </div>
      <div className="wf-note" data-testid="tdd-why">
        {e.why}
        {e.runsSeen > 0 ? ` (${e.runsSeen} run${e.runsSeen === 1 ? '' : 's'} looked at)` : ''}
      </div>
      {unproven && (
        <div className="wf-note">
          The step is <b>not marked done</b>. The pack says a red run and a green one, and prose is not either of them.
          The choice below is not a stop of its own: it waits with everything else at the last step.
        </div>
      )}
      <div className="wf-actions">
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          disabled={send.isPending}
          onClick={() => {
            setError(null);
            send.mutate(`No test-first evidence: ${e.why}`, { onError: (x) => setError(extractError(x)) });
          }}
        >
          Send it back to {dev.memberName ?? 'Dev'}
        </button>
        {unproven && (
          <>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              data-testid="tdd-accept"
              disabled={accept.isPending}
              onClick={() => {
                setError(null);
                accept.mutate(false, { onError: (x) => setError(extractError(x)) });
              }}
            >
              Accept without it, just this once
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              data-testid="tdd-rule-off"
              disabled={accept.isPending}
              onClick={() => {
                if (
                  !window.confirm(
                    'Turn the test-first rule off for this project? Every Dev step from now on is accepted without a red run.',
                  )
                )
                  return;
                setError(null);
                accept.mutate(true, { onError: (x) => setError(extractError(x)) });
              }}
            >
              Turn the rule off for this project
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
