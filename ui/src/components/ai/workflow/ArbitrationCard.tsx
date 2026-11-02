import { useState } from 'react';
import { useWorkflowMutation, workflowApi } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import type { ArbitrationResult, Ruling, WorkflowView } from '../../../types/aiWorkflow';
import { hhmm } from '../aiUi';
import { openRun } from '../../aiteam/runLink';
import { RoleChip } from './WfUi';
import { totalRounds } from './wfFormat';
import './workflow.css';

const VERDICT_TEXT = {
  reviewer: 'sided with the Reviewer',
  dev: 'sided with Dev',
  split: 'split the ticket',
  undecided: 'could not settle it',
} as const;

/** When two AIs cannot agree (design: H): why, the coordinator's ruling, and the four ways on. */
export function ArbitrationCard({
  ticketId,
  view,
  flagOpen,
}: {
  ticketId: string;
  view: WorkflowView;
  flagOpen: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ArbitrationResult | null>(null);
  const rule = useWorkflowMutation(ticketId, (side: 'reviewer' | 'dev' | 'split') => workflowApi.rule(ticketId, side));
  const ruling: Ruling | undefined = view.rulings[view.rulings.length - 1];
  const stuck = view.state === 'stopped' && view.stopReason === 'no_progress';
  if (!ruling && !stuck && !flagOpen) return null;
  const canDecide = flagOpen || stuck || ruling?.verdict === 'undecided';
  const rounds = totalRounds(view.rounds);
  const go = (side: 'reviewer' | 'dev' | 'split') => {
    setError(null);
    rule.mutate(side, { onSuccess: setDone, onError: (e) => setError(extractError(e)) });
  };
  const nt = done?.newTicket;
  const ntId = typeof nt === 'string' ? nt : nt?.id;
  return (
    <div className="wf-card wf-card-violet" data-testid="arbitration-card">
      <div className="wf-line">
        <b>
          {ticketId} went back and forth{rounds > 0 ? ` ${rounds} time${rounds === 1 ? '' : 's'}` : ''}
        </b>
        {stuck && <span className="wf-pill wf-pill-red">No progress</span>}
        {ruling && <span className="wf-pill wf-pill-violet">{canDecide ? 'Sent to the coordinator' : 'Ruled'}</span>}
      </div>
      {view.objections.map((o, i) => (
        <div key={`${o.at}${i}`} className="wf-objection" data-testid="objection">
          <RoleChip role={o.role} title={o.by} />
          <div style={{ flex: 1 }}>
            <b>{o.by}.</b> {o.text}
          </div>
          <span className="wf-hint">{hhmm(o.at)}</span>
        </div>
      ))}
      {ruling && (
        <div className="wf-objection" style={{ background: '#faf7ff' }} data-testid="ruling">
          <RoleChip role="pm" title={ruling.by} />
          <div style={{ flex: 1 }}>
            <b>
              {ruling.by} {VERDICT_TEXT[ruling.verdict]}.
            </b>{' '}
            {ruling.reason}
            <div className="wf-hint">
              It saw the diff and both rounds, and neither AI’s transcript. It did not touch the ticket.
            </div>
          </div>
          <span className="wf-hint">{hhmm(ruling.at)}</span>
        </div>
      )}
      {done ? (
        <div className="ai-notice ai-notice-info" role="status" data-testid="arbitration-done">
          {done.side === 'split'
            ? `Split the ticket${ntId ? `: the rest went to ${ntId}` : ''}.`
            : `Sided with ${done.side === 'dev' ? 'Dev' : 'the Reviewer'}. The ruling is on the ticket.`}
        </div>
      ) : (
        <div className="wf-actions">
          {canDecide && (
            <>
              <button
                type="button"
                className="ai-btn ai-btn-primary ai-btn-sm"
                disabled={rule.isPending}
                onClick={() => go('reviewer')}
              >
                Side with Reviewer
              </button>
              <button type="button" className="ai-btn ai-btn-sm" disabled={rule.isPending} onClick={() => go('dev')}>
                Side with Dev
              </button>
              <button type="button" className="ai-btn ai-btn-sm" disabled={rule.isPending} onClick={() => go('split')}>
                Split the ticket
              </button>
            </>
          )}
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={!ruling?.runId}
            onClick={() => ruling?.runId && openRun(ruling.runId)}
          >
            Read the full arbitration
          </button>
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
