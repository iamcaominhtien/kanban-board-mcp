import { useEffect, useMemo, useRef, useState } from 'react';
import {
  sendErrorCode,
  useSendToAi,
  useSendToAiTargets,
  type SendDestination,
  type SendTicket,
  type SendToAiTargets,
} from '../../../api/docsSendToAi';
import { extractError } from '../../../api/extractError';
import type { DocsCommentThread, DocsCommentsResult } from '../../../types/docs';
import { useAssist } from '../../assist/AssistContext';
import { useToast } from '../../Toast';
import { Icon } from '../Icon';
import { personOf } from './people';
import { clearSendToAiRequest, requestSendToAi, useSendToAiRequest } from './sendToAiRequest';

const SEARCH_LIMIT = 8;

function plain(body: string): string {
  return body
    .replace(/@\[([^\]]+)\]\(member:[^)]+\)/g, '@$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a thread still waits for an answer, so it is ticked by default: an inline thread until it is resolved (unless
 * the board's "Sent to …" line is already its last word); a page comment (never resolved) while its last word is a
 * person's, not an AI's or a "Sent to …" line.
 */
export function waitsForAnswer(t: DocsCommentThread): boolean {
  if (t.status !== 'open') return false;
  const last = t.comments[t.comments.length - 1];
  if (t.kind === 'inline') return !last || last.ai?.kind !== 'sent';
  return !!last && !last.ai;
}

/** The ticket of a state chip: what its team is doing, in the words of the board. */
export function teamChip(t: SendTicket): { text: string; tone: 'working' | 'idle' | 'none' | 'asking' } {
  if (!t.team) return { text: 'No team', tone: 'none' };
  if (t.team.state === 'asking') return { text: `${t.team.name} · asking you`, tone: 'asking' };
  if (t.team.state === 'working') return { text: `${t.team.name} · working`, tone: 'working' };
  return { text: `${t.team.name} · idle`, tone: 'idle' };
}

function askingText(t: SendTicket): string {
  return `${t.team?.name ?? 'The team'} is asking you: answer first`;
}

function TicketRow({
  ticket,
  badge,
  checked,
  onPick,
}: {
  ticket: SendTicket;
  badge?: string;
  checked: boolean;
  onPick: () => void;
}) {
  const chip = teamChip(ticket);
  const asking = ticket.team?.state === 'asking';
  return (
    <li>
      <label
        className={`dc-sendai-tk${checked ? ' is-on' : ''}${asking ? ' is-off' : ''}`}
        title={asking ? askingText(ticket) : undefined}
      >
        <input
          type="radio"
          name="dc-sendai-ticket"
          checked={checked}
          disabled={asking}
          onChange={onPick}
          data-testid={`send-to-ai-ticket-${ticket.id}`}
        />
        <span className="dc-sendai-tk-main">
          <span className="dc-sendai-tk-line">
            <b>{ticket.id}</b>
            <span className="dc-sendai-tk-title">{ticket.title}</span>
          </span>
          <span className="dc-sendai-tk-chips">
            {badge && <span className="dc-sendai-chip is-badge">{badge}</span>}
            {ticket.relations.map((r) => (
              <span key={r.kind + r.label} className="dc-sendai-chip">
                {r.label}
              </span>
            ))}
            <span className={`dc-sendai-chip is-${chip.tone}`} data-testid="send-to-ai-team-state">
              {chip.text}
            </span>
          </span>
          {asking && <span className="dc-sendai-warn">{askingText(ticket)}</span>}
        </span>
      </label>
    </li>
  );
}

interface BoxProps {
  pageId: string;
  data: DocsCommentsResult;
}

/**
 * The "Send to AI" box at the top of a page's comments: tick the open threads, choose who receives them (the team of a
 * ticket, the Board AI, or the page's assistant) and send. Collapsed to a button until opened.
 * @param props.pageId - Page whose threads are sent.
 * @param props.data - The page's comments result (threads, members, role).
 */
export function SendToAiBox({ pageId, data }: BoxProps) {
  const toast = useToast();
  const assist = useAssist();
  const canSend = data.role !== 'viewer';
  const open = useMemo(() => data.threads.filter((t) => t.status === 'open'), [data.threads]);
  const [expanded, setExpanded] = useState(false);
  const targets = useSendToAiTargets(pageId, canSend && open.length > 0);
  const send = useSendToAi(pageId);
  const [chosen, setChosen] = useState<string[]>([]);
  const [to, setTo] = useState<SendDestination>('team');
  const [pickedTicket, setPickedTicket] = useState<string | null>(null);
  const [giveTeamId, setGiveTeamId] = useState('');
  const [q, setQ] = useState('');
  const request = useSendToAiRequest(pageId);
  const openRef = useRef(open);
  openRef.current = open;
  const max = targets.data?.maxThreads ?? 20;

  const start = (ids?: string[]) => {
    setChosen(
      ids ??
        openRef.current
          .filter(waitsForAnswer)
          .map((t) => t.id)
          .slice(0, max),
    );
    setTo('team');
    setPickedTicket(null);
    setQ('');
    setExpanded(true);
  };

  useEffect(() => {
    // a thread's "choose where to send it" button
    if (!request) return;
    start(request.threadIds.filter((id) => openRef.current.some((t) => t.id === id)));
    clearSendToAiRequest();
    // start only reads refs and the max
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // a thread that got resolved or removed is no longer chosen
  useEffect(() => {
    setChosen((c) =>
      c.every((id) => open.some((t) => t.id === id)) ? c : c.filter((id) => open.some((t) => t.id === id)),
    );
  }, [open]);

  const tk = targets.data;
  const byId = useMemo(() => {
    const m = new Map<string, SendTicket>();
    for (const t of tk?.others ?? []) m.set(t.id, t);
    for (const t of tk?.tickets ?? []) m.set(t.id, t);
    return m;
  }, [tk]);

  // the first chosen thread (in the order of the list) sets the order and the default of the tickets
  const firstId = open.find((t) => chosen.includes(t.id))?.id;
  const firstTargets = tk?.threads.find((t) => t.threadId === firstId);
  const ids = useMemo(() => {
    const out: string[] = [];
    for (const o of firstTargets?.order ?? [])
      if (byId.has(o.ticketId) && !out.includes(o.ticketId)) out.push(o.ticketId);
    for (const t of tk?.tickets ?? []) if (!out.includes(t.id)) out.push(t.id);
    return out;
  }, [firstTargets, tk, byId]);
  const badges = useMemo(
    () => new Map((firstTargets?.order ?? []).map((o) => [o.ticketId, o.badge?.label] as const)),
    [firstTargets],
  );
  const listed = new Set(ids);
  const needle = q.trim().toLowerCase();
  const found = useMemo(
    () =>
      needle
        ? (tk?.others ?? [])
            .filter(
              (t) =>
                !listed.has(t.id) && (t.id.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle)),
            )
            .slice(0, SEARCH_LIMIT)
        : [],
    // `listed` is derived from `ids`
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needle, tk, ids],
  );

  const defaultId =
    firstTargets?.default && byId.get(firstTargets.default)?.team?.state !== 'asking' ? firstTargets.default : null;
  const ticketId = pickedTicket ?? defaultId ?? ids.find((id) => byId.get(id)?.team?.state !== 'asking') ?? '';
  const ticket = ticketId ? byId.get(ticketId) : undefined;

  const teams = tk?.teams ?? [];
  const builder = tk?.builderTeam ?? null;
  const giveTeam = builder ?? teams.find((t) => t.id === giveTeamId) ?? teams[0] ?? null;
  const noTeamAtAll = !!tk && teams.length === 0 && !builder;
  const needsTeam = to === 'team' && !!ticket && !ticket.team;

  if (!canSend || open.length === 0) return null;

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < max ? [...c, id] : c));
  const allOn = chosen.length === Math.min(open.length, max);

  const unavailable =
    (to === 'board_ai' && !tk?.boardAi.available) || (to === 'page_assistant' && !tk?.pageAssistant.available);
  const blocked =
    !tk ||
    chosen.length === 0 ||
    unavailable ||
    (to === 'team' && (!ticket || ticket.team?.state === 'asking' || (needsTeam && !giveTeam)));

  const n = chosen.length;
  const label =
    to === 'board_ai'
      ? 'Send to the Board AI'
      : to === 'page_assistant'
        ? "Send to the page's assistant"
        : !ticket
          ? 'Choose a ticket'
          : needsTeam
            ? giveTeam
              ? `Give to ${giveTeam.name} and send`
              : 'This ticket has no team'
            : `Send ${n} ${n === 1 ? 'comment' : 'comments'} to ${ticket.id}`;

  const go = async () => {
    try {
      const r = await send.mutateAsync({
        threadIds: chosen,
        to,
        ...(to === 'team' ? { ticketId, ...(needsTeam && giveTeam ? { giveTeamId: giveTeam.id } : {}) } : {}),
      });
      setExpanded(false);
      toast.success('Sent to AI', r.note);
    } catch (e) {
      const code = sendErrorCode(e);
      toast.error(
        code === 'team_asking' ? 'The team is asking you first' : "Couldn't send the comments",
        extractError(e),
      );
    }
  };

  if (!expanded) {
    return (
      <div className="dc-sendai-bar">
        <button
          type="button"
          className="dc-plain dc-bordered dc-sendai-open"
          onClick={() => start()}
          data-testid="send-to-ai-open"
        >
          <Icon name="send" size={13} strokeWidth={1.9} /> Send to AI
          <span className="dc-count-pill">{open.length}</span>
        </button>
      </div>
    );
  }

  return (
    <section className="dc-sendai" aria-label="Send comments to an AI" data-testid="send-to-ai">
      <div className="dc-sendai-head">
        <b>Send to AI</b>
        <button type="button" className="dc-icon" aria-label="Close" onClick={() => setExpanded(false)}>
          <Icon name="close" size={14} strokeWidth={1.9} />
        </button>
      </div>
      <div className="dc-sendai-count">
        <span>
          {chosen.length} of {open.length} chosen
          {open.length > max ? ` · at most ${max} at a time` : ''}
        </span>
        <button
          type="button"
          className="dc-link-btn"
          onClick={() => setChosen(allOn ? [] : open.slice(0, max).map((t) => t.id))}
          data-testid="send-to-ai-all"
        >
          {allOn ? 'Choose none' : open.length > max ? `Choose the first ${max}` : 'Choose all'}
        </button>
      </div>
      <ul className="dc-sendai-list">
        {open.map((t) => {
          const last = t.comments.filter((c) => c.ai?.kind !== 'sent').slice(-1)[0];
          const lastBy = last ? personOf(last.author, data.members, data.me).name : null;
          return (
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
                  {lastBy && t.comments.length > 1 && <span className="dc-sendai-last"> · last: {lastBy}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <fieldset className="dc-sendai-dest">
        <legend>Send to</legend>
        <DestOption
          value="team"
          to={to}
          onTo={setTo}
          title="The team of a ticket"
          hint="The team changes the page and answers in each thread."
        />
        <DestOption
          value="board_ai"
          to={to}
          onTo={setTo}
          title="Board AI decides"
          hint={
            tk && !tk.boardAi.available
              ? 'Not available: Docs AI is off or has no AI member.'
              : 'It reads the threads, finds the ticket and sends them to its team, or answers itself.'
          }
          disabled={!!tk && !tk.boardAi.available}
        />
        <DestOption
          value="page_assistant"
          to={to}
          onTo={setTo}
          title="The page's assistant"
          hint={
            tk && !tk.pageAssistant.available
              ? 'Not available: Docs AI is off or has no AI member.'
              : 'Questions, search and small things on this page.'
          }
          disabled={!!tk && !tk.pageAssistant.available}
        />
      </fieldset>

      {to === 'team' && (
        <div className="dc-sendai-tickets" data-testid="send-to-ai-tickets">
          {targets.isLoading && <p className="dc-sendai-hint">Loading tickets…</p>}
          {targets.isError && (
            <p className="dc-sendai-hint">
              Could not load the tickets.{' '}
              <button type="button" className="dc-link-btn" onClick={() => void targets.refetch()}>
                Retry
              </button>
            </p>
          )}
          {tk && ids.length === 0 && <p className="dc-sendai-hint">No ticket is tied to this page. Find one below.</p>}
          {tk && ids.length > 0 && (
            <ul className="dc-sendai-tklist">
              {ids.map((id) => {
                const t = byId.get(id);
                return (
                  t && (
                    <TicketRow
                      key={id}
                      ticket={t}
                      badge={badges.get(id)}
                      checked={ticketId === id}
                      onPick={() => setPickedTicket(id)}
                    />
                  )
                );
              })}
            </ul>
          )}
          {tk && (
            <>
              <input
                className="dc-sendai-search"
                type="search"
                placeholder="Find any ticket of the project"
                aria-label="Find any ticket of the project"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                data-testid="send-to-ai-search"
              />
              {needle && found.length === 0 && <p className="dc-sendai-hint">No other ticket matches.</p>}
              {found.length > 0 && (
                <ul className="dc-sendai-tklist">
                  {found.map((t) => (
                    <TicketRow key={t.id} ticket={t} checked={ticketId === t.id} onPick={() => setPickedTicket(t.id)} />
                  ))}
                </ul>
              )}
              {ticket && !listed.has(ticket.id) && !found.some((t) => t.id === ticket.id) && (
                <ul className="dc-sendai-tklist">
                  <TicketRow ticket={ticket} checked onPick={() => undefined} />
                </ul>
              )}
            </>
          )}
          {needsTeam && (
            <div className="dc-sendai-give" data-testid="send-to-ai-give">
              {noTeamAtAll ? (
                <p className="dc-sendai-hint">
                  This project has no AI team:{' '}
                  {assist ? (
                    <button type="button" className="dc-link-btn" onClick={assist.onOpenAiMembers}>
                      add one in Members
                    </button>
                  ) : (
                    'add one in Members'
                  )}
                </p>
              ) : (
                <>
                  <p className="dc-sendai-hint">
                    {ticket.id} has no team yet. Give it one and the comments go with it.
                  </p>
                  {!builder && teams.length > 1 && (
                    <label className="dc-sendai-ticket">
                      <span>Team</span>
                      <select
                        value={giveTeam?.id ?? ''}
                        onChange={(e) => setGiveTeamId(e.target.value)}
                        data-testid="send-to-ai-give-team"
                      >
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <div className="dc-sendai-foot">
        <button type="button" className="dc-plain dc-bordered" onClick={() => setExpanded(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="dc-send"
          disabled={send.isPending || blocked}
          onClick={() => void go()}
          data-testid="send-to-ai-go"
        >
          {send.isPending && <span className="dc-spin" />}
          {send.isPending ? 'Sending…' : label}
        </button>
      </div>
    </section>
  );
}

function DestOption({
  value,
  to,
  onTo,
  title,
  hint,
  disabled,
}: {
  value: SendDestination;
  to: SendDestination;
  onTo: (v: SendDestination) => void;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <label className={`dc-sendai-opt${disabled ? ' is-off' : ''}`}>
      <input
        type="radio"
        name="dc-sendai-to"
        checked={to === value}
        disabled={disabled}
        onChange={() => onTo(value)}
        data-testid={`send-to-ai-to-${value}`}
      />
      <span>
        <b>{title}</b>
        <span className="dc-sendai-hint">{hint}</span>
      </span>
    </label>
  );
}

/** The ticket a thread goes to by default, or null. */
export function threadDefault(targets: SendToAiTargets | undefined, threadId: string): SendTicket | null {
  const id = targets?.threads.find((t) => t.threadId === threadId)?.default;
  if (!id || !targets) return null;
  return targets.tickets.find((t) => t.id === id) ?? targets.others.find((t) => t.id === id) ?? null;
}

/**
 * The small buttons in an open thread's action row: "Send to KAN-12" (its default ticket) and "▾" to choose another
 * ticket or destination in the Send to AI box, with this thread ticked.
 * @param props.pageId - Page the thread belongs to.
 * @param props.threadId - The open thread.
 */
export function ThreadSendButton({ pageId, threadId }: { pageId: string; threadId: string }) {
  const targets = useSendToAiTargets(pageId, true);
  if (!targets.data) return null;
  return <ThreadSend pageId={pageId} threadId={threadId} targets={targets.data} />;
}

function ThreadSend({ pageId, threadId, targets }: { pageId: string; threadId: string; targets: SendToAiTargets }) {
  const toast = useToast();
  const send = useSendToAi(pageId);
  const t = threadDefault(targets, threadId);
  const asking = t?.team?.state === 'asking';
  const direct = !!t && !!t.team && !asking;
  const choose = () => requestSendToAi(pageId, [threadId]);
  const go = async () => {
    if (!t || !direct) return choose();
    try {
      const r = await send.mutateAsync({ threadIds: [threadId], to: 'team', ticketId: t.id });
      toast.success('Sent to AI', r.note);
    } catch (e) {
      toast.error("Couldn't send the comment", extractError(e));
    }
  };
  return (
    <div className="dc-thread-send" onClick={(e) => e.stopPropagation()} data-testid="thread-send-to-ai">
      <button
        type="button"
        className="dc-plain dc-bordered dc-thread-send-main"
        disabled={send.isPending || asking}
        title={
          asking && t
            ? askingText(t)
            : t && !t.team
              ? `${t.id} has no team: choose one to send`
              : t
                ? `Send this thread to the team of ${t.id}`
                : 'Choose who receives this thread'
        }
        onClick={() => void go()}
        data-testid="thread-send-main"
      >
        {send.isPending ? <span className="dc-spin" /> : <Icon name="send" size={12} strokeWidth={1.9} />}
        {t ? `Send to ${t.id}` : 'Send to AI'}
      </button>
      <button
        type="button"
        className="dc-plain dc-bordered dc-thread-send-more"
        aria-label="Choose where to send this thread"
        title="Choose another ticket or destination"
        onClick={choose}
        data-testid="thread-send-more"
      >
        <Icon name="chevronDown" size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}
