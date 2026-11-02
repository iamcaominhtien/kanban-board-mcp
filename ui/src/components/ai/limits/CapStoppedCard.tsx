import { useState } from 'react';
import { useTicketRuns } from '../../../api/ai';
import { useWorkflowMutation, workflowApi } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import type { Ticket } from '../../../types';
import type { WorkflowView } from '../../../types/aiWorkflow';
import { STATUS_NAMES } from '../../../hooks/useMarkerActions';
import { Ico } from '../../story/storyUi';
import { useAiBoardState } from '../aiUi';
import { RoleChip } from '../workflow/WfUi';
import { fullNumber, heldStep, kTokens, parseCapDetail, tokensPerStep } from './capModel';
import './limits.css';

const BAR = ['#9AA8A0', '#7DBF8E', '#5B8FC9', '#B48AD8', '#E8B93A'];

/**
 * A ticket whose workflow stopped at its token cap (ai-story-flow O): what it used against the cap, who held it, and
 * the three ways on: Resume (the same cap again, counted from now), Raise the cap to… (a higher cap for this ticket)
 * and Stop the ticket (it leaves its workflow).
 * @param props.ticket - The ticket that stopped.
 * @param props.view - Its workflow, stopped with `stopReason` quota_cap.
 * @param props.story - The Story it belongs to, when there is one.
 */
export function CapStoppedCard({
  ticket,
  view,
  story,
}: {
  ticket: Ticket;
  view: WorkflowView;
  story?: { id: string; title: string } | null;
}) {
  const { openTicket } = useAiBoardState();
  const runs = useTicketRuns(ticket.id);
  const [raising, setRaising] = useState(false);
  const [capText, setCapText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const resume = useWorkflowMutation(ticket.id, (cap: number | undefined) => workflowApi.resume(ticket.id, cap));
  const stop = useWorkflowMutation(ticket.id, (_: void) => workflowApi.detach(ticket.id));
  const nums = parseCapDetail(view.stopDetail);
  const holder = heldStep(view);
  const holderName = holder?.memberName ?? 'The AI';
  const parts = tokensPerStep(view, runs.data ?? []);
  const partsTotal = parts.reduce((a, p) => a + p.tokens, 0);
  const newCap = Number(capText.replace(/[^\d]/g, ''));
  const capOk = !!capText.trim() && Number.isFinite(newCap) && newCap > (nums?.used ?? 0);
  const busy = resume.isPending || stop.isPending;
  const fail = (x: unknown) => setError(extractError(x));
  const storyRef = story ?? (ticket.parentId ? { id: ticket.parentId, title: '' } : null);
  return (
    <div className="lim-card ai-root" data-testid="cap-stopped-card" role="status">
      <div className="lim-main">
        <div className="lim-line">
          <Ico name="pause" size={14} color="#7A5A06" />
          <b style={{ fontSize: 14 }}>Stopped at its token cap</b>
          <span className="lim-chip lim-chip-red">Quota cap for this ticket</span>
          <span className="lim-chip lim-chip-you">Straight to you</span>
        </div>
        <div className="lim-text" data-testid="cap-detail">
          {view.stopDetail ?? 'It used the tokens the cap allows one ticket.'}
        </div>
        <div className="lim-hint">
          The cap you turned on for this ticket was reached. {holderName} stopped at the end of its turn and kept its
          work; the ticket sits in {STATUS_NAMES[ticket.status] ?? ticket.status}. It is a row in Needs you.
        </div>
        {raising ? (
          <form
            className="lim-raise"
            data-testid="cap-raise"
            onSubmit={(e) => {
              e.preventDefault();
              if (!capOk) return;
              setError(null);
              resume.mutate(newCap, { onError: fail, onSuccess: () => setRaising(false) });
            }}
          >
            <label className="lim-hint" htmlFor={`cap-${ticket.id}`}>
              Raise the cap for this ticket to
            </label>
            <input
              id={`cap-${ticket.id}`}
              inputMode="numeric"
              value={capText}
              placeholder={nums ? fullNumber(Math.ceil((nums.used * 1.5) / 50_000) * 50_000) : '600,000'}
              onChange={(e) => setCapText(e.target.value)}
              autoFocus
            />
            <span className="lim-hint">tokens</span>
            <button type="submit" className="ai-btn ai-btn-primary ai-btn-sm" disabled={!capOk || busy}>
              Raise and resume
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setRaising(false)}>
              Cancel
            </button>
            {capText.trim() && !capOk && nums && (
              <span className="lim-hint" style={{ color: '#A5321E', width: '100%' }}>
                Set a cap above what it already used ({fullNumber(nums.used)}).
              </span>
            )}
          </form>
        ) : (
          <div className="lim-line">
            <button
              type="button"
              className="ai-btn ai-btn-primary ai-btn-sm"
              data-testid="cap-resume"
              disabled={busy}
              onClick={() => {
                setError(null);
                resume.mutate(undefined, { onError: fail });
              }}
            >
              <Ico name="play" size={11} /> Resume
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              data-testid="cap-raise-open"
              disabled={busy}
              onClick={() => setRaising(true)}
            >
              Raise the cap to&hellip;
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm lim-stop"
              data-testid="cap-stop"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Stop ${ticket.id}? It leaves its workflow; the work done so far is kept and nothing more runs.`,
                  )
                )
                  return;
                setError(null);
                stop.mutate(undefined, { onError: fail });
              }}
            >
              <Ico name="x" size={11} /> Stop the ticket
            </button>
          </div>
        )}
        <div className="lim-hint" style={{ fontSize: 11.5 }}>
          Resume gives it another {nums ? fullNumber(nums.cap) : 'cap of'} tokens counted from now.
          {story ? ' The Story it belongs to keeps its own total.' : ''}
        </div>
        {error && (
          <div className="ai-error-text" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="lim-facts">
        <div className="lim-fact">
          <span className="lim-h">Held by</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <RoleChip role={holder?.role ?? null} title={holder?.role ?? ''} />
            {holderName}
          </span>
        </div>
        {nums && (
          <div className="lim-fact" data-testid="cap-tokens">
            <span className="lim-h">Tokens on this ticket</span>
            <span className="lim-big">{fullNumber(nums.used)}</span>
            {partsTotal > 0 && (
              <span className="lim-bar" aria-hidden="true">
                {parts.map((p, i) => (
                  <i
                    key={p.label + i}
                    style={{ width: `${(p.tokens / partsTotal) * 100}%`, background: BAR[i % BAR.length] }}
                  />
                ))}
              </span>
            )}
            <span className="lim-hint" style={{ fontSize: 11.5 }}>
              cap {fullNumber(nums.cap)}
              {parts.length > 0 ? ` · ${parts.map((p) => `${p.label} ${kTokens(p.tokens)}`).join(', ')}` : ''}
            </span>
          </div>
        )}
        <div className="lim-fact">
          <span className="lim-h">Cap</span>
          <span style={{ fontSize: 12.5 }}>
            Set per project: <b>Tokens one ticket may use</b>. 0 is no cap, which is the default.
          </span>
        </div>
        {storyRef && (
          <div className="lim-fact">
            <span className="lim-h">{story ? 'Story' : 'Part of'}</span>
            <span>
              <button type="button" className="lim-story" onClick={() => openTicket?.(storyRef.id)}>
                <code>{storyRef.id}</code>
                {storyRef.title && <span>{storyRef.title}</span>}
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
