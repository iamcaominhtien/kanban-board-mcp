import { useMemo, useState } from 'react';
import { useDocsCommentEvents, type useCommentActions } from '../../../api/docsComments';
import type { DocsCommentsResult } from '../../../types/docs';
import { relativeTime } from '../../../utils/relativeTime';
import { Icon } from '../Icon';
import { personOf } from './people';
import { ThreadCard } from './ThreadCard';
import { getAvatarColors } from '../../MemberAvatar';

export type CommentTab = 'all' | 'open' | 'resolved';

interface Props {
  pageId: string;
  projectId: string;
  version: number;
  data: DocsCommentsResult | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  actions: ReturnType<typeof useCommentActions>;
  tab: CommentTab;
  onTab: (t: CommentTab) => void;
  activeId: string | null;
  onActivate: (id: string) => void;
  reattachId: string | null;
  onReattach: (id: string | null) => void;
  onClose: () => void;
}

const EVENT_TEXT: Record<string, string> = {
  comment: 'commented',
  reply: 'replied',
  resolved: 'resolved a thread',
  reopened: 'reopened a thread',
};

/**
 * The "Inline comments" side panel: All / Open / Resolved tabs, numbered thread cards and the page's comment activity.
 * @param props.pageId - Page whose comments are shown.
 * @param props.projectId - Project used by the suggestion menu and Activity.
 * @param props.version - Published version, shown on orphaned threads.
 * @param props.data - Comments result; undefined while loading.
 * @param props.loading - Show the loading state.
 * @param props.error - Show the load error state.
 * @param props.onRetry - Reload the comments.
 * @param props.actions - Comment mutations.
 * @param props.tab - Current tab.
 * @param props.onTab - Change tab.
 * @param props.activeId - Thread whose highlight is selected.
 * @param props.onActivate - Select a thread.
 * @param props.reattachId - Thread waiting for a new selection.
 * @param props.onReattach - Start or cancel re-attaching.
 * @param props.onClose - Close the panel.
 */
export function CommentsPanel({
  pageId,
  projectId,
  version,
  data,
  loading,
  error,
  onRetry,
  actions,
  tab,
  onTab,
  activeId,
  onActivate,
  reattachId,
  onReattach,
  onClose,
}: Props) {
  const [showActivity, setShowActivity] = useState(false);
  const events = useDocsCommentEvents(projectId);
  const inline = useMemo(() => (data?.threads ?? []).filter((t) => t.kind === 'inline'), [data]);
  const shown = inline.filter((t) => tab === 'all' || t.status === tab);
  const suggest = useMemo(
    () => (data?.members ?? []).map((m) => ({ id: m.id, name: m.name, ...getAvatarColors(m.color) })),
    [data],
  );
  const c = data?.counts;
  const pageEvents = (events.data ?? []).filter((e) => e.pageId === pageId).slice(0, 8);

  return (
    <aside className="dc-panel" aria-label="Inline comments" data-testid="comments-panel">
      <header className="dc-panel-head">
        <h2>Inline comments</h2>
        <button
          type="button"
          className="dc-icon"
          aria-label="Close comments"
          onClick={onClose}
          data-testid="comments-close"
        >
          <Icon name="close" size={16} strokeWidth={1.9} />
        </button>
      </header>
      <div className="dc-tabs" role="tablist">
        {(
          [
            ['all', 'All', c?.all],
            ['open', 'Open', c?.open],
            ['resolved', 'Resolved', c?.resolved],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`comments-tab-${id}`}
            className={tab === id ? 'is-on' : ''}
            onClick={() => onTab(id)}
          >
            {label} · {n ?? 0}
          </button>
        ))}
      </div>
      <div className="dc-list" data-testid="comments-list">
        {loading && (
          <div className="dc-state" data-testid="comments-loading">
            <span className="dc-spin" />
            Loading comments…
          </div>
        )}
        {error && !loading && (
          <div className="dc-state" data-testid="comments-error">
            <Icon name="i14" size={22} strokeWidth={1.7} />
            <b>Could not load comments</b>
            <span>The page is still readable. Check your connection and try again.</span>
            <button type="button" className="dc-plain dc-bordered" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {data && inline.length === 0 && (
          <div className="dc-state" data-testid="comments-empty">
            <Icon name="comment" size={22} strokeWidth={1.7} />
            <b>No inline comments yet</b>
            <span>Select any text on the page and choose Comment to start a discussion.</span>
          </div>
        )}
        {data && inline.length > 0 && shown.length === 0 && (
          <div className="dc-state" data-testid="comments-caught-up">
            <Icon name="i17" size={22} strokeWidth={1.7} />
            <b>All caught up</b>
            <span>No open comments. Resolved threads are in the Resolved tab.</span>
            <button type="button" className="dc-plain dc-bordered" onClick={() => onTab('resolved')}>
              Show resolved
            </button>
          </div>
        )}
        {data &&
          shown.map((t) => (
            <ThreadCard
              key={t.id}
              thread={t}
              projectId={projectId}
              data={data}
              actions={actions}
              active={activeId === t.id}
              version={version}
              reattaching={reattachId === t.id}
              onActivate={onActivate}
              onReattach={onReattach}
              suggestMembers={suggest}
            />
          ))}
        {data && (
          <div className="dc-activity">
            <button
              type="button"
              className="dc-fold"
              aria-expanded={showActivity}
              data-testid="comments-activity-toggle"
              onClick={() => setShowActivity((v) => !v)}
            >
              <Icon name={showActivity ? 'chevronDown' : 'chevronRight'} size={12} strokeWidth={2.2} /> Activity
            </button>
            {showActivity && (
              <ul data-testid="comments-activity">
                {pageEvents.length === 0 && <li>No comment activity yet.</li>}
                {pageEvents.map((e) => (
                  <li key={e.id}>
                    <b>{personOf(e.actor, data.members, data.me).name}</b> {EVENT_TEXT[e.kind] ?? e.kind} ·{' '}
                    {relativeTime(e.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
