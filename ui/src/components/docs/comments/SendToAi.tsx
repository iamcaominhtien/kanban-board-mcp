import { useEffect, useMemo, useState } from 'react';
import { sentWords, useSendToAi, useSendToAiTargets } from '../../../api/docsComments';
import type { DocsCommentThread, SendToAiTicket } from '../../../types/docs';
import { Icon } from '../Icon';

function errorOf(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: { message?: string } | string } } }).response?.data?.detail;
  return (typeof detail === 'string' ? detail : detail?.message) ?? 'Could not send them. Try again.';
}

function plain(body: string): string {
  return body
    .replace(/@\[([^\]]+)\]\(member:[^)]+\)/g, '@$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a thread still waits for an answer, so it is ticked by default: an inline thread until it is resolved; a
 * page comment (never resolved) while its last word is a person's, not an AI's or a "Sent to …" line.
 */
export function waitsForAnswer(t: DocsCommentThread): boolean {
  if (t.status !== 'open') return false;
  if (t.kind === 'inline') return true;
  const last = t.comments[t.comments.length - 1];
  return !!last && !last.ai && !last.body.startsWith('Sent to ');
}

/** The ticket most of the chosen threads default to, else the first ticket with an AI. */
export function defaultTicket(
  chosen: string[],
  defaults: Record<string, string | null>,
  tickets: SendToAiTicket[],
): string {
  const votes = new Map<string, number>();
  for (const id of chosen) {
    const t = defaults[id];
    if (t) votes.set(t, (votes.get(t) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? tickets.find((t) => t.ais.length > 0)?.id ?? '';
}

function aiLine(t: SendToAiTicket | undefined, memberId: string): string {
  if (!t) return '';
  const ai = t.ais.find((a) => a.id === memberId);
  if (!ai) return `${t.id} has no AI member on it: assign one on the ticket first.`;
  if (ai.working) return `${ai.name} is working on ${t.id}: they reach its run as a message.`;
  if (t.heldBy && t.heldBy !== ai.name) return `${ai.name} starts a run on ${t.id} after ${t.heldBy}'s run ends.`;
  return `${ai.name} starts a run on ${t.id} with them.`;
}

interface Props {
  pageId: string;
  /** The page's open threads: inline ones and page comments. */
  threads: DocsCommentThread[];
  onClose: () => void;
  onSent: (message: string) => void;
}

/**
 * Send the page's comments to an AI on a ticket the page names (the ones still waiting for an answer, by default):
 * it works through them in the ticket's own conversation, changes the page, replies in each thread and resolves it.
 * @param props.pageId - Page whose comments are sent.
 * @param props.threads - Its open threads.
 * @param props.onClose - Close the box.
 * @param props.onSent - Called with what happened, once sent.
 */
export function SendToAiBox({ pageId, threads, onClose, onSent }: Props) {
  const targets = useSendToAiTargets(pageId, true);
  const send = useSendToAi(pageId);
  const [chosen, setChosen] = useState<string[]>(() =>
    threads
      .filter(waitsForAnswer)
      .map((t) => t.id)
      .slice(0, 20),
  );
  const [ticketId, setTicketId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tickets = useMemo(() => targets.data?.tickets ?? [], [targets.data]);
  const picked = tickets.find((t) => t.id === ticketId);

  useEffect(() => {
    // once the targets load: the ticket most of the chosen threads belong to
    if (targets.data && !ticketId) setTicketId(defaultTicket(chosen, targets.data.defaults, tickets));
  }, [targets.data, chosen, tickets, ticketId]);
  useEffect(() => {
    // a ticket's default AI: the one holding it, else its AI assignee
    setMemberId(picked?.ais[0]?.id ?? '');
  }, [picked]);

  const max = targets.data?.maxThreads ?? 20;
  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < max ? [...c, id] : c));
  const allOn = chosen.length === Math.min(threads.length, max);
  const go = async () => {
    setError(null);
    try {
      const r = await send.mutateAsync({ threadIds: chosen, ticketId, memberId });
      onSent(sentWords(r));
    } catch (e) {
      setError(errorOf(e));
    }
  };

  return (
    <section className="dc-sendai" aria-label="Send comments to an AI" data-testid="send-to-ai">
      <div className="dc-sendai-head">
        <b>Send comments to an AI</b>
        <button type="button" className="dc-icon" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} strokeWidth={1.9} />
        </button>
      </div>
      <p className="dc-sendai-hint">
        The AI works through them in the ticket&rsquo;s own conversation: it changes the page, replies in each thread
        and resolves it.
      </p>
      {threads.length === 0 ? (
        <p className="dc-sendai-hint">There are no open comments to send.</p>
      ) : (
        <>
          <div className="dc-sendai-count">
            <span>
              {chosen.length} of {threads.length} chosen
              {threads.length > max ? ` · at most ${max} at a time` : ''}
            </span>
            <button
              type="button"
              className="dc-link-btn"
              onClick={() => setChosen(allOn ? [] : threads.slice(0, max).map((t) => t.id))}
              data-testid="send-to-ai-all"
            >
              {allOn ? 'Choose none' : threads.length > max ? `Choose the first ${max}` : 'Choose all'}
            </button>
          </div>
          <ul className="dc-sendai-list">
            {threads.map((t) => (
              <li key={t.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(t.id)}
                    disabled={!chosen.includes(t.id) && chosen.length >= max}
                    onChange={() => toggle(t.id)}
                    data-testid={`send-to-ai-thread-${t.id}`}
                  />
                  <span>
                    {t.kind === 'page' ? <b>Page comment · </b> : t.number != null && <b>{t.number}. </b>}
                    {t.anchor?.quote && <q>{t.anchor.quote.slice(0, 80)}</q>}{' '}
                    <span className="dc-sendai-body">{plain(t.comments[0]?.body ?? '').slice(0, 120)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="dc-sendai-to">
        <label className="dc-sendai-ticket">
          <span>Ticket</span>
          <select
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            disabled={!targets.data || tickets.length === 0}
            data-testid="send-to-ai-ticket"
          >
            {tickets.length === 0 && (
              <option value="">{targets.isLoading ? 'Loading…' : 'The page names no ticket'}</option>
            )}
            {tickets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.title.slice(0, 50)}
              </option>
            ))}
          </select>
        </label>
        <label className="dc-sendai-ticket">
          <span>AI</span>
          <select
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            disabled={!picked || picked.ais.length === 0}
            data-testid="send-to-ai-member"
          >
            {(!picked || picked.ais.length === 0) && <option value="">No AI on it</option>}
            {picked?.ais.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.working ? ' (working on it)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {picked && <p className="dc-sendai-hint">{aiLine(picked, memberId)}</p>}
      {error && (
        <div className="dc-failed" role="alert">
          {error}
        </div>
      )}
      <div className="dc-sendai-foot">
        <button type="button" className="dc-plain dc-bordered" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="dc-send"
          disabled={send.isPending || chosen.length === 0 || !memberId}
          onClick={() => void go()}
          data-testid="send-to-ai-go"
        >
          {send.isPending ? 'Sending…' : `Send ${chosen.length}`}
        </button>
      </div>
    </section>
  );
}
