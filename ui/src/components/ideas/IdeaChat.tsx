import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assistApi, assistError, useDraft } from '../../api/assist';
import { extractError } from '../../api/extractError';
import { ideaKeys } from '../../api/ideas';
import { useIdeaAiStatus } from '../../api/ideaAi';
import type { AssistDraft, DraftChange } from '../../types/assist';
import type { Idea } from '../../types/idea';
import { useAiBoardState } from '../ai/aiUi';
import { DraftTag } from '../assist/assistUi';
import { ScopedChat } from '../assist/ScopedChat';

/** The kinds of draft an idea chat can propose. Moving, merging, archiving and promoting are not among them. */
const IDEA_OPS = ['idea_assumption', 'idea_page_text'];

const IMPACT_LABEL = { low: 'Low impact', medium: 'Medium impact', high: 'High impact' } as const;

/**
 * The "Ask AI" button of the idea page header. Nothing is drawn while AI help is off for the project, like
 * "Shape with AI"; with no AI member or a reached cap the chat opens and says why it cannot answer.
 * @param props.projectId - The idea's project (null for an idea with no project).
 * @param props.active - The chat is open.
 * @param props.onClick - Open or close the chat.
 */
export function AskAiButton({
  projectId,
  active,
  onClick,
}: {
  projectId: string | null;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  const status = useIdeaAiStatus(projectId).data;
  if (!status || status.state === 'off') return null;
  return (
    <button
      type="button"
      className="is-btn"
      aria-pressed={active}
      title="Ask AI about this idea (Ctrl+J)"
      onClick={onClick}
      data-testid="ask-ai-button"
    >
      <span aria-hidden="true">💬</span> Ask AI
    </button>
  );
}

/**
 * Ctrl+J on the idea page opens and closes the Ask AI chat, as it does on a ticket. Inside an editor the key belongs
 * to that editor's /ai menu, so it is left alone there.
 * @param props.projectId - The idea's project (null for an idea with no project).
 * @param props.onToggle - Open or close the chat.
 */
export function AskAiShortcut({ projectId, onToggle }: { projectId: string | null; onToggle: () => void }): ReactNode {
  const on = (useIdeaAiStatus(projectId).data?.state ?? 'off') !== 'off';
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  useEffect(() => {
    if (!on) return undefined;
    // capture phase: this runs before the board-wide Ctrl+J
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'j') return;
      if ((e.target as Element | null)?.closest?.('[data-ai-editor]')) return;
      e.preventDefault();
      e.stopPropagation();
      toggle.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on]);
  return null;
}

/** One proposed change of an idea draft: an assumption or a paragraph for the page. */
function ChangeView({
  change,
  editing,
  text,
  onText,
}: {
  change: DraftChange;
  editing: boolean;
  text: string;
  onText: (value: string) => void;
}) {
  const assumption = change.op === 'idea_assumption';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>
        {assumption ? 'New assumption' : 'Paragraph for the end of the page'}
        {assumption && (
          <span className="ai-muted" style={{ fontWeight: 400 }}>
            {' '}
            · {IMPACT_LABEL[change.impact ?? 'medium']}
          </span>
        )}
      </div>
      {editing ? (
        <textarea
          className="ai-textarea"
          rows={assumption ? 2 : 4}
          value={text}
          onChange={(e) => onText(e.target.value)}
          aria-label={assumption ? 'Assumption' : 'Paragraph'}
        />
      ) : (
        <div className="as-diff">
          <div className="as-diff-add">
            <span>+</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The draft card of an idea chat: the assumptions and the paragraph it proposes, each with a checkbox. Nothing is
 * written until **Add** is pressed; **Undo** takes it back unless a person has edited the thing since. Only members
 * can add (a viewer is told so).
 * @param props.draft - The draft the chat produced.
 */
function IdeaDraftCard({ draft }: { draft: AssistDraft }) {
  const q = useDraft(draft.id);
  const qc = useQueryClient();
  const d = q.data ?? draft;
  const changes = useMemo(() => d.payload.changes ?? [], [d.payload.changes]);
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (picked === null && changes.length) setPicked(new Set(changes.map((_, i) => i)));
  }, [changes, picked]);

  const sel = picked ?? new Set<number>();
  const n = changes.filter((_, i) => sel.has(i)).length;
  const textOf = (i: number) => edits[i] ?? changes[i]?.text ?? '';

  const refresh = async () => {
    await q.refetch();
    await qc.invalidateQueries({ queryKey: ideaKeys.all });
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(edits).length) {
        await assistApi.edit(d.id, {
          changes: changes.map((c, i) => (edits[i] !== undefined ? { ...c, text: edits[i] } : c)),
        });
      }
      await assistApi.apply(d.id, { selected: [...sel] });
      setEditing(false);
      await refresh();
    } catch (e) {
      const body = assistError(e);
      setError(body?.code === 'viewer' ? 'Only members can add to an idea.' : extractError(e));
    } finally {
      setBusy(false);
    }
  };

  if (d.status === 'pending')
    return (
      <div className="as-draft" data-testid="draft-pending">
        <DraftTag>Drafting…</DraftTag>
        <div className="as-skel" style={{ height: 14, width: '80%' }} />
      </div>
    );
  if (d.status === 'failed')
    return <div className="ai-notice ai-notice-error">{d.result.error?.message ?? 'The draft did not come back.'}</div>;
  if (d.status === 'discarded' || d.status === 'expired')
    return <div className="ai-muted">Draft {d.status}. Nothing was changed.</div>;
  if (d.status === 'applied' || d.status === 'undone') {
    const count = d.result.count ?? 0;
    return (
      <div className="as-tile" style={{ flexDirection: 'row', alignItems: 'center' }} data-testid="draft-result">
        <span style={{ color: '#2E6F40', fontWeight: 700 }}>✓</span>
        <span style={{ flex: 1, fontSize: 13 }}>
          {d.status === 'undone' ? (
            <>
              Taken back
              {d.result.undo?.skipped.length ? ` · ${d.result.undo.skipped.length} left as people set them` : ''}
            </>
          ) : (
            <>
              <b>{`Added ${count} ${count === 1 ? 'thing' : 'things'} to the idea`}</b>
              {d.result.errors?.length ? (
                <span className="ai-muted"> · {d.result.errors.length} could not be added</span>
              ) : null}
            </>
          )}
        </span>
        {d.status === 'applied' && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await assistApi.undo(d.id);
                await refresh();
              } catch (e) {
                setError(extractError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Undo
          </button>
        )}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    );
  }

  return (
    <div className="as-draft" data-testid="idea-draft">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <DraftTag>
          Draft · {changes.length} {changes.length === 1 ? 'addition' : 'additions'}
        </DraftTag>
        <span style={{ flex: 1 }} />
        <span className="ai-muted" style={{ fontSize: 12 }}>
          Not added
        </span>
      </div>
      {changes.map((ch, i) => (
        <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            className="as-check"
            checked={sel.has(i)}
            aria-label={`Include addition ${i + 1}`}
            onChange={() => {
              const next = new Set(sel);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              setPicked(next);
            }}
          />
          <ChangeView change={ch} editing={editing} text={textOf(i)} onText={(v) => setEdits({ ...edits, [i]: v })} />
        </div>
      ))}
      {d.payload.problems?.length ? <div className="ai-muted">Left out: {d.payload.problems.join('; ')}.</div> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          disabled={!n || busy}
          onClick={() => void add()}
          data-testid="draft-apply"
        >
          {n === changes.length && n === 2 ? 'Add both' : n === 1 ? 'Add it' : `Add ${n}`}
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done' : 'Edit'}
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          data-testid="draft-dismiss"
          onClick={async () => {
            await assistApi.discard(d.id);
            await q.refetch();
          }}
        >
          Dismiss
        </button>
      </div>
      <div className="ai-muted" style={{ fontSize: 11.5 }}>
        Added as <b style={{ color: '#5B6B60' }}>you</b>; an added assumption keeps the AI mark until you edit it.
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

/** The card for a draft of an idea chat; null for any other kind, which the shared card shows. */
function renderIdeaDraft(draft: AssistDraft): ReactNode | null {
  const changes = draft.payload.changes ?? [];
  if (draft.kind !== 'changes' || !changes.length || !changes.every((c) => IDEA_OPS.includes(c.op))) return null;
  return <IdeaDraftCard draft={draft} />;
}

/**
 * "Ask AI" on the idea page (design/screens/ai-where-you-work.md, B, for ideas): the shared chat panel docked on the
 * right, scoped to the idea. It shows what it reads (the page, assumptions, evidence, comments, research log), keeps
 * the conversation private to the asker and picks it up again when the idea is reopened. It answers or drafts new
 * assumptions and a paragraph for the page; it never moves, merges, archives or promotes an idea.
 * @param props.idea - The idea the chat is about.
 * @param props.onClose - Close the dock.
 */
export function IdeaChat({ idea, onClose }: { idea: Idea; onClose: () => void }) {
  const { openAiPage, openAiTab } = useAiBoardState();
  const scope = useMemo(() => ({ kind: 'idea' as const, id: idea.id }), [idea.id]);
  return (
    <div className="is-chat-dock" data-testid="idea-chat">
      <ScopedChat
        scope={scope}
        title="Ask AI about this idea"
        onClose={onClose}
        onOpenAiMembers={() => openAiPage?.()}
        onOpenUsage={() => openAiTab?.('usage')}
        renderDraft={renderIdeaDraft}
      />
    </div>
  );
}
