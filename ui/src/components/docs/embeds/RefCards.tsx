/**
 * Page and ticket references shown as cards on their own line (design "Embeds", section G): the page card says where
 * the page lives, its opening lines, who edited it and when, and its version; the ticket card its status, title,
 * opening lines, assignee, due date and how many acceptance criteria are done. Both stay live (they read the page and
 * the ticket) and keep working when the target is gone, with the reference chip's "not found" words.
 */

import { useQuery } from '@tanstack/react-query';
import { Fragment, type ReactNode } from 'react';
import { useDocsPage } from '../../../api/docs';
import { getTicket } from '../../../api/tickets';
import type { DocsRefResult } from '../../../types/docs';
import { actorInitials, actorName, relativeTime } from '../../../utils/relativeTime';
import { avatarColors } from '../docsUi';
import { excerptOf } from '../RefChip';
import { EmbIcon } from './embIcons';
import './embeds.css';

const STATUS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't do",
};

/** A round avatar with initials. */
function Avatar({ who }: { who: string }) {
  const c = avatarColors(who);
  return (
    <span className="dk-ref-avatar" style={c} aria-hidden="true">
      {actorInitials(who)}
    </span>
  );
}

const Bar = () => <span className="dk-ref-bar">|</span>;

/** The colour of a status dot (frame 56). */
const DOT: Record<string, string> = {
  backlog: '#9AA8A0',
  todo: '#5B6B60',
  'in-progress': '#2F6FB0',
  review: '#8A5A00',
  testing: '#7C5BD6',
  done: '#2E6F40',
  wont_do: '#9AA8A0',
};

/** A card in its "cannot be found" state (frame 57): a dashed box with an icon, what happened and what to do. */
function GoneCard({
  kind,
  title,
  text,
  icon,
  actions,
}: {
  kind: string;
  title: string;
  text: string;
  icon: 'trash' | 'search';
  actions?: ReactNode;
}) {
  return (
    <div className="dk-ref-gone" role="note" data-testid={`${kind}-card-gone`}>
      <EmbIcon name={icon} size={20} />
      <div className="dk-ref-gone-text">
        <div className="dk-ref-gone-title">{title}</div>
        <div className="dk-ref-gone-why">{text}</div>
        {actions && <div className="dk-ref-gone-btns">{actions}</div>}
      </div>
    </div>
  );
}

/** Props of {@link PageCardView}. */
export interface PageCardViewProps {
  /** The page title the card points at. */
  page: string;
  /** What the server says about the reference (undefined while loading). */
  result: DocsRefResult | null | undefined;
  onOpen?: (pageId: string, anchor?: string | null) => void;
  /** Open in side panel. */
  onPeek?: (pageId: string) => void;
  onCreate?: (title: string) => void;
  onRestore?: (pageId: string) => void;
  /** The editor's own buttons (Show as chip). */
  extra?: ReactNode;
}

/**
 * A page shown as a card.
 */
export function PageCardView({ page, result, onOpen, onPeek, onCreate, onRestore, extra }: PageCardViewProps) {
  const ok = result?.status === 'ok' || result?.status === 'section_missing';
  const q = useDocsPage(ok && result?.pageId ? result.pageId : null);
  if (result?.status === 'in_bin') {
    const who = result.deletedBy ? actorName(result.deletedBy) : 'someone';
    const when = result.deletedAt
      ? new Date(result.deletedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '';
    return (
      <GoneCard
        kind="page"
        icon="trash"
        title="In Recycle Bin"
        text={`${page}: deleted by ${who}${when ? ` on ${when}` : ''}. Restore brings the page back at the same place and this card works again.`}
        actions={
          <>
            {onRestore && result.pageId && (
              <button type="button" className="dk-emb-link" onClick={() => onRestore(result.pageId!)}>
                Restore
              </button>
            )}
            {extra}
          </>
        }
      />
    );
  }
  if (result && !ok) {
    return (
      <GoneCard
        kind="page"
        icon="search"
        title="Page not found"
        text={`No page has the title “${page}”.`}
        actions={
          <>
            {onCreate && page && (
              <button type="button" className="dk-emb-link" onClick={() => onCreate(page)}>
                Create it
              </button>
            )}
            {extra}
          </>
        }
      />
    );
  }
  const data = q.data;
  const path = (data?.path ?? []).map((p) => p.title).filter(Boolean);
  const excerpt = data ? excerptOf(data.markdown ?? '', result?.anchor ?? null) : '';
  const who = data?.updatedBy ?? '';
  return (
    <div className="dk-ref-card dk-page-card" data-testid="page-card">
      <div className="dk-ref-body">
        <div className="dk-ref-where">
          <EmbIcon name="folder" size={13} />
          {path.length ? (
            path.map((t, i) => (
              <Fragment key={i}>
                {i > 0 && <span>›</span>}
                {i === path.length - 1 ? <b>{t}</b> : <span>{t}</span>}
              </Fragment>
            ))
          ) : (
            <b>{result?.path || 'Docs'}</b>
          )}
        </div>
        <div className="dk-ref-title">
          <EmbIcon name="page" size={16} />
          <span>
            {result?.title || page}
            {result?.section && <span className="dk-ref-section"> › # {result.section}</span>}
          </span>
        </div>
        {result === undefined || (ok && q.isLoading) ? (
          <div className="dk-skel dk-skel-line" style={{ width: '80%' }} />
        ) : (
          excerpt && <div className="dk-ref-text">{excerpt}</div>
        )}
        <div className="dk-ref-foot">
          {who && (
            <span className="dk-ref-who">
              <Avatar who={who} />
              {actorName(who)}
            </span>
          )}
          {data && (
            <>
              {who && <Bar />}
              <span>edited {relativeTime(data.updatedAt)}</span>
              <Bar />
              <span>v{data.version}</span>
            </>
          )}
        </div>
      </div>
      {((onOpen && result?.pageId) || (onPeek && result?.pageId) || extra) && (
        <div className="dk-ref-btns">
          {onOpen && result?.pageId && (
            <button
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              onClick={() => onOpen(result.pageId!, result.anchor)}
            >
              <EmbIcon name="open" size={12} sw={2.2} />
              Open
            </button>
          )}
          {onPeek && result?.pageId && (
            <button type="button" className="st-btn st-btn-sm" onClick={() => onPeek(result.pageId!)}>
              <EmbIcon name="panel" size={12} sw={2.2} />
              Open in side panel
            </button>
          )}
          {extra}
        </div>
      )}
    </div>
  );
}

/** Props of {@link TicketCardView}. */
export interface TicketCardViewProps {
  ticketKey: string;
  result: DocsRefResult | null | undefined;
  onOpen?: (ticketId: string) => void;
  extra?: ReactNode;
}

/**
 * A ticket shown as a card.
 */
export function TicketCardView({ ticketKey, result, onOpen, extra }: TicketCardViewProps) {
  const ok = result?.status === 'ok';
  const q = useQuery({
    queryKey: ['tickets', 'card', ticketKey],
    queryFn: () => getTicket(ticketKey),
    enabled: ok && !!ticketKey,
    staleTime: 30_000,
    retry: false,
  });
  if (result && !ok) {
    return (
      <GoneCard
        kind="ticket"
        icon="search"
        title="Ticket not found, or in another project"
        text={`${ticketKey} may have been deleted, or it belongs to a project you cannot see.`}
        actions={extra}
      />
    );
  }
  const t = q.data;
  const status = t?.status ?? result?.ticketStatus ?? '';
  const ac = t?.acceptanceCriteria ?? [];
  const done = ac.filter((c) => c.done).length;
  const desc = (t?.description ?? '').replace(/[#*_`>[\]]/g, '').trim();
  return (
    <div className="dk-ref-card dk-ticket-card" data-testid="ticket-card">
      <div className="dk-ref-body">
        <div className="dk-ref-head">
          <span className="dk-ref-key">
            <EmbIcon name="ticket" size={14} />
            {ticketKey}
          </span>
          <span className="dk-ref-gap" />
          {status && (
            <span className={`dk-ref-status dk-ref-status-${status}`}>
              <span className="dk-ref-dot" style={{ background: DOT[status] ?? '#5B6B60' }} />
              {STATUS[status] ?? status}
            </span>
          )}
        </div>
        <div className="dk-ref-title">{t?.title ?? result?.title ?? ticketKey}</div>
        {desc && <div className="dk-ref-text">{desc.length > 200 ? `${desc.slice(0, 200)}…` : desc}</div>}
        <div className="dk-ref-foot dk-ref-foot-t">
          {t?.assignee && (
            <span className="dk-ref-who">
              <Avatar who={t.assignee} />
              {actorName(t.assignee)}
            </span>
          )}
          {t?.dueDate && (
            <span>{new Date(t.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          )}
          {ac.length > 0 && (
            <span>
              {done} / {ac.length} AC
            </span>
          )}
        </div>
      </div>
      <div className="dk-ref-btns">
        {onOpen && (
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => onOpen(ticketKey)}>
            <EmbIcon name="open" size={12} sw={2.2} />
            Open ticket
          </button>
        )}
        <button
          type="button"
          className="st-btn st-btn-sm"
          onClick={() => void navigator.clipboard?.writeText(ticketKey).catch(() => undefined)}
        >
          <EmbIcon name="copy" size={12} sw={2.2} />
          Copy key
        </button>
        {extra}
      </div>
    </div>
  );
}
