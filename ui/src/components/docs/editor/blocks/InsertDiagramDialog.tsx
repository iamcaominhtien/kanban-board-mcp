/**
 * Insert diagram (design "Embeds", frame 20): a new draw.io drawing, one of the project's diagrams (searched by name,
 * with who edited it and when), or an imported `.drawio` file. Replace on a selected diagram uses the same list.
 */

import type { Editor } from '@tiptap/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { client } from '../../../../api/client';
import type { Diagram } from '../../../../api/diagrams';
import { actorName, relativeTime } from '../../../../utils/relativeTime';
import { setNodeAttrs } from './commands';
import { Dialog } from './ui';

/**
 * The dialog.
 * @param props.replacePos - Put the diagram picked in place of the one at this position.
 * @param props.onNew - Starts a new drawing in the draw.io editor (the editor's own flow).
 * @param props.onImport - Opens the file chooser for a `.drawio` file (the editor's own flow).
 */
export function InsertDiagramDialog({
  editor,
  projectId,
  replacePos,
  onNew,
  onImport,
  onClose,
}: {
  editor: Editor;
  projectId: string;
  replacePos?: number;
  onNew?: () => void;
  onImport?: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Diagram | null>(null);
  const list = useQuery({
    queryKey: ['diagrams', 'project', projectId],
    queryFn: async () => (await client.get<Diagram[]>(`/projects/${projectId}/diagrams`)).data,
    staleTime: 30_000,
  });
  const shown = (list.data ?? []).filter((d) => !q.trim() || d.label.toLowerCase().includes(q.trim().toLowerCase()));
  const replacing = replacePos != null;
  const insert = (d: Diagram | null = chosen) => {
    if (!d) return;
    if (replacing) setNodeAttrs(editor, replacePos, { id: d.id, label: d.label, version: null });
    else
      editor
        .chain()
        .focus()
        .insertContent({ type: 'diagram', attrs: { id: d.id, label: d.label } })
        .run();
    onClose();
  };
  return (
    <Dialog
      title={replacing ? 'Replace diagram' : 'Insert diagram'}
      onClose={onClose}
      testId="insert-diagram"
      width={400}
      footer={
        <>
          <button type="button" className="st-btn st-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={!chosen} onClick={() => insert()}>
            {replacing ? 'Replace diagram' : 'Insert diagram'}
          </button>
        </>
      }
    >
      {!replacing && onNew && (
        <button
          type="button"
          className="dk-dg-choice"
          onClick={() => {
            onClose();
            onNew();
          }}
        >
          <strong>New draw.io drawing</strong>
          <span>Boxes and arrows, edited in draw.io</span>
        </button>
      )}
      <div className="dk-bp-label">From this project</div>
      <input
        className="dk-bp-input"
        type="search"
        aria-label="Search diagrams"
        placeholder="Search diagrams"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="dk-dg-list" role="listbox" aria-label="Diagrams of this project">
        {list.isLoading && <p className="dk-bp-muted">Loading the diagrams…</p>}
        {!list.isLoading && shown.length === 0 && <p className="dk-bp-muted">No diagrams match.</p>}
        {shown.map((d) => (
          <button
            key={d.id}
            type="button"
            role="option"
            aria-selected={chosen?.id === d.id}
            className={`dk-dg-row${chosen?.id === d.id ? ' on' : ''}`}
            onClick={() => setChosen(d)}
            onDoubleClick={() => insert(d)}
          >
            <span className="dk-dg-name">{d.label}</span>
            <span className="dk-dg-meta">
              {actorName(d.updatedBy)} · {relativeTime(d.updatedAt)}
            </span>
            <span className="dk-dg-ver">v{d.version}</span>
          </button>
        ))}
      </div>
      {!replacing && onImport && (
        <button
          type="button"
          className="dk-dg-choice"
          onClick={() => {
            onClose();
            onImport();
          }}
        >
          <strong>Import .drawio file</strong>
          <span>Also drop a file onto the page</span>
        </button>
      )}
    </Dialog>
  );
}
