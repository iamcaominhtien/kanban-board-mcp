import { useMemo } from 'react';
import type { useCommentActions } from '../../../api/docsComments';
import type { DocsCommentsResult } from '../../../types/docs';
import { Icon } from '../Icon';
import { CommentBox } from './CommentBox';
import { personOf } from './people';
import { ThreadCard } from './ThreadCard';
import { useCommentSuggest } from './commentAi';

/**
 * Comments at the bottom of a page that are not tied to any text, oldest first, with a composer.
 * @param props.projectId - Project used by the suggestion menu.
 * @param props.data - The page's comments result.
 * @param props.actions - Comment mutations.
 */
export function PageComments({
  projectId,
  data,
  actions,
}: {
  projectId: string;
  data: DocsCommentsResult | undefined;
  actions: ReturnType<typeof useCommentActions>;
}) {
  const threads = useMemo(() => (data?.threads ?? []).filter((t) => t.kind === 'page'), [data]);
  const suggest = useCommentSuggest(data);
  if (!data) return null;
  const me = personOf(data.me, data.members, data.me);
  return (
    <section className="dc-page-comments" data-testid="page-comments" aria-label="Page comments">
      <header>
        <Icon name="comment" size={16} strokeWidth={1.8} />
        <h2>Page comments</h2>
        <span className="dc-count-pill" data-testid="page-comments-count">
          {threads.length}
        </span>
        <span style={{ flex: 1 }} />
        <span className="dc-sort">Oldest first</span>
      </header>
      {threads.map((t) => (
        <ThreadCard
          key={t.id}
          thread={t}
          projectId={projectId}
          data={data}
          actions={actions}
          active={false}
          version={0}
          page
          reattaching={false}
          onActivate={() => undefined}
          onReattach={() => undefined}
          suggestMembers={suggest}
        />
      ))}
      {data.role === 'viewer' ? (
        <div className="dc-readonly" data-testid="page-read-only-note">
          <Icon name="lock" size={14} strokeWidth={1.8} />
          Viewers can read comments but cannot add them. Ask a project member for access.
        </div>
      ) : (
        <div className="dc-reply" style={{ marginTop: 10 }}>
          <span
            className="dc-avatar"
            style={{ width: 28, height: 28, background: me.bg, color: me.color, fontSize: 11 }}
          >
            {me.initials}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <CommentBox
              projectId={projectId}
              members={suggest}
              compact
              placeholder="Write a comment on this page…"
              testId="page-comment-input"
              onSubmit={async (text) => {
                await actions.createThread.mutateAsync({ kind: 'page', body: text });
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
