import type { StepAccepted } from '../../../types/aiWorkflow';
import { hhmm } from '../aiUi';
import { actorInitials, actorName } from './evidenceModel';
import './evidence.css';

/** "Minh Tran accepted it at 14:02." and the reason they gave, quoted (ai-story-flow N, Accepted without tests). */
export function AcceptedBy({ accepted, testId }: { accepted: StepAccepted; testId?: string }) {
  const name = actorName(accepted.by);
  return (
    <div className="ev-accepted" data-testid={testId}>
      <div className="ev-accepted-who">
        <span className="ev-person" aria-hidden="true">
          {actorInitials(accepted.by)}
        </span>
        <span>
          <b>{name}</b> accepted it{accepted.at ? ` at ${hhmm(accepted.at)}` : ''}.
        </span>
      </div>
      {accepted.reason ? (
        <div className="ev-quote" data-testid="accepted-reason">
          &ldquo;{accepted.reason}&rdquo;
        </div>
      ) : (
        <div className="wf-hint">No reason was given.</div>
      )}
    </div>
  );
}
