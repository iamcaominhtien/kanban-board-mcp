import type { ReactNode } from 'react';
import type { AssistDraft, DraftChange } from '../../types/assist';
import { STATUS_LABEL, TicketPill } from './assistUi';

/** One change an answer made by itself, as the server records it: `{op, ticket, before, after}` and a few more. */
export type AppliedChange = { op: string; ticket?: string; [k: string]: unknown };

const cap = (v: unknown) => String(v ?? '').replace(/^\w/, (c) => c.toUpperCase());
/** A message without the full stops and spaces at its end. */
const trimTrailingStops = (s: string) => {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '.' || s[end - 1].trim() === '')) end--;
  return s.slice(0, end);
};
const text = (v: unknown) => (v == null || v === '' ? 'nothing' : String(v));

/** What happened, in a sentence that follows the ticket key ("moved to In Progress"). */
export function appliedWords(a: AppliedChange): string {
  switch (a.op) {
    case 'status':
      return `moved to ${STATUS_LABEL[String(a.after)] ?? text(a.after)}`;
    case 'assignee':
      return a.after ? `given to ${text(a.after)}` : 'taken off its assignee';
    case 'priority':
      return `priority set to ${cap(a.after)}`;
    case 'tags':
      return Array.isArray(a.after) && a.after.length ? `labels set to ${a.after.join(', ')}` : 'labels cleared';
    case 'estimate':
      return a.after == null ? 'estimate cleared' : `estimate set to ${a.after} pt`;
    case 'due_date':
      return a.after ? `due date set to ${text(a.after)}` : 'due date cleared';
    case 'title':
      return `renamed to “${text(a.after)}”`;
    case 'comment':
      return 'commented on';
    case 'add_criteria': {
      const n = Array.isArray(a.ids) ? a.ids.length : 1;
      return `${n} acceptance criteri${n === 1 ? 'on' : 'a'} added`;
    }
    case 'workflow':
      return `put on the ${text(a.to)} workflow`;
    case 'depth':
      return a.after ? `review depth ${a.before ? 'changed' : 'set'} to ${cap(a.after)}` : 'review depth changed';
    case 'create':
      return 'created as a new ticket';
    case 'message':
      return 'told the AI that is working on it';
    case 'delegate':
      return 'handed to the PM';
    case 'run':
      return 'given to an AI to run';
    case 'stop_run':
      return 'run stopped';
    case 'pause_member':
      return 'AI member paused';
    case 'resume_member':
      return 'AI member resumed';
    default:
      return a.op.replace(/_/g, ' ');
  }
}

/** What a draft change of a team kind says before it is applied ("New ticket “title” under KAN-1"). */
export function proposedWords(ch: DraftChange): ReactNode | null {
  switch (ch.op) {
    case 'create':
      return (
        <>
          New ticket “{ch.title}”
          {ch.parent ? (
            <>
              {' '}
              under <TicketPill id={ch.parent} />
            </>
          ) : null}
        </>
      );
    case 'message':
      return (
        <>
          Tell the AI on <TicketPill id={ch.ticket} />: {ch.text}
        </>
      );
    case 'delegate':
      return (
        <>
          The PM takes <TicketPill id={ch.ticket} />: {ch.text}
        </>
      );
    default:
      return null;
  }
}

/** "Done — 4 changes", the list of what changed, and Undo all (design/screens/ai-board-wave3.md, D). */
export function DoneReceipt({
  draft,
  busy,
  onUndo,
  error,
  footer,
}: {
  draft: AssistDraft;
  busy: boolean;
  onUndo: () => void;
  error?: string | null;
  footer?: ReactNode;
}) {
  const applied = (draft.result.applied ?? []) as AppliedChange[];
  const n = applied.length || draft.result.count || 0;
  const undone = draft.status === 'undone';
  const skipped = draft.result.undo?.skipped ?? [];
  return (
    <div
      data-testid="draft-done"
      style={{
        border: '1px solid #CFE3D6',
        borderRadius: 9,
        background: '#F3F9F5',
        padding: '9px 11px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span aria-hidden="true" style={{ color: '#1F5A31', fontWeight: 700 }}>
          ✓
        </span>
        <b style={{ fontSize: 12.5, color: '#1F5A31', flex: 1 }}>
          {undone ? `Undone — ${draft.result.undo?.undone ?? n} put back` : `Done — ${n} change${n === 1 ? '' : 's'}`}
        </b>
        {!undone && (
          <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={onUndo} data-testid="draft-undo">
            {n === 1 ? 'Undo' : `Undo all ${n}`}
          </button>
        )}
      </div>
      {applied.map((a, i) => (
        <div
          key={i}
          data-testid="done-row"
          style={{
            display: 'flex',
            gap: 7,
            fontSize: 12,
            lineHeight: 1.5,
            alignItems: 'flex-start',
            textDecoration: undone ? 'line-through' : undefined,
            opacity: undone ? 0.6 : 1,
          }}
        >
          <span style={{ flex: 'none', marginTop: 2, color: '#1F5A31' }} aria-hidden="true">
            ✓
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            {a.ticket || (a.op === 'create' && a.created) ? (
              <>
                <TicketPill id={String(a.op === 'create' ? (a.created ?? a.ticket) : a.ticket)} /> {appliedWords(a)}
              </>
            ) : (
              <span style={{ textTransform: 'none' }}>{cap(appliedWords(a))}</span>
            )}
          </span>
        </div>
      ))}
      {draft.result.errors?.length ? (
        <div className="ai-hint" data-testid="done-refused" style={{ color: '#7A5A06' }}>
          {n} of {n + draft.result.errors.length} went through.{' '}
          {draft.result.errors.map((e, i) => (
            <span key={i}>
              {e.ticket ? <TicketPill id={e.ticket} /> : 'One change'} was refused: {trimTrailingStops(e.message)}.{' '}
            </span>
          ))}
          {n === 1 ? 'Undo puts it back.' : `Undo all ${n} puts them back.`}
        </div>
      ) : null}
      {skipped.length ? (
        <div className="ai-hint" data-testid="undo-skipped">
          Left as someone else set them: {skipped.join('; ')}.
        </div>
      ) : null}
      {!undone && (
        <div className="ai-hint">
          Recorded as <b>{draft.appliedBy ?? 'you'} (through the Board AI)</b>. Undo works until something else changes
          the same field.
        </div>
      )}
      {error && <div className="ai-error-text">{error}</div>}
      {footer}
    </div>
  );
}

/** Why an answer stopped and asks: the reasons the server gave (design D, "One thing I will not do without you"). */
export function AsksFirst({ reasons }: { reasons: string[] }) {
  return (
    <div
      data-testid="draft-asks-first"
      style={{
        border: '1px solid #F0DBA8',
        borderRadius: 9,
        background: '#FFFBEF',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <b style={{ fontSize: 12.5 }}>
        {reasons.length === 1
          ? 'One thing I will not do without you'
          : `${reasons.length} things I will not do without you`}
      </b>
      <ul style={{ margin: 0, paddingLeft: 17, fontSize: 12.5, lineHeight: 1.6 }}>
        {reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <div className="ai-hint">Apply is the confirm: nothing happens until you press it.</div>
    </div>
  );
}
