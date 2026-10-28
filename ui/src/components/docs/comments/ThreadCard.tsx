import { useEffect, useRef, useState } from 'react';
import type { DocsCommentItem, DocsCommentsResult, DocsCommentThread } from '../../../types/docs';
import { relativeTime, absoluteTime } from '../../../utils/relativeTime';
import { Icon } from '../Icon';
import { CommentBox } from './CommentBox';
import { CommentText } from './CommentText';
import { personOf, threadLink, type CommentPerson } from './people';
import type { useCommentActions } from '../../../api/docsComments';

type Actions = ReturnType<typeof useCommentActions>;

interface Props {
  thread: DocsCommentThread;
  projectId: string;
  data: DocsCommentsResult;
  actions: Actions;
  active: boolean;
  /** Published version, shown on orphaned threads. */
  version: number;
  /** Page comments have no highlight, number or resolve button. */
  page?: boolean;
  reattaching: boolean;
  onActivate: (id: string) => void;
  onReattach: (id: string | null) => void;
  /** Look up an author's avatar. */
  suggestMembers: { id: string; name: string; bg: string; color: string }[];
}

const FOLD_AFTER = 4;

function Avatar({ p, size = 28 }: { p: CommentPerson; size?: number }) {
  return (
    <span
      className="dc-avatar"
      title={p.name}
      style={{ width: size, height: size, background: p.bg, color: p.color, fontSize: size < 26 ? 10 : 11 }}
    >
      {p.initials}
    </span>
  );
}

/**
 * One thread card: header (number or state), quoted text, comments, reply box and the states from the design
 * (menu, editing, delete confirmation, resolved, orphaned, long thread, read-only).
 * @param props.thread - Thread to show.
 * @param props.projectId - Project used by the suggestion menu.
 * @param props.data - The page's comments result (members, your role).
 * @param props.actions - Comment mutations.
 * @param props.active - Emphasise the card (its highlight is selected).
 * @param props.version - Published version, shown on orphaned threads.
 * @param props.page - Show as a page comment (no highlight, number or resolve).
 * @param props.reattaching - Waiting for a new selection to attach this thread to.
 * @param props.onActivate - Called with the thread id when the card is clicked.
 * @param props.onReattach - Start (id) or cancel (null) re-attaching to a new selection.
 * @param props.suggestMembers - Members offered after `@`.
 */
export function ThreadCard({
  thread,
  projectId,
  data,
  actions,
  active,
  version,
  page,
  reattaching,
  onActivate,
  onReattach,
  suggestMembers,
}: Props) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const folded = !expanded && thread.comments.length > FOLD_AFTER;
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const { me, members } = data;
  const orphaned = thread.anchor?.state === 'orphaned';
  const resolved = thread.status === 'resolved';

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-cmenu]')) setMenuFor(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuFor]);

  const run = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: { message?: string } } } }).response?.data?.detail;
      setError(detail?.message ?? 'Something went wrong. Try again.');
    }
  };

  function renderComment(c: DocsCommentItem, first: boolean) {
    const p = personOf(c.author, members, me);
    if (editing === c.id) {
      return (
        <div key={c.id} className="dc-comment" data-testid="comment-editing">
          <Avatar p={p} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dc-meta">
              <b>{p.name}</b>
              <span>{relativeTime(c.createdAt)}</span>
            </div>
            <CommentBox
              projectId={projectId}
              members={suggestMembers}
              initial={c.body}
              submitLabel="Save"
              autoFocus
              testId="comment-edit-input"
              onCancel={() => setEditing(null)}
              onSubmit={async (text) => {
                await actions.edit.mutateAsync({ commentId: c.id, body: text });
                setEditing(null);
              }}
            />
          </div>
        </div>
      );
    }
    return (
      <div key={c.id} className="dc-comment" data-testid="comment-item">
        <Avatar p={p} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="dc-meta">
            <b>{p.name}</b>
            <span title={absoluteTime(c.createdAt)}>{relativeTime(c.createdAt)}</span>
            {c.editedAt && (
              <span className="dc-edited" title={absoluteTime(c.editedAt)} data-testid="comment-edited">
                edited
              </span>
            )}
            <span style={{ flex: 1 }} />
            {
              <span className="dc-actions" data-cmenu>
                {thread.canReply && first && !resolved && (
                  <button
                    type="button"
                    className="dc-icon"
                    aria-label="Reply"
                    title="Reply"
                    onClick={() => {
                      onActivate(thread.id);
                      const f = document.getElementById(`dc-reply-${thread.id}`)?.querySelector('input,textarea');
                      (f as HTMLElement | null)?.focus();
                    }}
                  >
                    <Icon name="reply" size={14} strokeWidth={1.8} />
                  </button>
                )}
                <button
                  type="button"
                  className="dc-icon"
                  aria-label="Comment actions"
                  aria-expanded={menuFor === c.id}
                  data-testid="comment-menu"
                  onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                >
                  <Icon name="more" size={15} strokeWidth={1.8} />
                </button>
                {menuFor === c.id && (
                  <div className="dc-menu" role="menu">
                    {c.canEdit && (
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="comment-edit"
                        onClick={() => {
                          setMenuFor(null);
                          setEditing(c.id);
                        }}
                      >
                        <Icon name="i15" size={14} strokeWidth={1.8} /> Edit
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="comment-copy-link"
                      onClick={() => {
                        setMenuFor(null);
                        void navigator.clipboard?.writeText(threadLink(thread.id));
                      }}
                    >
                      <Icon name="link" size={14} strokeWidth={1.8} /> Copy link
                    </button>
                    {c.canDelete && (
                      <>
                        <hr />
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          data-testid="comment-delete"
                          onClick={() => {
                            setMenuFor(null);
                            setDeleting(c.id);
                          }}
                        >
                          <Icon name="i12" size={14} strokeWidth={1.8} /> Delete
                        </button>
                      </>
                    )}
                  </div>
                )}
              </span>
            }
          </div>
          <CommentText text={c.body} mentions={c.mentions} />
          {deleting === c.id && renderDelete(c, first)}
        </div>
      </div>
    );
  }

  function renderDelete(c: DocsCommentItem, first: boolean) {
    const wholeThread = first;
    const replies = thread.comments.length - 1;
    return (
      <div className="dc-confirm" role="alertdialog" aria-label="Delete this comment?" data-testid="delete-confirm">
        <b>Delete this comment?</b>
        <p>
          {wholeThread
            ? replies > 0
              ? `It has ${replies} ${replies === 1 ? 'reply' : 'replies'}. Deleting the first comment removes the whole thread${page ? '' : ' and its highlight'}. Replies stay if you delete a reply only.`
              : `This removes the thread${page ? '' : ' and its highlight'}.`
            : 'Only this reply is removed.'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="dc-plain dc-bordered" onClick={() => setDeleting(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="dc-danger"
            data-testid="delete-confirm-yes"
            onClick={() => {
              setDeleting(null);
              void run(actions.remove.mutateAsync(c.id));
            }}
          >
            <Icon name="i12" size={13} strokeWidth={2} /> {wholeThread ? 'Delete thread' : 'Delete reply'}
          </button>
        </div>
      </div>
    );
  }

  const list = thread.comments;
  const hidden = folded ? list.length - 1 : 0;

  return (
    <section
      ref={ref}
      id={`comment-${thread.id}`}
      className={`dc-card${active ? ' is-active' : ''}${resolved ? ' is-resolved' : ''}${orphaned ? ' is-orphaned' : ''}`}
      data-testid="thread-card"
      data-thread={thread.id}
      data-state={orphaned ? 'orphaned' : thread.status}
      onClick={() => onActivate(thread.id)}
    >
      {!page && (
        <header className="dc-card-head">
          {orphaned && !resolved ? (
            <span className="dc-chip dc-chip-red">Text removed</span>
          ) : resolved ? (
            <span className="dc-chip dc-chip-green">
              <Icon name="check" size={12} strokeWidth={2.4} /> Resolved
            </span>
          ) : (
            <span className="dc-num" data-testid="thread-number">
              {thread.number ?? '·'}
            </span>
          )}
          {thread.unread && <span className="dc-unread" data-testid="unread-dot" title="Unread" />}
          <span style={{ flex: 1 }} />
          {resolved && thread.canResolve && (
            <button
              type="button"
              className="dc-plain dc-bordered"
              data-testid="thread-reopen"
              onClick={(e) => {
                e.stopPropagation();
                void run(actions.setStatus.mutateAsync({ threadId: thread.id, status: 'open' }));
              }}
            >
              <Icon name="reopen" size={13} strokeWidth={1.9} /> Reopen
            </button>
          )}
          {!resolved && !orphaned && thread.canResolve && (
            <button
              type="button"
              className="dc-resolve"
              aria-label="Resolve thread"
              title="Resolve"
              data-testid="thread-resolve"
              onClick={(e) => {
                e.stopPropagation();
                void run(actions.setStatus.mutateAsync({ threadId: thread.id, status: 'resolved' }));
              }}
            >
              <Icon name="check" size={14} strokeWidth={2} />
            </button>
          )}
        </header>
      )}
      {!page && thread.anchor?.quote && (
        <div className="dc-quote" data-testid="thread-quote">
          <Icon name="comment" size={13} strokeWidth={1.8} />
          <span>“{thread.anchor.quote}”</span>
        </div>
      )}
      {hidden > 0 && (
        <button
          type="button"
          className="dc-fold"
          data-testid="thread-unfold"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          <Icon name="chevronDown" size={12} strokeWidth={2.2} /> Show {hidden} earlier{' '}
          {hidden === 1 ? 'reply' : 'replies'}
        </button>
      )}
      {(folded ? list.slice(-1) : list).map((c) => renderComment(c, c.id === list[0].id))}
      {orphaned && !resolved && (
        <div className="dc-orphan" data-testid="orphan-notice">
          <p>
            The text this comment was attached to was edited or deleted
            {version > 0 ? (
              <>
                {' '}
                in <b>v{version}</b>
              </>
            ) : null}
            . The thread is kept here, not in the page.
          </p>
          {reattaching ? (
            <div className="dc-reattach" data-testid="reattach-hint">
              Select the new text on the page…
              <button type="button" className="dc-plain" onClick={() => onReattach(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              {thread.canResolve && (
                <button
                  type="button"
                  className="dc-plain dc-bordered"
                  data-testid="thread-reattach"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReattach(thread.id);
                  }}
                >
                  <Icon name="link" size={13} strokeWidth={1.9} /> Re-attach to selection
                </button>
              )}
              {thread.canResolve && (
                <button
                  type="button"
                  className="dc-plain dc-bordered"
                  data-testid="thread-resolve"
                  onClick={(e) => {
                    e.stopPropagation();
                    void run(actions.setStatus.mutateAsync({ threadId: thread.id, status: 'resolved' }));
                  }}
                >
                  Resolve
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {resolved && thread.resolvedBy && (
        <div className="dc-resolved-by" data-testid="resolved-by">
          <Icon name="i17" size={14} strokeWidth={1.8} /> Resolved by{' '}
          <b>{personOf(thread.resolvedBy, members, me).name}</b>
          {thread.resolvedAt && <> · {relativeTime(thread.resolvedAt)}</>}
        </div>
      )}
      {error && (
        <div className="dc-failed" role="alert" data-testid="thread-error">
          {error}
        </div>
      )}
      {!resolved && (
        <div id={`dc-reply-${thread.id}`} className="dc-reply" onClick={(e) => e.stopPropagation()}>
          {thread.canReply ? (
            <>
              <Avatar p={personOf(me, members, me)} size={26} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <CommentBox
                  projectId={projectId}
                  members={suggestMembers}
                  compact
                  placeholder="Reply…"
                  submitLabel="Reply"
                  testId="reply-input"
                  onSubmit={async (text) => {
                    await actions.reply.mutateAsync({ threadId: thread.id, body: text });
                  }}
                />
              </div>
            </>
          ) : (
            <div className="dc-readonly" data-testid="read-only-note">
              <Icon name="lock" size={14} strokeWidth={1.8} />
              Viewers can read comments but cannot add them. Ask a project member for access.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
