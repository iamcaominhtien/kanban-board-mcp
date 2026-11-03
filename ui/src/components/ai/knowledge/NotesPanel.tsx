import { useState } from 'react';
import { useDeleteNote, usePatchNote } from '../../../api/aiKnowledge';
import { extractError } from '../../../api/extractError';
import type { Knowledge, MemoryFlag, MemoryNote, NoteScope } from '../../../types/aiKnowledge';
import { shortDate } from '../aiUi';

const SCOPE_TITLE: Record<NoteScope, string> = {
  role: 'Role notes',
  member: 'A member’s own notes',
  ticket: 'Ticket notes',
};

const SCOPE_HINT: Record<NoteScope, string> = {
  role: 'Every member of the role reads them at the start of a run.',
  member: 'A member with no role reads its own.',
  ticket: 'Every later run on the ticket reads them.',
};

/** The flags of one lesson or note: what a person should look at again. */
export function Flags({ flags }: { flags: MemoryFlag[] }) {
  if (!flags.length) return null;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {flags.map((f, i) => (
        <div
          key={i}
          data-testid="memory-flag"
          data-kind={f.kind}
          style={{ fontSize: 12, color: '#8a5a00', background: '#fff6e0', borderRadius: 6, padding: '3px 8px' }}
        >
          {f.kind === 'missing_path' ? 'Out of date? ' : 'Overlaps: '}
          {f.text}
        </div>
      ))}
    </div>
  );
}

function NoteRow({
  note,
  flags,
  busy,
  onSave,
  onDelete,
}: {
  note: MemoryNote;
  flags: MemoryFlag[];
  busy: boolean;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  return (
    <div data-testid="memory-note" style={{ display: 'grid', gap: 4, borderTop: '1px solid #eef3ef', paddingTop: 8 }}>
      {editing ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <textarea
            className="ai-textarea"
            aria-label="Note"
            data-testid="note-editor"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="ai-btn ai-btn-primary ai-btn-sm"
              disabled={busy || !text.trim() || text.trim() === note.text}
              onClick={() => void onSave(text.trim()).then((ok) => ok && setEditing(false))}
            >
              Save
            </button>
            <button className="ai-btn ai-btn-sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13 }}>
          {note.kind === 'feedback' && (
            <span
              data-testid="note-feedback"
              style={{
                background: '#EEF0FF',
                color: '#3B3F9E',
                marginRight: 6,
                borderRadius: 999,
                padding: '1px 7px',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              a person said
            </span>
          )}
          {note.text}
        </div>
      )}
      <Flags flags={flags} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="ai-hint" style={{ flex: 1 }}>
          Written by {note.writtenBy ?? 'an AI'}
          {note.sourceTicketId && note.scope !== 'ticket' ? ` on ${note.sourceTicketId}` : ''} &middot;{' '}
          {shortDate(note.updatedAt)}
          {note.uses > 0 ? ` · read in ${note.uses} run${note.uses === 1 ? '' : 's'}` : ' · not read yet'}
        </span>
        {!editing && (
          <>
            <button
              className="ai-btn ai-btn-sm"
              disabled={busy}
              onClick={() => {
                setText(note.text);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button
              className="ai-btn ai-btn-danger-outline ai-btn-sm"
              data-testid="note-delete"
              disabled={busy}
              onClick={onDelete}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The notes the AIs keep themselves (issue #274), grouped by whose memory they are in. */
export function NotesPanel({ projectId, data }: { projectId: string; data: Knowledge }) {
  const patch = usePatchNote(projectId);
  const del = useDeleteNote(projectId);
  const [error, setError] = useState<string | null>(null);
  const busy = patch.isPending || del.isPending;
  const groups = new Map<string, MemoryNote[]>();
  for (const n of data.notes) {
    const key = `${n.scope}:${n.scopeKey}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const order: NoteScope[] = ['role', 'member', 'ticket'];
  const sorted = [...groups.entries()].sort(
    ([a], [b]) => order.indexOf(a.split(':')[0] as NoteScope) - order.indexOf(b.split(':')[0] as NoteScope),
  );
  const flagsOf = (id: string) => data.flags.filter((f) => f.id === id);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(extractError(e));
      return false;
    }
  };

  return (
    <div className="ai-card" data-testid="notes-panel" style={{ padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b style={{ fontSize: 13.5, flex: 1 }}>Notes the AIs keep themselves</b>
        <span className="ai-tab-count" data-testid="notes-count">
          {data.notes.length}
        </span>
      </div>
      <div className="ai-hint">
        An AI writes these without being asked, when it learns something the next run would pay for again or when you
        correct it. They are live at once: edit or delete any that is wrong.
      </div>
      {sorted.length === 0 && (
        <div className="ai-hint" data-testid="notes-empty">
          No notes yet. They appear as the AIs work.
        </div>
      )}
      {sorted.map(([key, rows]) => {
        const scope = rows[0].scope;
        const cap = data.noteCaps[scope];
        return (
          <div key={key} data-testid="notes-group" style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
              <b style={{ fontSize: 12.5 }}>
                {SCOPE_TITLE[scope]} · {rows[0].scopeLabel ?? rows[0].scopeKey}
              </b>
              <span className="ai-hint" style={{ flex: 1 }}>
                {SCOPE_HINT[scope]}
              </span>
              <span className="ai-hint" style={rows.length >= cap ? { color: '#c4432a', fontWeight: 600 } : undefined}>
                {rows.length} of {cap}
              </span>
            </div>
            {rows.map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                flags={flagsOf(n.id)}
                busy={busy}
                onSave={(text) => run(() => patch.mutateAsync({ id: n.id, text }))}
                onDelete={() => void run(() => del.mutateAsync(n.id))}
              />
            ))}
          </div>
        );
      })}
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
