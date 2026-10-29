import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assistApi, assistError, useTicketDrafts } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { Ticket } from '../../types';
import { useToast } from '../Toast';
import './ticketWork.css';

/**
 * A parent ticket assigned to an AI to plan (design H7): the Board AI's split draft appears here as dashed
 * sub-tickets to accept or discard. Nothing is created until Create; accepting makes the sub-tickets (the parent then
 * shows “AI created N sub-tickets” with Undo, from the same draft). The draft is the one “Split with AI” writes.
 */
export function TicketPlan({ ticket }: { ticket: Ticket }) {
  const drafts = useTicketDrafts(ticket.id);
  const qc = useQueryClient();
  const toast = useToast();
  const d = drafts.data?.find((x) => x.kind === 'split' && (x.status === 'open' || x.status === 'pending'));
  const draftItems = d?.payload.items;
  const items = useMemo(() => draftItems ?? [], [draftItems]);
  const [sel, setSel] = useState<Set<number> | null>(null);
  const [changes, setChanges] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (d?.status === 'open' && sel === null && items.length)
      setSel(new Set(items.filter((i) => i.selected).map((i) => i.n)));
  }, [d?.status, items, sel]);
  if (!d) return null;
  const refresh = () => {
    void drafts.refetch();
    void qc.invalidateQueries({ queryKey: ['tickets'] });
  };
  if (d.status === 'pending')
    return (
      <div className="tw-plan" data-testid="ticket-plan-pending">
        <span className="ai-spin" /> <b>Planning…</b>
        <span className="ai-muted">
          {d.memberName || 'The Board AI'} is drafting sub-tickets for {ticket.id}.
        </span>
      </div>
    );
  const picked = sel ?? new Set<number>();
  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error(failure, assistError(e)?.detail ?? extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const days = d.expiresAt ? Math.max(1, Math.round((new Date(d.expiresAt).getTime() - Date.now()) / 86_400_000)) : 7;
  return (
    <div className="tw-plan tw-plan-open" data-testid="ticket-plan">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="ai-mono" style={{ fontWeight: 700 }}>
          {ticket.id}
        </span>
        <span className="ai-chip" style={{ background: '#F5F3FD', color: '#6D5DD3' }}>
          Plan ready
        </span>
      </div>
      <div style={{ fontSize: 13, margin: '6px 0 10px' }}>
        <b>{d.memberName || 'The Board AI'}</b> drafted {items.length} sub-ticket{items.length === 1 ? '' : 's'} for
        this ticket. Nothing is created until you accept.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((it) => (
          <label key={it.n} className="tw-plan-row" data-testid="plan-item">
            <input
              type="checkbox"
              checked={picked.has(it.n)}
              onChange={() => {
                const next = new Set(picked);
                if (next.has(it.n)) next.delete(it.n);
                else next.add(it.n);
                setSel(next);
              }}
            />
            <span style={{ flex: 1 }}>{it.title}</span>
            {it.estimate != null && <span className="ai-muted ai-mono">{it.estimate} pt</span>}
          </label>
        ))}
      </div>
      {changes !== null && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <input
            className="ai-input"
            autoFocus
            placeholder="What should change?"
            value={changes}
            onChange={(e) => setChanges(e.target.value)}
            data-testid="plan-feedback"
          />
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={!changes.trim() || busy}
            onClick={() =>
              run(async () => {
                await assistApi.regenerate(d.id, { feedback: changes });
                setChanges(null);
                setSel(null);
              }, "Couldn't ask for changes")
            }
          >
            Redraft
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          disabled={busy || picked.size === 0}
          data-testid="plan-create"
          onClick={() =>
            run(async () => {
              await assistApi.apply(d.id, { selected: [...picked], titles: {}, updateParent: false });
              toast.success(
                `Created ${picked.size} sub-ticket${picked.size === 1 ? '' : 's'}`,
                'They start unassigned and are not run automatically.',
              );
            }, "Couldn't create the sub-tickets")
          }
        >
          Create {picked.size} sub-ticket{picked.size === 1 ? '' : 's'}
        </button>
        <button type="button" className="ai-btn" onClick={() => setChanges(changes === null ? '' : null)}>
          Ask for changes
        </button>
        <button
          type="button"
          className="ai-btn"
          disabled={busy}
          data-testid="plan-discard"
          onClick={() => run(() => assistApi.discard(d.id), "Couldn't discard")}
        >
          Discard all
        </button>
        <span className="ai-muted">Drafts expire in {days} days</span>
      </div>
    </div>
  );
}
