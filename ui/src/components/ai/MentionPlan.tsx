import { useMentionEstimate } from '../../api/assist';
import type { AiMember } from '../../types/ai';
import type { MentionIntent } from './MentionIntent';
import './ticketWork.css';

const CEILING: Record<string, string> = {
  none: 'its own comments only',
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
};

function money(usd: number | null | undefined): string {
  if (usd == null) return '';
  return usd < 0.01 ? 'less than $0.01' : `$${usd.toFixed(2)}`;
}

/**
 * What an @mention of an AI member in a comment will do, said plainly under the box (design/screens/
 * ai-where-you-work.md, C step 2). The default is **Ask only**, so a question never starts a run by accident;
 * **Do the work** is chosen on purpose and shows its limits. Shows the estimated cost, or that it is not metered.
 * @param props.ticketId - The ticket the comment is on.
 * @param props.members - The AI members mentioned in the comment, in order.
 * @param props.mode - The chosen meaning of the mention(s).
 * @param props.onMode - Called when the person picks another meaning.
 */
export function MentionPlan({
  ticketId,
  members,
  mode,
  onMode,
}: {
  ticketId: string;
  members: AiMember[];
  mode: MentionIntent;
  onMode: (m: MentionIntent) => void;
}) {
  const first = members[0];
  const ask = useMentionEstimate(ticketId, first?.id, 'ask');
  const work = useMentionEstimate(ticketId, first?.id, 'work', mode === 'work');
  if (!first) return null;
  const e = mode === 'work' ? work.data : ask.data;
  const names = members.length > 1 ? `${first.name} and ${members.length - 1} more` : first.name;
  const est = e?.estimate;
  const cost = est ? (est.metered ? `About ${money(est.usd)}` : 'Not metered') : '';
  const edits = work.data?.canEditCode ?? ask.data?.canEditCode;
  const stops = CEILING[(work.data ?? ask.data)?.stopsAt ?? 'review'] ?? 'Review';
  return (
    <div className="tw-plan" data-testid="mention-plan" data-mode={mode}>
      <div className="tw-plan-head">
        <span className="tw-plan-title">{names.toUpperCase()} WILL…</span>
        <span className="tw-plan-seg" role="radiogroup" aria-label="What the AI should do">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'ask'}
            className={mode === 'ask' ? 'tw-plan-on' : ''}
            onClick={() => onMode('ask')}
            data-testid="plan-ask"
          >
            Ask only
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'work'}
            className={mode === 'work' ? 'tw-plan-on' : ''}
            onClick={() => onMode('work')}
            data-testid="plan-work"
          >
            Do the work
          </button>
        </span>
      </div>
      {mode === 'notify' ? (
        <div className="tw-plan-line tw-plan-strong">
          <b>Just notify:</b> same as mentioning a person. It gets a notification and nothing runs.
        </div>
      ) : (
        <>
          <div className={`tw-plan-line ${mode === 'ask' ? 'tw-plan-strong' : ''}`}>
            <b>Ask only:</b> reads the ticket and replies in a comment. Changes nothing.
          </div>
          <div className={`tw-plan-line ${mode === 'work' ? 'tw-plan-strong' : ''}`}>
            <b>Do the work:</b> starts a run on this ticket.{' '}
            {edits ? 'Can edit code in the linked repository. ' : 'Works through the board. '}Stops at {stops}.
          </div>
        </>
      )}
      {e && !e.available && (
        <div className="tw-plan-warn" role="alert" data-testid="plan-unavailable">
          ⚠ {e.reason ?? 'It cannot start now.'} The comment is saved, but nothing will run.
        </div>
      )}
      <div className="tw-plan-foot">
        <span className="ai-muted" data-testid="plan-cost">
          {mode === 'notify' ? 'No cost' : cost}
        </span>
        <span style={{ flex: 1 }} />
        {mode === 'notify' ? (
          <button type="button" className="ai-link" onClick={() => onMode('ask')}>
            Ask instead
          </button>
        ) : (
          <button type="button" className="ai-link" onClick={() => onMode('notify')} data-testid="plan-notify">
            Just notify
          </button>
        )}
      </div>
    </div>
  );
}
