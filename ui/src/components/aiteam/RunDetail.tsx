import { useAiRun } from '../../api/ai';
import { RunView } from '../ai/RunView';
import { TicketChip } from './teamUi';

/** One run, from AI Team › Run history: the ticket it was on, and the run itself (report, question, steps). */
export function RunDetail({
  runId,
  onBack,
  onOpenTicket,
}: {
  runId: string;
  onBack: () => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const run = useAiRun(runId).data;
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 940, paddingBottom: 24 }}
      data-testid="run-detail"
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" className="ai-link" onClick={onBack} data-testid="run-detail-back">
          ← All runs
        </button>
        {run?.ticketId && <TicketChip id={run.ticketId} onOpen={onOpenTicket} />}
      </div>
      <RunView runId={runId} />
    </div>
  );
}
