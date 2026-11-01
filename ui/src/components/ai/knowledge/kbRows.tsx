import { useState } from 'react';
import { kbApi, useKbDoc, useKbMutation } from '../../../api/aiKb';
import { extractError } from '../../../api/extractError';
import type { KbDocument, KbStore } from '../../../types/aiKb';
import { ago } from '../aiUi';
import { KbDetailPane, KeywordChips, KindIcon, kindName, whoSees } from './kbParts';

/** One document, as a card (design I) or as a row of the table of contents. */
export function KbRow({
  projectId,
  doc,
  sharedOn,
  table,
}: {
  projectId: string;
  doc: KbDocument;
  sharedOn: boolean;
  table: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = useKbDoc(doc.id);
  const patch = useKbMutation(projectId, (b: { store?: KbStore; private?: boolean }) => kbApi.patch(doc.id, b));
  const remove = useKbMutation(projectId, () => kbApi.remove(doc.id));
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    }
  };
  const isPrivate = d.data?.private;
  const read = d.data?.lastReadAt ? ago(d.data.lastReadAt) : d.data ? 'never' : '';
  const shared = doc.store === 'shared';
  const pane = open && d.data && (
    <KbDetailPane
      doc={d.data}
      sharedOn={sharedOn}
      busy={patch.isPending || remove.isPending}
      error={error}
      onMove={(store) => void act(() => patch.mutateAsync({ store }))}
      onPrivate={(v) => void act(() => patch.mutateAsync({ private: v }))}
      onDelete={() => void act(() => remove.mutateAsync(undefined))}
    />
  );
  const toggle = (
    <button
      type="button"
      className="ai-link"
      aria-expanded={open}
      aria-label={`${open ? 'Close' : 'Open'} ${doc.title}`}
      onClick={() => setOpen(!open)}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
    >
      {open ? 'Close' : 'Open'}
    </button>
  );

  if (table)
    return (
      <>
        <tr data-testid="kb-row" data-doc={doc.id}>
          <td style={{ fontWeight: 700 }}>{doc.title}</td>
          <td style={{ color: '#3A4A3E' }}>{doc.summary}</td>
          <td>{kindName(doc.kind)}</td>
          <td>{shared ? 'Shared' : 'This project'}</td>
          <td>{whoSees(doc.store, isPrivate)}</td>
          <td>{read}</td>
          <td>{toggle}</td>
        </tr>
        {open && (
          <tr>
            <td colSpan={7}>{pane}</td>
          </tr>
        )}
      </>
    );

  return (
    <div
      data-testid="kb-row"
      data-doc={doc.id}
      style={{
        display: 'flex',
        gap: 11,
        alignItems: 'flex-start',
        padding: '11px 13px',
        border: `1px solid ${shared ? '#F0DBA8' : '#E3E8E5'}`,
        borderRadius: 10,
        background: shared ? '#FFFBEF' : '#fff',
      }}
    >
      <span style={{ marginTop: 2 }}>
        <KindIcon kind={doc.kind} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 12.5 }}>{doc.title}</b>
          <span className="ai-muted">
            {kindName(doc.kind)}
            {doc.kind === 'image' ? ' · described once on upload' : ''}
            {shared && (
              <>
                {' · '}
                <b style={{ color: '#7A5A06' }}>in the shared store</b>
              </>
            )}
            {isPrivate ? ' · private' : ''}
            {d.data ? ` · read ${read}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          {toggle}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.55, color: '#3A4A3E' }}>{doc.summary}</div>
        <KeywordChips words={doc.answers} />
        {pane}
      </div>
    </div>
  );
}
