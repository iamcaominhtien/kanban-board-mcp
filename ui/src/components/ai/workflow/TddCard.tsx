import { useState } from 'react';
import { useTddEvidence, useWorkflowMutation, workflowApi } from '../../../api/aiWorkflow';
import { useProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import type { WorkflowView } from '../../../types/aiWorkflow';
import { hhmm, useAiBoardState } from '../aiUi';
import { openRun } from '../../aiteam/runLink';
import { AcceptedBy } from '../evidence/AcceptedBy';
import { ReasonForm } from '../evidence/ReasonForm';
import { acceptedOf, lastStepOf } from '../evidence/evidenceModel';
import './workflow.css';

/**
 * Proof that the test went red first (design: I): a red run on an assertion, then a green one, matched by code. Taken
 * without it, the card says who, when and why (ai-story-flow N); with the rule off it says so quietly.
 */
export function TddCard({ ticketId, view }: { ticketId: string; view: WorkflowView }) {
  const dev = lastStepOf(view, ['dev']);
  const { projectId } = useAiBoardState();
  const q = useTddEvidence(ticketId, !!dev);
  const ops = useProjectOps(projectId);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const send = useWorkflowMutation(ticketId, (note: string) => workflowApi.sendBack(ticketId, 'dev', note));
  const accept = useWorkflowMutation(ticketId, (v: { ruleOff: boolean; reason?: string }) =>
    workflowApi.acceptTdd(ticketId, v.ruleOff, v.reason),
  );
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
  // Taken without the evidence by a person: who, when and why, with no buttons left but the step itself.
  const taken = acceptedOf(dev);
  if (taken)
    return (
      <div className="wf-card wf-card-green" data-testid="tdd-card">
        <div className="wf-line">
          <b>Taken without test-first evidence</b>
          <span className="wf-pill wf-pill-green" data-testid="tdd-accepted">
            Accepted without tests
          </span>
        </div>
        <AcceptedBy accepted={taken} testId="tdd-why" />
        {dev.runId && (
          <div className="wf-actions">
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(dev.runId!)}>
              Open the step
            </button>
          </div>
        )}
      </div>
    );
  // The rule is off for the project: nothing to prove, and the card says why nothing is asked.
  if (ops.isLoading) return null;
  if (ops.data?.tdd?.required === false && !unproven)
    return (
      <div className="wf-card" style={{ background: '#fbfcfb' }} data-testid="tdd-card" data-state="off">
        <div className="wf-line">
          <b>Test first is off for this project</b>
          <span className="wf-pill" data-testid="tdd-off">
            Not required
          </span>
        </div>
        <div className="wf-note">
          Dev steps are not held for a red run, so there is nothing to prove and the gate does not ask.
        </div>
        <div className="wf-hint">Set in the project&rsquo;s AI settings, Team on its own.</div>
      </div>
    );
  // Not proven: only worth saying once the Dev step has had its turn.
  if (!['done', 'failed'].includes(dev.state) && !view.steps.some((s) => s.kind === 'code' && s.state !== 'pending'))
    return null;
  const fail = (x: unknown) => setError(extractError(x));
  return (
    <div className="wf-card wf-card-red" data-testid="tdd-card">
      <div className="wf-line">
        <b>No test-first evidence for {ticketId}</b>
        <span className="wf-pill wf-pill-red">Test first not proven</span>
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
      {asking ? (
        <ReasonForm
          testId="tdd-reason"
          label="Why is it right to take it without a red run?"
          placeholder="For example: copy change only, there is nothing to assert."
          submitLabel="Accept just this once"
          busy={accept.isPending}
          onCancel={() => setAsking(false)}
          onSubmit={(reason) => {
            setError(null);
            accept.mutate({ ruleOff: false, reason }, { onError: fail, onSuccess: () => setAsking(false) });
          }}
        />
      ) : (
        <div className="wf-actions">
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={send.isPending}
            onClick={() => {
              setError(null);
              send.mutate(`No test-first evidence: ${e.why}`, { onError: fail });
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
                  setAsking(true);
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
                  accept.mutate({ ruleOff: true }, { onError: fail });
                }}
              >
                Turn the rule off for this project
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
