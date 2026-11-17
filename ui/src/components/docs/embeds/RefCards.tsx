/**
 * Page and ticket references shown as cards on their own line (design "Embeds", section G): the page card says where
 * the page lives, its opening lines, who edited it and when, and its version; the ticket card its status, title,
 * opening lines, assignee, due date and how many acceptance criteria are done. Both stay live (they read the page and
 * the ticket) and keep working when the target is gone, with the reference chip's "not found" words.
 */

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDocsPage } from '../../../api/docs';
import { getTicket } from '../../../api/tickets';
import type { DocsRefResult } from '../../../types/docs';
import { actorInitials, actorName, relativeTime } from '../../../utils/relativeTime';
import { avatarColors } from '../docsUi';
import { Icon } from '../Icon';
import { excerptOf } from '../RefChip';
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

/** A card in its "cannot be found" state. */
function GoneCard({ kind, title, text, actions }: { kind: string; title: string; text: string; actions?: ReactNode }) {
  return (
    <div className="dk-ref-card dk-ref-gone" role="note" data-testid={`${kind}-card-gone`}>
      <div className="dk-ref-title">{title}</div>
      <div className="dk-ref-text">{text}</div>
      {actions && <div className="dk-emb-actions">{actions}</div>}
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
        title="In Recycle Bin"
        text={`${page}: deleted by ${who}${when ? ` on ${when}` : ''}. Restore brings the page back at the same place and this card works again.`}
        actions={
          <>
            {onRestore && result.pageId && (
              <button type="button" className="dk-btn-ghost" onClick={() => onRestore(result.pageId!)}>
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
        title="Page not found"
        text={`No page has the title “${page}”.`}
        actions={
          <>
            {onCreate && page && (
              <button type="button" className="dk-btn-ghost" onClick={() => onCreate(page)}>
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
      <div className="dk-ref-where">
        <Icon name="page" size={13} strokeWidth={1.8} />
        {path.length ? path.join(' › ') : result?.path || 'Docs'}
      </div>
      <div className="dk-ref-title">
        {result?.title || page}
        {result?.section && <span className="dk-ref-section"> › # {result.section}</span>}
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
            <Bar />
            <span>edited {relativeTime(data.updatedAt)}</span>
            <Bar />
            <span>v{data.version}</span>
          </>
        )}
        <span className="dk-ref-actions">
          {onOpen && result?.pageId && (
            <button type="button" className="dk-btn-ghost" onClick={() => onOpen(result.pageId!, result.anchor)}>
              Open
            </button>
          )}
          {onPeek && result?.pageId && (
            <button type="button" className="dk-btn-ghost" onClick={() => onPeek(result.pageId!)}>
              Open in side panel
            </button>
          )}
          {extra}
        </span>
      </div>
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
      <div className="dk-ref-where">
        <span className="dk-ref-key">{ticketKey}</span>
        {status && <span className={`dk-ref-status dk-ref-status-${status}`}>{STATUS[status] ?? status}</span>}
      </div>
      <div className="dk-ref-title">{t?.title ?? result?.title ?? ticketKey}</div>
      {desc && <div className="dk-ref-text">{desc.length > 200 ? `${desc.slice(0, 200)}…` : desc}</div>}
      <div className="dk-ref-foot">
        {t?.assignee && (
          <span className="dk-ref-who">
            <Avatar who={t.assignee} />
            {actorName(t.assignee)}
          </span>
        )}
        {t?.dueDate && (
          <>
            {t.assignee && <Bar />}
            <span>{new Date(t.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          </>
        )}
        {ac.length > 0 && (
          <>
            {(t?.assignee || t?.dueDate) && <Bar />}
            <span>
              {done} / {ac.length} AC
            </span>
          </>
        )}
        <span className="dk-ref-actions">
          {onOpen && (
            <button type="button" className="dk-btn-ghost" onClick={() => onOpen(ticketKey)}>
              Open ticket
            </button>
          )}
          <button
            type="button"
            className="dk-btn-ghost"
            onClick={() => void navigator.clipboard?.writeText(ticketKey).catch(() => undefined)}
          >
            Copy key
          </button>
          {extra}
        </span>
      </div>
    </div>
  );
}
