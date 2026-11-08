import { useState } from 'react';
import { useAddLesson, useDeleteLesson, usePatchLesson } from '../../../api/aiKnowledge';
import { extractError } from '../../../api/extractError';
import type { Knowledge, Lesson } from '../../../types/aiKnowledge';
import { shortDate } from '../aiUi';
import { LessonsSettings } from './LessonsSettings';
import { Flags, NotesPanel } from './NotesPanel';

function Source({ lesson }: { lesson: Lesson }) {
  return lesson.sourceTicketId ? (
    <span className="id-chip" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {lesson.sourceTicketId}
    </span>
  ) : null;
}

/** Where a proposal came from, in the words of the design. */
export function proposedByLine(by: string | null): string {
  // v2: a lesson comes from the lead's final report; the two v1 sources (a light model, a diagnosis) are gone
  if (!by || by === 'model' || by === 'diagnosis') return 'Proposed while the team worked.';
  return `Proposed by ${by} while it worked.`;
}

function LessonEditor({
  initial,
  keep,
  busy,
  onSave,
  onCancel,
}: {
  initial: string;
  keep: boolean;
  busy: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <textarea
        className="ai-textarea"
        aria-label="Lesson"
        data-testid="lesson-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="ai-btn ai-btn-primary ai-btn-sm"
          data-testid="lesson-editor-save"
          disabled={busy || !text.trim() || (!keep && text.trim() === initial.trim())}
          onClick={() => onSave(text.trim())}
        >
          {keep ? 'Edit and keep' : 'Save'}
        </button>
        <button className="ai-btn ai-btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The memory: proposals waiting for a person, the kept lessons, and a way to add one. */
export function MemoryPanel({ projectId, data }: { projectId: string; data: Knowledge }) {
  const add = useAddLesson(projectId);
  const patch = usePatchLesson(projectId);
  const del = useDeleteLesson(projectId);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const busy = add.isPending || patch.isPending || del.isPending;
  const proposed = data.lessons.filter((l) => l.state === 'proposed');
  const kept = data.lessons.filter((l) => l.state === 'kept');
  const over = data.lessonsTokens > data.lessonCap;

  const run = async (fn: () => Promise<unknown>, done?: () => void) => {
    setError(null);
    try {
      await fn();
      done?.();
    } catch (e) {
      setError(extractError(e));
    }
  };
  const setState = (l: Lesson, state: 'kept' | 'dropped', text?: string) =>
    run(
      () => patch.mutateAsync({ id: l.id, body: text !== undefined ? { text, state } : { state } }),
      () => setEditing(null),
    );

  return (
    <div data-testid="memory-panel" style={{ display: 'grid', gap: 10 }}>
      <LessonsSettings projectId={projectId} />
      {proposed.length > 0 && (
        <div data-testid="proposals-waiting" style={{ fontSize: 13, fontWeight: 700, color: '#8a5a00' }}>
          {proposed.length} lesson{proposed.length === 1 ? '' : 's'} waiting for you
        </div>
      )}
      {proposed.map((l) => (
        <div
          key={l.id}
          className="ai-card"
          data-testid="lesson-proposal"
          style={{ padding: 12, display: 'grid', gap: 8, borderColor: '#e8b93a', background: '#fffaf0' }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>A lesson is proposed</div>
          {editing === l.id ? (
            <LessonEditor
              initial={l.text}
              keep
              busy={busy}
              onSave={(t) => void setState(l, 'kept', t)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div style={{ fontSize: 13 }}>&ldquo;{l.text}&rdquo;</div>
          )}
          <div className="ai-hint">
            {l.sourceTicketId && (
              <>
                From the run that finished <Source lesson={l} />
                {l.createdAt
                  ? ` at ${new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
                  : ''}
                .{' '}
              </>
            )}
            {proposedByLine(l.proposedBy)} It is not in any prompt until you keep it.
          </div>
          {editing !== l.id && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="ai-btn ai-btn-primary ai-btn-sm"
                data-testid="proposal-keep"
                disabled={busy}
                onClick={() => void setState(l, 'kept')}
              >
                Keep it
              </button>
              <button
                className="ai-btn ai-btn-sm"
                data-testid="proposal-edit"
                disabled={busy}
                onClick={() => setEditing(l.id)}
              >
                Edit and keep
              </button>
              <button
                className="ai-btn ai-btn-sm"
                data-testid="proposal-no"
                disabled={busy}
                onClick={() => void setState(l, 'dropped')}
              >
                No
              </button>
            </div>
          )}
        </div>
      ))}

      <div className="ai-card" style={{ padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <b style={{ fontSize: 13.5, flex: 1 }}>Memory &mdash; what the AIs learned</b>
          <span className="ai-tab-count" data-testid="lessons-tokens">
            {data.lessonsTokens.toLocaleString('en-US')} tokens
          </span>
          <button
            className="ai-btn ai-btn-sm"
            data-testid="lesson-add"
            disabled={adding}
            onClick={() => setAdding(true)}
          >
            Add a lesson
          </button>
        </div>
        {adding && (
          <LessonEditor
            initial=""
            keep={false}
            busy={busy}
            onSave={(t) =>
              void run(
                () => add.mutateAsync(t),
                () => setAdding(false),
              )
            }
            onCancel={() => setAdding(false)}
          />
        )}
        {kept.length === 0 && !adding && (
          <div className="ai-hint" data-testid="lessons-empty">
            No lessons yet. An AI proposes one while it works or when a ticket ends; you can also write your own.
          </div>
        )}
        {kept.map((l) => (
          <div
            key={l.id}
            data-testid="lesson"
            style={{ display: 'grid', gap: 4, borderTop: '1px solid #eef3ef', paddingTop: 8 }}
          >
            {editing === l.id ? (
              <LessonEditor
                initial={l.text}
                keep={false}
                busy={busy}
                onSave={(t) =>
                  void run(
                    () => patch.mutateAsync({ id: l.id, body: { text: t } }),
                    () => setEditing(null),
                  )
                }
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div style={{ fontSize: 13 }}>{l.text}</div>
            )}
            <Flags flags={data.flags.filter((f) => f.id === l.id)} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="ai-hint" style={{ flex: 1 }}>
                {l.sourceTicketId ? (
                  <>
                    Written after <Source lesson={l} />
                  </>
                ) : (
                  `Written by ${l.keptBy ?? l.proposedBy ?? 'a person'}`
                )}{' '}
                &middot; {shortDate(l.createdAt)}
                {l.uses > 0 && ` · used in ${l.uses} run${l.uses === 1 ? '' : 's'} since`}
                {data.unused.includes(l.id) && (
                  <b data-testid="lesson-unused" style={{ color: '#b4791e' }}>
                    {' '}
                    · never used
                  </b>
                )}
              </span>
              {editing !== l.id && (
                <>
                  <button className="ai-btn ai-btn-sm" disabled={busy} onClick={() => setEditing(l.id)}>
                    Edit
                  </button>
                  <button
                    className="ai-btn ai-btn-danger-outline ai-btn-sm"
                    data-testid="lesson-delete"
                    disabled={busy}
                    onClick={() => void run(() => del.mutateAsync(l.id))}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {error && (
          <div className="ai-error-text" role="alert">
            {error}
          </div>
        )}
        <div
          className="ai-hint"
          style={over ? { color: '#c4432a', fontWeight: 600 } : undefined}
          data-testid="lesson-cap"
        >
          Lessons are capped at {data.lessonCap.toLocaleString('en-US')} tokens.
          {over
            ? ` You are over it by ${(data.lessonsTokens - data.lessonCap).toLocaleString('en-US')}: drop the ones nothing has used${
                data.unused.length ? ` (${data.unused.length} marked above)` : ''
              }.`
            : ' Past that the board asks you to drop the ones nothing has used, and tells you which they are.'}
        </div>
      </div>
      <NotesPanel projectId={projectId} data={data} />
    </div>
  );
}
