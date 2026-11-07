import type { CSSProperties } from 'react';
import { useTicketRuns } from '../../../api/ai';
import type { AiRun, RunState } from '../../../types/ai';
import type { Ticket } from '../../../types';
import { money, useAiBoardState, useNow } from '../aiUi';
import { elapsedWords, isLive, startedByWords, statusName } from './runFormat';
import './design/designBlocks.css';

const COLUMNS = '46px minmax(150px, 1.2fr) minmax(170px, 1.4fr) 104px 70px 96px minmax(160px, 2fr)';
const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: COLUMNS,
  columnGap: '14px',
  alignItems: 'center',
  padding: '9px 16px',
  boxSizing: 'border-box',
};
const CELL: CSSProperties = { fontSize: '11.5px', color: '#5B6B60', fontWeight: 500, lineHeight: 1.5 };

interface Chip {
  label: string;
  bg: string;
  color: string;
  border: string;
  icon: 'check' | 'pulse' | 'clock' | 'x' | 'warn' | 'pause' | 'spin' | null;
}

/** The state chips of the design (finished, running, timed out, cancelled); failed and waiting ones in the same style. */
const CHIPS: Record<RunState, Chip> = {
  finished: { label: 'Finished', bg: '#F1F8F3', color: '#2E6F40', border: '#BFDCC7', icon: 'check' },
  running: { label: 'Running', bg: '#F1F8F3', color: '#2E6F40', border: '#BFDCC7', icon: 'pulse' },
  timed_out: { label: 'Timed out', bg: '#FDF3E3', color: '#B4571F', border: '#EBD3A4', icon: 'clock' },
  cancelled: { label: 'Cancelled', bg: '#F1F3F1', color: '#5B6B60', border: '#DCE3DE', icon: 'x' },
  failed: { label: 'Failed', bg: '#FBEEEA', color: '#C4432A', border: '#F0C9C0', icon: 'warn' },
  queued: { label: 'Queued', bg: '#F1F3F1', color: '#5B6B60', border: '#DCE3DE', icon: 'clock' },
  starting: { label: 'Starting', bg: '#F1F8F3', color: '#2E6F40', border: '#BFDCC7', icon: 'spin' },
  needs_input: { label: 'Needs input', bg: '#EEF1EE', color: '#5B6B60', border: '#DCE3DE', icon: 'pause' },
};

function Icon({ kind }: { kind: NonNullable<Chip['icon']> }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
  };
  if (kind === 'pulse')
    return (
      <span
        className="ai-pulse"
        style={{ width: 7, height: 7, borderRadius: '50%', background: '#2E6F40', flexShrink: 0 }}
      />
    );
  if (kind === 'spin') return <span className="ai-spin" style={{ width: 10, height: 10 }} />;
  if (kind === 'check')
    return (
      <svg {...common} strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5L10 17.5L19 7" />
      </svg>
    );
  if (kind === 'clock')
    return (
      <svg {...common} strokeWidth={2.2}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7V12L15 14" />
      </svg>
    );
  if (kind === 'x')
    return (
      <svg {...common} strokeWidth={2.6}>
        <path d="M6 6L18 18M18 6L6 18" />
      </svg>
    );
  if (kind === 'pause')
    return (
      <svg {...common}>
        <path d="M8.5 5.5V18.5M15.5 5.5V18.5" />
      </svg>
    );
  return (
    <svg {...common} strokeWidth={2.2}>
      <path d="M12 3.5L22 20H2Z" />
      <path d="M12 10V14M12 17.2V17.3" />
    </svg>
  );
}

/** What the run did to the ticket's column, from the ticket's activity log (an AI's entries carry its run id). */
function statusMoves(ticket: Ticket, run: AiRun): { from: string; to: string }[] {
  return (ticket.activityLog ?? [])
    .filter((e) => e.runId === run.id && e.field === 'status')
    .map((e) => ({ from: statusName(e.from), to: statusName(e.to) }));
}

function ChangeCell({ ticket, run }: { ticket: Ticket; run: AiRun }) {
  const moves = statusMoves(ticket, run);
  const note = [
    run.report?.branch,
    run.files.length ? `${run.files.length} file${run.files.length === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const gray: CSSProperties = { fontSize: '11.5px', color: '#9AA8A0', fontWeight: 400, lineHeight: 1.5 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px 8px', flexWrap: 'wrap', minWidth: 0 }}>
      {moves.map((m, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
            {m.from}
          </span>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#9AA8A0"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <path d="M5 12H19" />
            <path d="M13 6L19 12L13 18" />
          </svg>
          <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
            {m.to}
          </span>
        </span>
      ))}
      {!moves.length && (
        <span style={gray}>{run.mode === 'ask' ? 'no changes (answer only)' : note ? '' : 'no status change'}</span>
      )}
      {note && <span style={gray}>{moves.length ? `· ${note}` : note}</span>}
    </div>
  );
}

/**
 * The ticket's runs as a table, in the canvas design's look ("5. Run history for KAN-142"): number, team, who started
 * it and when, state, time, usage and what the run did to the ticket's column.
 */
export function RunHistoryTable({ ticket }: { ticket: Ticket }) {
  const runs = (useTicketRuns(ticket.id).data ?? []).filter((r) => r.kind === 'team');
  const { members } = useAiBoardState();
  const now = useNow(
    1000,
    runs.some((r) => isLive(r.state)),
  );
  if (!runs.length) return null;
  return (
    <div className="dz dz-tw" data-testid="run-history">
      <div style={{ border: '1px solid #E3E8E5', borderRadius: '10px', overflow: 'hidden', background: '#FFFFFF' }}>
        <div style={{ ...ROW, background: '#F6FAF7', borderBottom: '1px solid #E3E8E5' }}>
          {['Run', 'Agent', 'Started by', 'State', 'Time', 'Usage', 'Status change'].map((h) => (
            <span key={h} className="td-label">
              {h}
            </span>
          ))}
        </div>
        {runs.map((r, i) => {
          const chip = CHIPS[r.state];
          return (
            <div
              key={r.id}
              style={{ ...ROW, borderBottom: '1px solid #EEF3EF', background: i % 2 ? '#FBFDFC' : undefined }}
              data-testid="run-history-item"
            >
              <span
                style={{
                  fontSize: '12px',
                  color: '#1E2A22',
                  fontWeight: 700,
                  lineHeight: 1.5,
                  fontFamily: 'JetBrains Mono,monospace',
                }}
              >
                #{r.number}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span
                  style={{
                    position: 'relative',
                    display: 'inline-flex',
                    width: '20px',
                    height: '20px',
                    borderRadius: '5px',
                    background: '#DCEEE1',
                    color: '#2E6F40',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                    <path
                      d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <span
                  style={{ fontSize: '12px', color: '#1E2A22', fontWeight: 600, lineHeight: 1.5, whiteSpace: 'nowrap' }}
                >
                  {members.get(r.memberId)?.name ?? 'Team'}
                </span>
              </div>
              <span style={{ ...CELL, whiteSpace: 'nowrap' }}>{startedByWords(r)}</span>
              <span style={{ justifySelf: 'start' }}>
                <span
                  className="ai-chip"
                  style={{ background: chip.bg, color: chip.color, border: `1px solid ${chip.border}` }}
                >
                  {chip.icon && <Icon kind={chip.icon} />}
                  {chip.label}
                </span>
              </span>
              <span style={{ ...CELL, fontFamily: 'JetBrains Mono,monospace' }}>{elapsedWords(r, now)}</span>
              <span style={{ ...CELL, whiteSpace: 'nowrap' }}>{r.costUsd > 0 ? money(r.costUsd) : 'Not metered'}</span>
              <ChangeCell ticket={ticket} run={r} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
