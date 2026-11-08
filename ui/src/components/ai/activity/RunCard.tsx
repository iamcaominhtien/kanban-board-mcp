import { useTicketRuns } from '../../../api/ai';
import { useNow } from '../aiUi';
import { cardWords, isLive } from './runFormat';
import './design/designBlocks.css';

/**
 * The run card at the top of the ticket's AI activity, in the canvas design's look (AiTicketWork, "Ticket header after
 * assigning"): the ticket's newest run, "Run #3 in progress · Started 12:41 · 3m 12s", and Open run. Nothing when the
 * ticket has no AI run.
 */
export function RunCard({ ticketId, onOpenRun }: { ticketId: string; onOpenRun?: () => void }) {
  const runs = useTicketRuns(ticketId);
  const run = (runs.data ?? []).find((r) => r.kind === 'team');
  const now = useNow(1000, !!run && isLive(run.state));
  if (!run) return null;
  const { title, sub } = cardWords(run, now);
  return (
    <div className="dz dz-tw" data-testid="active-run-card" data-state={run.state}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span
          style={{
            position: 'relative',
            display: 'inline-flex',
            width: '28px',
            height: '28px',
            borderRadius: '8px',
            background: '#DCEEE1',
            color: '#2E6F40',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <path
              d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
          <span
            style={{
              position: 'absolute',
              right: '-4px',
              bottom: '-4px',
              width: '11px',
              height: '11px',
              borderRadius: '50%',
              background: '#1E2A22',
              border: '1.5px solid #FFFFFF',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#FFFFFF',
            }}
          >
            <svg width="7" height="7" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <path
                d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"
                fill="currentColor"
              />
            </svg>
          </span>
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          <span style={{ fontSize: '12.5px', color: '#1E2A22', fontWeight: 700, lineHeight: 1.5 }}>{title}</span>
          <span style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: 400, lineHeight: 1.5 }}>{sub}</span>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="mc-link" onClick={onOpenRun}>
          Open run
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <path d="M9 6L15 12L9 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
