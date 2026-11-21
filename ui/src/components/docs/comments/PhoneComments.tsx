/**
 * Comments on a phone (design "History and comments on rich pages", D 26–27): a half-height sheet that lists the
 * threads in page order (number, what it is on, the latest reply), All / Open / Resolved; a row opens the thread full
 * screen, with its replies and the reply box at the bottom.
 */

import { useEffect, useMemo, useState } from 'react';
import { spoken } from './boardLines';
import type { useCommentActions } from '../../../api/docsComments';
import type { DocsCommentsResult, RichDoc } from '../../../types/docs';
import { BottomSheet } from '../DocsSheets';
import { Icon } from '../Icon';
import type { CommentTab } from './CommentsPanel';
import { ThreadCard } from './ThreadCard';
import { orderThreads, threadPlace } from './blockAnchor';
import { useCommentSuggest } from './commentAi';
import { personOf } from './people';
import './blocks.css';

/** Props of {@link PhoneComments}. */
export interface PhoneCommentsProps {
  projectId: string;
  version: number;
  data: DocsCommentsResult | undefined;
  loading: boolean;
  actions: ReturnType<typeof useCommentActions>;
  tab: CommentTab;
  onTab: (t: CommentTab) => void;
  /** The thread a mark opened: shown full screen at once. */
  activeId: string | null;
  onActivate: (id: string) => void;
  reattachId: string | null;
  onReattach: (id: string | null) => void;
  onClose: () => void;
  /** The published rich page (page order, thread states). */
  doc?: RichDoc | null;
}

/**
 * The phone's comments sheet and full-screen thread.
 * @param props - See {@link PhoneCommentsProps}.
 */
export function PhoneComments({
  projectId,
  version,
  data,
  loading,
  actions,
  tab,
  onTab,
  activeId,
  onActivate,
  reattachId,
  onReattach,
  onClose,
  doc,
}: PhoneCommentsProps) {
  const [threadId, setThreadId] = useState<string | null>(activeId);
  useEffect(() => {
    if (activeId) setThreadId(activeId);
  }, [activeId]);
  const suggest = useCommentSuggest(data);
  const inline = useMemo(
    () =>
      orderThreads(
        (data?.threads ?? []).filter((t) => t.kind === 'inline'),
        doc,
      ),
    [data, doc],
  );
  const shown = inline.filter((t) => tab === 'all' || t.status === tab);
  const thread = threadId ? inline.find((t) => t.id === threadId) : undefined;
  const c = data?.counts;

  if (thread && data) {
    const at = shown.findIndex((t) => t.id === thread.id);
    return (
      <div
        className="docs-root dc-pthread"
        role="dialog"
        aria-modal="true"
        aria-label="Comment"
        data-testid="phone-thread"
      >
        <header className="dc-pthread-head">
          <button
            type="button"
            className="dk-icobtn"
            aria-label="Back to the comments"
            onClick={() => setThreadId(null)}
          >
            <Icon name="i60" size={18} strokeWidth={2} />
          </button>
          <span style={{ flex: 1 }}>{at >= 0 ? `Comment ${at + 1} of ${shown.length}` : 'Comment'}</span>
          <button type="button" className="dk-icobtn" aria-label="Close comments" onClick={onClose}>
            <Icon name="close" size={18} strokeWidth={2} />
          </button>
        </header>
        <div className="dc-pthread-body">
          <ThreadCard
            thread={thread}
            projectId={projectId}
            data={data}
            actions={actions}
            active
            version={version}
            reattaching={reattachId === thread.id}
            onActivate={onActivate}
            onReattach={onReattach}
            suggestMembers={suggest}
            place={doc ? threadPlace(thread, doc) : undefined}
            dockedReply
          />
        </div>
      </div>
    );
  }

  return (
    <BottomSheet label="Comments" onClose={onClose} testId="phone-comments" closeText="Close">
      <div className="dc-psheet-tabs" role="tablist">
        {(
          [
            ['all', 'All', c?.all],
            ['open', 'Open', c?.open],
            ['resolved', 'Resolved', c?.resolved],
          ] as const
        ).map(([id, label, n]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>
            {label} {n ?? 0}
          </button>
        ))}
      </div>
      <div style={{ maxHeight: '45vh', overflowY: 'auto' }}>
        {loading && <p className="dc-prow-last">Loading comments…</p>}
        {data && shown.length === 0 && <p className="dc-prow-last">No comments here.</p>}
        {data &&
          shown.map((t) => {
            const place = doc ? threadPlace(t, doc) : undefined;
            const last = spoken(t.comments).slice(-1)[0] ?? t.comments[t.comments.length - 1];
            return (
              <button
                key={t.id}
                type="button"
                className="dc-prow"
                data-testid="phone-thread-row"
                onClick={() => {
                  setThreadId(t.id);
                  onActivate(t.id);
                }}
              >
                <span className="dc-num">{t.number ?? '·'}</span>
                <span className="dc-prow-main">
                  <span className="dc-prow-quote">{place?.label ?? `“${t.anchor?.quote ?? ''}”`}</span>
                  {last && (
                    <span className="dc-prow-last">
                      {personOf(last.author, data.members, data.me).name}: {last.body}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
      </div>
    </BottomSheet>
  );
}
