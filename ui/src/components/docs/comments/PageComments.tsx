import { useMemo, useState } from 'react';
import type { useCommentActions } from '../../../api/docsComments';
import type { DocsCommentsResult } from '../../../types/docs';
import { Icon } from '../Icon';
import { CommentBox } from './CommentBox';
import { personOf } from './people';
import { ThreadCard } from './ThreadCard';
import { useCommentSuggest } from './commentAi';
import { SendToAiBox } from './SendToAi';

/**
 * Comments at the bottom of a page that are not tied to any text, oldest first, with a composer.
 * @param props.pageId - The page (Send to AI).
 * @param props.projectId - Project used by the suggestion menu.
 * @param props.data - The page's comments result.
 * @param props.actions - Comment mutations.
 */
export function PageComments({
  pageId,
  projectId,
  data,
  actions,
}: {
  pageId: string;
  projectId: string;
  data: DocsCommentsResult | undefined;
  actions: ReturnType<typeof useCommentActions>;
}) {
  const threads = useMemo(() => (data?.threads ?? []).filter((t) => t.kind === 'page'), [data]);
  const suggest = useCommentSuggest(data);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  if (!data) return null;
  const open = data.threads.filter((t) => t.status === 'open');
  const canSend = !!data.docsAi && data.role !== 'viewer' && threads.length > 0;
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
        {canSend && (
          <button
            type="button"
            className="dc-plain dc-bordered dc-sendai-open"
            onClick={() => {
              setSent(null);
              setSending((v) => !v);
            }}
            aria-expanded={sending}
            title="Send comments to an AI on a ticket this page names"
            data-testid="page-send-to-ai-open"
          >
            <Icon name="send" size={13} strokeWidth={1.9} /> Send to AI
          </button>
        )}
        <span className="dc-sort">Oldest first</span>
      </header>
      {sending && (
        <SendToAiBox
          pageId={pageId}
          threads={open}
          onClose={() => setSending(false)}
          onSent={(m) => {
            setSending(false);
            setSent(m);
          }}
        />
      )}
      {sent && (
        <div className="dc-sendai-done" role="status">
          <Icon name="check" size={13} strokeWidth={2} /> {sent}
        </div>
      )}
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
