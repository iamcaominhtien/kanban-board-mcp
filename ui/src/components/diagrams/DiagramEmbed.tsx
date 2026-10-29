import { useEffect, useRef, useState } from 'react';
import { diagramSvgUrl, useDiagram, type Diagram } from '../../api/diagrams';
import { relativeTime, actorName } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { DiagramIcon } from './DiagramIcon';
import { DiagramMenu } from './DiagramMenu';
import { useDiagrams } from './DiagramsContext';
import styles from './Diagrams.module.css';

interface Props {
  id: string;
  /** The label written in the markdown; it is the alt text when the diagram cannot be read. */
  label: string;
  /** A Docs page version's pinned diagram version. */
  version?: number;
  /** Narrower layout for tickets and comments. */
  small?: boolean;
  /** Called with the new id after "Save as copy", so the text can point to it. */
  onReplace?: (newId: string, newLabel: string) => void;
  /** Where edits save to, shown in the editor header. */
  saveTo?: string;
  /** Hide Edit (a read-only history view). */
  readOnly?: boolean;
  /** Called with the saved diagram after an edit, so the text can follow a renamed label. */
  onChanged?: (d: Diagram) => void;
}

/**
 * A diagram inline in a markdown field: crisp SVG with a hover/focus toolbar and all the states.
 * @param props.id - Diagram id from `diagram:dg_…`.
 * @param props.label - Label from the markdown (alt text).
 * @param props.version - Pinned version to show.
 * @param props.small - Narrower layout (tickets, comments).
 * @param props.onReplace - Handler for "Save as copy".
 * @param props.saveTo - "Saves to" text for the editor.
 * @param props.readOnly - Never offer Edit.
 * @param props.onChanged - Called with the saved diagram after an edit.
 */
export function DiagramEmbed({ id, label, version, small, onReplace, saveTo, readOnly, onChanged }: Props) {
  const toast = useToast();
  const api = useDiagrams();
  const q = useDiagram(id, version);
  const [menu, setMenu] = useState(false);
  const [broken, setBroken] = useState(false);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    // capture phase: Escape closes the menu only, not the ticket or page behind it
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenu(false);
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc, true);
    };
  }, [menu]);

  const cls = `${styles.embed} ${small ? styles.embedSmall : ''}`;

  if (q.isLoading) {
    return (
      <span className={cls} aria-busy="true" data-testid="diagram-loading">
        <span className={`${styles.stage} ${styles.skeleton}`} style={{ display: 'block' }} />
      </span>
    );
  }
  if (q.isError || !q.data) {
    return (
      <span className={cls} data-testid="diagram-missing" role="note" onClick={(e) => e.stopPropagation()}>
        <span className={styles.state}>
          <span className={styles.stateTitle}>Diagram not found</span>
          <span className={styles.stateText}>It was deleted, or you do not have access. Alt text: “{label}”.</span>
        </span>
      </span>
    );
  }

  const d = q.data;
  const pinned = version != null && version !== d.version;
  const canEdit = !!api && d.canEdit && !readOnly && !pinned;
  const edit = () =>
    api?.openEditor({
      projectId: d.projectId,
      diagramId: d.id,
      label: d.label,
      saveTo,
      replaces: !!onReplace,
      onSaved: (saved, info) => {
        if (info.asCopy) onReplace?.(saved.id, saved.label);
        else {
          void q.refetch();
          onChanged?.(saved);
        }
      },
    });

  if (d.empty) {
    return (
      <span
        className={cls}
        id={`diagram-${d.id}`}
        data-testid="diagram-empty"
        role="note"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={styles.state}>
          <span className={styles.stateTitle}>Empty diagram</span>
          <span className={styles.stateText}>Nothing drawn yet.</span>
          {canEdit && (
            <span className={styles.stateRow}>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={edit}>
                <DiagramIcon name="edit" /> Open editor
              </button>
            </span>
          )}
        </span>
      </span>
    );
  }

  const summary = d.summary || d.suggestedSummary || '';
  const who = actorName(d.updatedBy);
  const edited = d.version > 1;

  return (
    <figure
      onClick={(e) => e.stopPropagation()}
      ref={root}
      className={cls}
      id={`diagram-${d.id}`}
      data-testid="diagram-embed"
      data-diagram={d.id}
      style={{ margin: '10px 0' }}
    >
      <span className={styles.stage} style={{ display: 'flex' }}>
        {broken ? (
          <span className={styles.stateText}>The preview could not be loaded. You can still download the diagram.</span>
        ) : (
          <img
            src={diagramSvgUrl(d.id, version ?? d.version)}
            alt={d.label || label}
            loading="lazy"
            onError={() => setBroken(true)}
            onClick={() => api?.openViewer(d, version)}
          />
        )}
      </span>
      <span
        className={`${styles.toolbar} ${menu ? styles.toolbarOpen : ''}`}
        role="toolbar"
        aria-label="Diagram actions"
        style={{ display: 'flex' }}
      >
        {canEdit && (
          <button type="button" className={styles.tbBtn} onClick={edit}>
            <DiagramIcon name="edit" /> Edit
          </button>
        )}
        <button
          type="button"
          className={`${styles.tbBtn} ${menu ? styles.tbBtnActive : ''}`}
          aria-label="Download"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <DiagramIcon name="download" />
        </button>
        <button
          type="button"
          className={styles.tbBtn}
          aria-label="View full size"
          onClick={() => api?.openViewer(d, version)}
        >
          <DiagramIcon name="expand" />
        </button>
        <button
          type="button"
          className={styles.tbBtn}
          aria-label="Copy link"
          onClick={() => {
            const url = `${window.location.origin}${window.location.pathname}#diagram-${d.id}`;
            navigator.clipboard
              .writeText(url)
              .then(() => toast.success('Link copied'))
              .catch(() => toast.error("Couldn't copy the link"));
          }}
        >
          <DiagramIcon name="link" />
        </button>
      </span>
      {menu && <DiagramMenu id={d.id} label={d.label} version={version} onDone={() => setMenu(false)} />}
      <figcaption className={styles.footer} style={{ display: 'flex' }}>
        <span className={styles.chip}>
          <DiagramIcon name="drawio" size={12} /> draw.io
        </span>
        <span className={styles.name}>{d.label}</span>
        {d.previewKind === 'basic' && !pinned && (
          <span
            className={styles.when}
            style={{ marginLeft: 0 }}
            title="This picture was drawn by the server (boxes, arrows and text only). Open the diagram in the editor and save to get the full drawing."
            data-testid="diagram-basic-preview"
          >
            Simple preview
          </span>
        )}
        <span className={styles.when}>
          {pinned ? `Version ${version}` : `${edited ? 'Edited' : 'Added'} by ${who} · ${relativeTime(d.updatedAt)}`}
        </span>
      </figcaption>
      {summary && (
        <details className={styles.summary} style={{ display: 'block' }}>
          <summary>Text summary</summary>
          {summary}
        </details>
      )}
    </figure>
  );
}
