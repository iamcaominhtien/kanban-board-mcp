import { useRef, useState } from 'react';
import { SKETCH_LINE } from '../sketch/sketchRefs';
import { useSketchStarter } from '../sketch/useSketchStarter';
import { SketchEmbed } from '../sketch/SketchEmbed';
import { extractError } from '../../api/extractError';
import { useAddEvidence, useDeleteEvidence, useIdeaEvidence } from '../../api/ideas';
import { uploadAnyFile } from '../../api/tickets';
import type { EvidenceKind, Idea } from '../../types/idea';
import { relativeTime } from '../../utils/relativeTime';

type FormKind = Exclude<EvidenceKind, 'comment'>;
const KIND_LABEL: Record<FormKind, string> = {
  link: 'Link',
  note: 'Note',
  ticket: 'Ticket',
  file: 'File',
  sketch: 'Sketch',
  diagram: 'Diagram',
};

interface FormProps {
  /** The idea the evidence is for; with it, "Draw a sketch" is offered. */
  ideaId?: string;
  projectId?: string;
  ideaTitle?: string;
  assumptions: { id: string; text: string }[];
  onAdd: (v: { assumptionIds: string[]; kind: EvidenceKind; ref: string; title?: string }) => Promise<void>;
}

/**
 * "Add comment, file, link or sketch" for one or more assumptions: one piece of evidence can support many.
 * @param props.assumptions - The assumptions it can be attached to; with several, they are shown as checkboxes.
 */
export function EvidenceForm({ assumptions, onAdd, ideaId, projectId, ideaTitle }: FormProps) {
  const [kind, setKind] = useState<FormKind>('link');
  const [ref, setRef] = useState('');
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<string[]>(assumptions.length === 1 ? [assumptions[0].id] : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(value: string, name?: string) {
    setError(null);
    setBusy(true);
    try {
      await onAdd({ assumptionIds: chosen, kind, ref: value.trim(), title: (name ?? title).trim() });
      setRef('');
      setTitle('');
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    try {
      setBusy(true);
      const up = await uploadAnyFile(file);
      await submit(up.url ?? up.markdown, file.name);
    } catch (e) {
      setError(extractError(e));
      setBusy(false);
    }
  }

  const sketch = useSketchStarter({
    ownerKind: 'idea',
    ownerId: ideaId,
    projectId,
    ownerLabel: ideaTitle,
    onInsert: (md) => {
      const parts = SKETCH_LINE.exec(md);
      if (parts && chosen.length) void submit(md, parts[1]);
    },
  });
  const needsText = kind !== 'file';
  return (
    <div className="is-evidence-form" data-testid="evidence-form">
      {assumptions.length > 1 && (
        <div className="is-field">
          <span className="is-label">Supports</span>
          {assumptions.map((a) => (
            <label key={a.id} className="is-check">
              <input
                type="checkbox"
                checked={chosen.includes(a.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))}
              />
              {a.text}
            </label>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <select
          className="is-select"
          value={kind}
          aria-label="Kind of evidence"
          onChange={(e) => setKind(e.target.value as FormKind)}
        >
          {(Object.keys(KIND_LABEL) as FormKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {needsText ? (
          <>
            <input
              className="is-input"
              style={{ flex: 1, minWidth: 180 }}
              value={ref}
              aria-label="Evidence"
              placeholder={
                kind === 'link'
                  ? 'https://…'
                  : kind === 'ticket'
                    ? 'KAN-198'
                    : kind === 'note'
                      ? 'What you saw or heard'
                      : `${KIND_LABEL[kind]} id or markdown line`
              }
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ref.trim() && chosen.length && submit(ref)}
            />
            <input
              className="is-input"
              style={{ width: 180 }}
              value={title}
              aria-label="Title"
              placeholder="Title (optional)"
              onChange={(e) => setTitle(e.target.value)}
            />
            <button
              type="button"
              className="is-btn"
              disabled={busy || !ref.trim() || chosen.length === 0}
              onClick={() => submit(ref)}
            >
              Add
            </button>
            {kind === 'sketch' && sketch.available && (
              <button
                type="button"
                className="is-btn"
                disabled={busy || chosen.length === 0}
                onClick={() => void sketch.start()}
              >
                Draw a sketch
              </button>
            )}
          </>
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            <button
              type="button"
              className="is-btn"
              disabled={busy || chosen.length === 0}
              onClick={() => fileRef.current?.click()}
            >
              Choose a file
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="is-muted" style={{ color: 'var(--is-red)', marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** Evidence tab: each piece once, with the assumptions it supports. */
export function IdeaEvidenceTab({ idea, readOnly }: { idea: Idea; readOnly: boolean }) {
  const list = useIdeaEvidence(idea.id);
  const add = useAddEvidence();
  const remove = useDeleteEvidence();
  const items = list.data ?? [];

  return (
    <div data-testid="evidence-tab">
      {items.length === 0 ? (
        <div className="is-empty">
          <h3>No evidence yet</h3>
          <div>Evidence is the proof for an assumption: a link, a file, a ticket, a note, a sketch or a diagram.</div>
        </div>
      ) : (
        <table className="is-table">
          <thead>
            <tr>
              <th>Evidence</th>
              <th>Supports</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={`${e.kind}:${e.ref}`}>
                <td>
                  <span className="is-tag">{e.kind}</span>{' '}
                  {e.kind === 'link' ? (
                    <a href={e.ref} target="_blank" rel="noreferrer noopener">
                      {e.title || e.ref}
                    </a>
                  ) : e.kind === 'sketch' && SKETCH_LINE.test(e.ref) ? (
                    <SketchEmbed
                      id={SKETCH_LINE.exec(e.ref)![2]}
                      label={e.title || SKETCH_LINE.exec(e.ref)![1]}
                      small
                      readOnly={readOnly}
                    />
                  ) : (
                    <span>{e.title || e.ref}</span>
                  )}
                </td>
                <td>
                  {e.assumptions.map((a) => (
                    <div key={a.id} className="is-muted">
                      {a.text}
                    </div>
                  ))}
                </td>
                <td className="is-muted" style={{ whiteSpace: 'nowrap' }}>
                  {e.createdBy ? `${e.createdBy === 'user' ? 'You' : e.createdBy} · ` : ''}
                  {relativeTime(e.createdAt)}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {!readOnly && (
                    <button
                      type="button"
                      className="is-btn is-btn-ghost is-btn-sm"
                      onClick={() => e.ids.forEach((id) => remove.mutate({ id: idea.id, evidenceId: id }))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!readOnly &&
        (idea.assumptions.length === 0 ? (
          <div className="is-muted" style={{ marginTop: 12 }}>
            Write an assumption first: evidence always supports one.
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <div className="is-label">Add evidence</div>
            <EvidenceForm
              ideaId={idea.id}
              projectId={idea.projectId ?? undefined}
              ideaTitle={idea.title}
              assumptions={idea.assumptions.map((a) => ({ id: a.id, text: a.text }))}
              onAdd={async (v) => {
                await add.mutateAsync({ id: idea.id, ...v });
              }}
            />
          </div>
        ))}
    </div>
  );
}
