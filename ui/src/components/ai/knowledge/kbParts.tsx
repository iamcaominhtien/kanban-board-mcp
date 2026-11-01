import { useRef, useState, type ReactNode } from 'react';
import { extractError } from '../../../api/extractError';
import type { KbDetail, KbKind, KbStore, KbUpload } from '../../../types/aiKb';

const KIND_NAME: Record<KbKind, string> = { text: 'Text', pdf: 'PDF', image: 'Image', code: 'Code' };
/** Part of the knowledge base (wave 3). */
export const kindName = (k: KbKind) => KIND_NAME[k] ?? k;

const KIND_PATH: Record<KbKind, ReactNode> = {
  pdf: (
    <>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </>
  ),
  text: <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 18l5-5 4 4 3-3 4 4" />
    </>
  ),
  code: <path d="M9 8l-5 4 5 4M15 8l5 4-5 4M13.5 5l-3 14" />,
};

/** Part of the knowledge base (wave 3). */
export function KindIcon({ kind }: { kind: KbKind }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#5B6B60"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {KIND_PATH[kind] ?? KIND_PATH.text}
    </svg>
  );
}

/** Who can read a document, in words. */
export function whoSees(store: KbStore, isPrivate: boolean | undefined): string {
  if (isPrivate) return 'Only the person who added it';
  return store === 'shared' ? 'Every project that searches the shared store' : "This project's people and AIs";
}

/** A snippet whose matches sit in [brackets]: the matches are marked. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\])/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\[[^\]]+\]$/.test(p) ? (
          <mark key={i} style={{ background: '#FBEBB8', color: 'inherit', padding: '0 2px', borderRadius: 3 }}>
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Part of the knowledge base (wave 3). */
export function KeywordChips({ words }: { words: string[] }) {
  if (!words.length) return null;
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {words.map((w) => (
        <span
          key={w}
          style={{
            background: '#F1F3F1',
            color: '#3A4A3E',
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
          }}
        >
          {w}
        </span>
      ))}
    </div>
  );
}

/** The detail of one document: what the AIs match on, and the moves (shared store, private, delete). */
export function KbDetailPane({
  doc,
  sharedOn,
  busy,
  error,
  onMove,
  onPrivate,
  onDelete,
}: {
  doc: KbDetail;
  sharedOn: boolean;
  busy: boolean;
  error: string | null;
  onMove: (store: KbStore) => void;
  onPrivate: (v: boolean) => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState<'move' | 'delete' | null>(null);
  return (
    <div
      data-testid="kb-detail"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid #EEF3EF' }}
    >
      <div className="ai-hint">
        {doc.describedBy === 'model'
          ? 'The summary and keywords were written once by a light model.'
          : 'The summary and keywords were taken from the text by code.'}
        {doc.sourceName ? ` Source: ${doc.sourceName}.` : ''}
        {doc.createdBy ? ` Added by ${doc.createdBy}.` : ''}
      </div>
      {doc.textPreview && (
        <pre
          className="ai-mono"
          style={{
            margin: 0,
            maxHeight: 140,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            fontSize: 11.5,
            background: '#FBFCFB',
            border: '1px solid #E3E8E5',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          {doc.textPreview}
        </pre>
      )}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
      {confirm === 'move' && (
        <div className="ai-notice ai-notice-warn" role="alertdialog" style={{ flexDirection: 'column' }}>
          <span>
            <b>Move “{doc.title}” to the shared store?</b> Everyone in every project that searches the shared store, and
            their AIs, will be able to read it.
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-primary"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                onMove('shared');
              }}
            >
              Move to the shared store
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setConfirm(null)}>
              Keep it here
            </button>
          </span>
        </div>
      )}
      {confirm === 'delete' && (
        <div className="ai-notice ai-notice-error" role="alertdialog" style={{ flexDirection: 'column' }}>
          <span>
            <b>Delete “{doc.title}”?</b> The AIs can no longer find it. This cannot be undone.
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-danger"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                onDelete();
              }}
            >
              Delete
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setConfirm(null)}>
              Keep it
            </button>
          </span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {doc.store === 'project' ? (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={busy || doc.private}
            title={doc.private ? 'A private document cannot go to the shared store' : undefined}
            onClick={() => setConfirm('move')}
          >
            Move to the shared store
          </button>
        ) : (
          <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => onMove('project')}>
            Move back to this project
          </button>
        )}
        <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => onPrivate(!doc.private)}>
          {doc.private ? 'Make it visible' : 'Make it private'}
        </button>
        <button type="button" className="ai-btn ai-btn-sm ai-btn-danger-outline" onClick={() => setConfirm('delete')}>
          Delete
        </button>
      </div>
      {doc.store === 'shared' && !sharedOn && (
        <div className="ai-hint">This project does not search the shared store, so its AIs cannot find this one.</div>
      )}
    </div>
  );
}

/** Add a file or paste text. */
export function KbAddForm({
  sharedOn,
  busy,
  onSubmit,
  onCancel,
}: {
  sharedOn: boolean;
  busy: boolean;
  onSubmit: (u: KbUpload) => Promise<void>;
  onCancel: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [store, setStore] = useState<KbStore>('project');
  const [priv, setPriv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!file || text.trim().length > 0;

  const submit = async () => {
    setError(null);
    try {
      await onSubmit({ file, text, title: title.trim() || file?.name || 'Untitled', store, private: priv });
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div
      className="ai-card"
      data-testid="kb-add"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 9, background: '#FBFCFB' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          ref={fileRef}
          type="file"
          data-testid="kb-file"
          accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.py,.ts,.tsx,.js,.json,.csv,.html,.css,.yml,.yaml,.toml,.sql,.sh,.go,.rs,.java,text/*,image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f && !title) setTitle(f.name);
          }}
        />
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => fileRef.current?.click()}>
          Choose a file
        </button>
        <span className="ai-hint">
          {file ? file.name : 'PDF, image, text or code, up to 50 MB. Or paste text below.'}
        </span>
      </div>
      {!file && (
        <textarea
          className="ai-textarea"
          aria-label="Text to add"
          placeholder="Paste text here"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="ai-input"
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ flex: 1, minWidth: 180, width: 'auto' }}
        />
        <select
          className="ai-select"
          aria-label="Store"
          value={store}
          onChange={(e) => setStore(e.target.value as KbStore)}
          style={{ width: 'auto' }}
        >
          <option value="project">This project</option>
          {sharedOn && <option value="shared">The shared store</option>}
        </select>
        <label className="ai-hint" style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          Private
        </label>
      </div>
      {store === 'shared' && (
        <div className="ai-hint">
          Every project that searches the shared store, and its AIs, will be able to read this.
        </div>
      )}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          disabled={!ready || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Reading it…' : 'Add'}
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
