import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client } from '../../../api/client';
import { workflowBoardKeys } from '../../../api/aiWorkflowBoard';
import { useTicketWorkflow, useWorkflowMutation, workflowApi } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import type { WorkflowBoardRow } from '../../../types/aiWorkflowBoard';
import { Ico } from '../../story/storyUi';
import { useAiBoardState } from '../aiUi';
import { kTokens, parseCapDetail, stoppedAtCap } from './capModel';
import './limits.css';

/**
 * The workflow row of a ticket, read from the board's own query (App polls it): this only listens to that cache and
 * never fetches, so a card adds no request of its own.
 */
function useWorkflowRow(ticketId: string): WorkflowBoardRow | undefined {
  const { projectId } = useAiBoardState();
  const q = useQuery({
    queryKey: workflowBoardKeys.board(projectId),
    queryFn: async () => (await client.get<WorkflowBoardRow[]>(`/projects/${projectId}/ai/workflow-board`)).data,
    enabled: false,
  });
  return q.data?.find((r) => r.ticketId === ticketId);
}

function CapLine({ ticketId }: { ticketId: string }) {
  const view = useTicketWorkflow(ticketId).data;
  const [error, setError] = useState<string | null>(null);
  const resume = useWorkflowMutation(ticketId, (_: void) => workflowApi.resume(ticketId));
  const nums = parseCapDetail(view?.stopDetail);
  return (
    <div
      className="lim-card-line"
      data-testid="card-cap-stopped"
      title={error ?? view?.stopDetail ?? 'Stopped at its token cap'}
    >
      <Ico name="pause" size={12} color="#7A5A06" />
      <span>
        Stopped at its token cap
        {nums && (
          <small data-testid="card-cap-numbers">
            {kTokens(nums.used)} of {kTokens(nums.cap)}
          </small>
        )}
        {error && (
          <small role="alert" style={{ color: '#A5321E' }}>
            {error}
          </small>
        )}
      </span>
      <button
        type="button"
        className="lim-card-resume"
        data-testid="card-cap-resume"
        disabled={resume.isPending}
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          resume.mutate(undefined, { onError: (x) => setError(extractError(x)) });
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        Resume
      </button>
    </div>
  );
}

/**
 * On a board card, a ticket whose workflow stopped at its token cap: "Stopped at its token cap · 412k of 400k" and
 * Resume (ai-story-flow O). Nothing for any other ticket.
 */
export function CardCapLine({ ticketId }: { ticketId: string }) {
  const row = useWorkflowRow(ticketId);
  if (!stoppedAtCap(row)) return null;
  return <CapLine ticketId={ticketId} />;
}

/** One ticket waited for: its key, a click to it, and ", which is stopped" when it stopped at its cap. */
function WaitId({ id }: { id: string }) {
  const row = useWorkflowRow(id);
  const { openTicket } = useAiBoardState();
  const stopped = stoppedAtCap(row);
  const key = openTicket ? (
    <button
      type="button"
      className="lim-wait-key"
      title={`Open ${id}`}
      onClick={(e) => {
        e.stopPropagation();
        openTicket(id);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {id}
    </button>
  ) : (
    <b style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{id}</b>
  );
  return (
    <span data-testid={stopped ? 'card-waits-stopped' : undefined}>
      {key}
      {stopped ? ', which is stopped' : ''}
    </span>
  );
}

/** "waits for KAN-305, which is stopped": the tickets this one waits for, each with a click to it. */
export function WaitsFor({ ids }: { ids: string[] }) {
  return (
    <span>
      waits for{' '}
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <WaitId id={id} />
        </span>
      ))}
    </span>
  );
}

/** A line per ticket this one waits for that stopped at its token cap; nothing when none did. */
export function WaitsForStopped({ ids }: { ids: string[] }) {
  return (
    <>
      {ids.map((id) => (
        <StoppedLine key={id} id={id} />
      ))}
    </>
  );
}

function StoppedLine({ id }: { id: string }) {
  const row = useWorkflowRow(id);
  if (!stoppedAtCap(row)) return null;
  return (
    <div className="lim-waits" data-testid="card-waits-for-stopped">
      <Ico name="clock" size={12} color="#5B6B60" width={2} />
      <span>
        waits for <WaitId id={id} />
      </span>
    </div>
  );
}
