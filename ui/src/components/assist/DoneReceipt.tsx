import type { Receipt, ReceiptChange } from '../../types/assist';
import { STATUS_LABEL, TicketPill } from './assistUi';
import { LineIcon } from '../ui/LineIcon';

const cap = (v: unknown) => String(v ?? '').replace(/^\w/, (c) => c.toUpperCase());
const text = (v: unknown) => (v == null || v === '' ? 'nothing' : String(v));
const clipped = (v: unknown, n = 140) => {
  const s = text(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** What happened, in a sentence that follows the ticket key ("moved to In Progress"). */
export function appliedWords(a: ReceiptChange): string {
  switch (a.op) {
    case 'status':
      return `moved to ${STATUS_LABEL[String(a.after)] ?? text(a.after)}`;
    case 'assignee':
      return a.after ? `given to ${text(a.after)}` : 'taken off its assignee';
    case 'priority':
      return `priority set to ${cap(a.after)}`;
    case 'type':
      return `type set to ${cap(a.after)}`;
    case 'tags':
      return Array.isArray(a.after) && a.after.length ? `labels set to ${a.after.join(', ')}` : 'labels cleared';
    case 'estimate':
      return a.after == null ? 'estimate cleared' : `estimate set to ${a.after} pt`;
    case 'due_date':
      return a.after ? `due date set to ${text(a.after)}` : 'due date cleared';
    case 'start_date':
      return a.after ? `start date set to ${text(a.after)}` : 'start date cleared';
    case 'title':
      return `renamed to “${clipped(a.after, 80)}”`;
    case 'comment':
      return `new comment: “${clipped(a.after)}”`;
    case 'create':
      return `created${a.type && a.type !== 'task' ? ` as a new ${a.type}` : ''}: “${clipped(a.title, 80)}”`;
    case 'description':
      return 'description rewritten';
    case 'parent_id':
      return a.after ? `moved under ${text(a.after)}` : 'taken out of its parent';
    default:
      return a.words ?? a.op.replace(/_/g, ' ');
  }
}

/**
 * "Done — 4 changes", what each change was, and Undo all (design/screens/ai-board-wave3.md, B; ai-board-assistant.md, B2
 * and B3). The Board AI does what it can undo at once; this is where it says so. Anything it cannot undo it asks as a
 * normal question in its answer, so there is no button here to confirm anything.
 * @param props.receipt - What the answer changed, and what Undo all did.
 * @param props.person - The person the changes are recorded for.
 * @param props.busy - Undo all is running.
 * @param props.onUndo - Put the changes back.
 */
export function DoneReceipt({
  receipt,
  person,
  busy,
  onUndo,
}: {
  receipt: Receipt;
  person: string;
  busy: boolean;
  onUndo: () => void;
}) {
  const applied = receipt.applied;
  const n = applied.length;
  const undone = receipt.status === 'undone';
  const skipped = receipt.undo?.skipped ?? [];
  const kept = receipt.undo?.kept ?? [];
  const back = new Set(receipt.undo?.putBack ?? []);
  const putBack = receipt.undo?.undone ?? 0;
  // what the board can put back: the button counts only these
  const nUndo = applied.filter((a) => a.undo).length;
  return (
    <div className="as-receipt" data-testid="receipt">
      <div className="as-receipt-head">
        <span aria-hidden="true" className="as-receipt-ok">
          <LineIcon name="check" size={13} />
        </span>
        <b data-testid="receipt-title">
          {undone ? `Undone — ${putBack} put back` : `Done — ${n} change${n === 1 ? '' : 's'}`}
        </b>
        {!undone && nUndo > 0 && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={busy}
            onClick={onUndo}
            data-testid="receipt-undo"
          >
            {nUndo === 1 ? 'Undo' : `Undo all ${nUndo}`}
          </button>
        )}
      </div>
      {applied.map((a, i) => (
        <div key={i} className={`as-receipt-row ${back.has(i) ? 'as-receipt-undone' : ''}`} data-testid="done-row">
          <span aria-hidden="true" className="as-receipt-ok">
            <LineIcon name="check" size={13} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <TicketPill id={String(a.op === 'create' ? (a.created ?? a.ticket) : a.ticket)} /> {appliedWords(a)}
          </span>
        </div>
      ))}
      {skipped.length ? (
        <div className="ai-hint" data-testid="undo-skipped">
          {putBack ? 'Part of the group is back. ' : 'Nothing was put back. '}
          Left as someone else set them: {skipped.join('; ')}.
        </div>
      ) : null}
      {kept.length ? (
        <div className="ai-hint" data-testid="undo-kept">
          No way back for: {kept.join('; ')}.
        </div>
      ) : null}
      {!undone && (
        <div className="ai-hint">
          Recorded for <b>{person} (through the Board AI)</b>. Undo works until something else changes the same field.
        </div>
      )}
    </div>
  );
}
