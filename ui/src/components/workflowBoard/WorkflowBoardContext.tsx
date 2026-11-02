import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { WorkflowBoardRow } from '../../types/aiWorkflowBoard';
import { roleChip, roleName } from './workflowFilter';

const EMPTY: ReadonlyMap<string, WorkflowBoardRow> = new Map();

/** Rows by ticket id. Without a provider (or with no workflows) it is empty, so cards draw nothing extra. */
const WorkflowBoardContext = createContext<ReadonlyMap<string, WorkflowBoardRow>>(EMPTY);

/** Gives the cards the workflow row of their ticket. */
export function WorkflowBoardProvider({
  rows,
  children,
}: {
  rows: WorkflowBoardRow[] | undefined;
  children: ReactNode;
}) {
  const map = useMemo(() => (rows && rows.length ? new Map(rows.map((r) => [r.ticketId, r])) : EMPTY), [rows]);
  return <WorkflowBoardContext.Provider value={map}>{children}</WorkflowBoardContext.Provider>;
}

/** The workflow row of a ticket, if it is on a workflow. */
export function useWorkflowRow(ticketId: string): WorkflowBoardRow | undefined {
  return useContext(WorkflowBoardContext).get(ticketId);
}

/** The step a ticket is at and the role doing it, on a board card. Nothing for a ticket without a workflow. */
export function WorkflowCardChip({ ticketId }: { ticketId: string }) {
  const row = useWorkflowRow(ticketId);
  if (!row || !row.step) return null;
  const chip = roleChip(row.role);
  const waits = row.waitsForPerson;
  const title = [
    row.templateName,
    row.step,
    row.role ? roleName(row.role) : null,
    row.holderName ? `held by ${row.holderName}` : null,
    waits ? 'waits for you' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      data-testid="card-workflow-chip"
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        maxWidth: '100%',
        padding: '2px 8px 2px 3px',
        borderRadius: 999,
        border: `1px solid ${waits ? '#F0C77A' : '#E3E8E5'}`,
        background: waits ? '#FFFAF0' : '#F6FAF7',
        color: waits ? '#8A4B00' : '#3A4A3E',
        fontSize: 11.5,
        fontWeight: 600,
        minWidth: 0,
      }}
    >
      {chip && (
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: 999,
            background: waits ? 'rgba(199,119,0,0.18)' : 'rgba(46,111,64,0.14)',
            flexShrink: 0,
          }}
        >
          {chip}
        </span>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.step}</span>
      {waits && <span style={{ flexShrink: 0 }}>· waits for you</span>}
    </div>
  );
}
