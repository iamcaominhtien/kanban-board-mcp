import { useState } from 'react';
import { useDeleteOrder, useFirings, usePatchOrder, useUndoFiring } from '../../../../api/aiOrders';
import { extractError } from '../../../../api/extractError';
import type { Firing, Order } from '../../../../types/aiOrders';
import { LoadError } from '../../aiUi';
import { dayTime, NOT_FIRED_YET } from './ordersText';
import './orders.css';

function TicketChip({ id }: { id: string }) {
  return (
    <span className="so-ticket">
      <i />
      {id}
    </span>
  );
}

/** One firing: what set it off, what it did (or would have done), and Undo. A trial firing never reads like a real one. */
function FiringRow({
  f,
  orderName,
  onUndo,
  undoing,
}: {
  f: Firing;
  orderName?: string;
  onUndo: () => void;
  undoing: boolean;
}) {
  const undone = !!f.undoneAt;
  const cls = `so-firing${f.would ? ' so-firing-would' : ''}`;
  const ticket = f.ticketId ?? f.target;
  return (
    <div className={cls} data-testid={f.would ? 'firing-would' : 'firing-real'}>
      <span className="so-firing-time">{dayTime(f.at)}</span>
      <span className="so-firing-body">
        {f.would ? (
          <span className="so-tag so-tag-would">Would have</span>
        ) : (
          <span className={`so-tag ${undone ? 'so-tag-undone' : 'so-tag-did'}`}>{undone ? 'Put back' : 'Did'}</span>
        )}
        {orderName && <b>{orderName} · </b>}
        {f.action.label}
        {ticket && (
          <>
            {' '}
            <TicketChip id={ticket} />
          </>
        )}
        . <span className="ai-hint">{f.trigger.title}</span>
        {f.trigger.detail && <div className="ai-hint">{f.trigger.detail}</div>}
        {f.result && !f.would && <div className="ai-hint">{f.result}</div>}
        {undone && (
          <div className="ai-hint">
            Put back{f.undoneBy ? ` by ${f.undoneBy}` : ''} · {dayTime(f.undoneAt)}
          </div>
        )}
      </span>
      {f.canUndo && (
        <button type="button" className="ai-btn ai-btn-sm" disabled={undoing} onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}

/** The history of one rule ("Read the trial" while it trials), or of all of them ("Everything they did"). */
export function FiringsPanel({
  projectId,
  order,
  orders,
  onClose,
  onEdit,
}: {
  projectId: string;
  /** One rule's history; omit for everything. */
  order?: Order;
  orders: Order[];
  onClose: () => void;
  onEdit?: (o: Order) => void;
}) {
  const q = useFirings(projectId, order?.id ?? null);
  const undo = useUndoFiring(projectId);
  const patch = usePatchOrder(projectId);
  const del = useDeleteOrder(projectId);
  const [sure, setSure] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const names = new Map(orders.map((o) => [o.id, o.name]));
  const trial = order?.state === 'trial';
  const list = q.data ?? [];

  const title = !order
    ? 'Everything they did'
    : trial
      ? `Trial of “${order.name}” · ${order.wouldHave} would-have${order.wouldHave === 1 ? '' : 's'}`
      : `History of “${order.name}” · ${order.fired} firing${order.fired === 1 ? '' : 's'}`;

  return (
    <div className={`so-panel${trial ? ' so-panel-trial' : ''}`} data-testid="firings-panel">
      <div className="so-panel-title">
        <b>{title}</b>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {trial && (
        <div className="so-hint">
          In trial nothing is changed. Each line is what the rule would have done, marked <i>would have</i>.
        </div>
      )}
      {msg && (
        <div
          className={`ai-notice ${msg.ok ? 'ai-notice-info' : 'ai-notice-error'}`}
          role={msg.ok ? 'status' : 'alert'}
        >
          {msg.text}
        </div>
      )}
      {q.isLoading ? (
        <div className="ai-skel" style={{ height: 48 }} aria-busy="true" aria-label="Loading" />
      ) : q.error ? (
        <LoadError what="the firings" error={q.error} onRetry={() => void q.refetch()} />
      ) : list.length === 0 ? (
        <div className="ai-hint" data-testid="firings-empty">
          {trial
            ? 'The trial has not fired yet. When the signal shows up, it is written here.'
            : 'Nothing has fired yet.'}
        </div>
      ) : (
        list.map((f) => (
          <FiringRow
            key={f.id}
            f={f}
            orderName={order ? undefined : names.get(f.orderId)}
            undoing={undo.isPending}
            onUndo={() => {
              setMsg(null);
              undo.mutate(f.id, {
                onSuccess: (r) => setMsg({ ok: true, text: r.text }),
                onError: (e) => setMsg({ ok: false, text: extractError(e) }),
              });
            }}
          />
        ))
      )}
      {order && (
        <div className="so-actions" style={{ paddingTop: 3 }}>
          {trial && (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={!order.canGoLive || patch.isPending}
              title={order.canGoLive ? undefined : NOT_FIRED_YET}
              onClick={() => {
                setMsg(null);
                patch.mutate(
                  { id: order.id, body: { state: 'on' } },
                  { onSuccess: onClose, onError: (e) => setMsg({ ok: false, text: extractError(e) }) },
                );
              }}
            >
              Turn it on
            </button>
          )}
          {onEdit && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => onEdit(order)}>
              Change the rule
            </button>
          )}
          {trial && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
              Keep trialling
            </button>
          )}
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-danger-outline"
            disabled={del.isPending}
            onClick={() => {
              if (!sure) return setSure(true);
              del.mutate(order.id, {
                onSuccess: onClose,
                onError: (e) => setMsg({ ok: false, text: extractError(e) }),
              });
            }}
          >
            {sure ? 'Really delete the rule?' : 'Delete the rule'}
          </button>
        </div>
      )}
    </div>
  );
}
