import { useState } from 'react';
import { useSetPace, useTicketPace } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import { useAiBoardState } from '../aiUi';
import { Bolt } from './TicketWorkflow';
import './workflow.css';

/**
 * Fast mode on a ticket, in its header: one click sets it, and nothing runs. Every AI that works on the ticket from
 * then on (a workflow step, an @mention, an assignment, a schedule) goes one effort level lower and straight to the
 * point; on a workflow the steps a quick result can do without are skipped.
 */
export function PaceButton({ ticketId }: { ticketId: string }) {
  const { members } = useAiBoardState();
  const hasAi = members.size > 0;
  const pace = useTicketPace(ticketId, hasAi);
  const set = useSetPace(ticketId);
  const [error, setError] = useState<string | null>(null);
  if (!hasAi) return null;
  const fast = pace.data?.pace === 'fast';
  return (
    <button
      type="button"
      className={`wf-pace-btn${fast ? ' on' : ''}`}
      data-testid="ticket-pace"
      aria-pressed={fast}
      disabled={pace.isLoading || set.isPending}
      title={
        error ??
        (fast
          ? 'Fast mode is on: AI runs on this ticket go one effort level lower and straight to the point. Click for the normal pace.'
          : 'Fast mode: a quick result of about the same quality from every AI on this ticket. Turning it on runs nothing.')
      }
      onClick={() => {
        setError(null);
        set.mutate(fast ? 'normal' : 'fast', { onError: (e) => setError(extractError(e)) });
      }}
    >
      <Bolt size={12} />
      Fast
    </button>
  );
}
