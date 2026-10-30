import { useState } from 'react';
import { sketchPngUrl, useSketchMeta, type Sketch } from '../../api/sketches';
import { actorName, relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { SketchIcon } from './SketchIcon';
import { useSketch } from './SketchContext';
import styles from './Sketch.module.css';

interface Props {
  id: string;
  /** The text written in the markdown; it is the alt text when the drawing cannot be read. */
  label: string;
  /** Narrower layout for tickets and comments. */
  small?: boolean;
  /** Hide Edit (a read-only history view, a viewer). */
  readOnly?: boolean;
  /** Called with the new id and title after "Save a copy", so the text can point to the copy. */
  onReplace?: (newId: string, newTitle: string) => void;
  /** Called with the saved sketch after an edit, so the text can follow a renamed title. */
  onChanged?: (s: Sketch) => void;
}

/**
 * A sketch inline in a markdown field: the PNG, with "Edit sketch" for people who can edit and "View large" for everyone.
 * @param props.id - Sketch id from `sketch:sk_…`.
 * @param props.label - Alt text from the markdown.
 * @param props.small - Narrower layout.
 * @param props.readOnly - Never offer Edit.
 * @param props.onReplace - Handler for "Save a copy".
 * @param props.onChanged - Called with the saved sketch after an edit.
 */
export function SketchEmbed({ id, label, small, readOnly, onReplace, onChanged }: Props) {
  const toast = useToast();
  const api = useSketch();
  const q = useSketchMeta(id);
  const [broken, setBroken] = useState(false);
  const cls = `${styles.embed} ${small ? styles.embedSmall : ''}`;

  if (q.isLoading) {
    return (
      <span className={cls} aria-busy="true" data-testid="sketch-loading">
        <span className={`${styles.embedStage} ${styles.skeleton}`} />
      </span>
    );
  }
  if (q.isError || !q.data) {
    return (
      <span className={cls} data-testid="sketch-missing" role="note" onClick={(e) => e.stopPropagation()}>
        <span className={styles.embedState}>
          <span className={styles.embedStateTitle}>Sketch not found</span>
          <span className={styles.embedStateText}>It was deleted, or you do not have access. Alt text: “{label}”.</span>
        </span>
      </span>
    );
  }

  const s = q.data;
  const canEdit = api.available && s.canEdit && !readOnly;
  const edit = async () => {
    const r = await api.openSketch({
      ownerKind: s.ownerKind,
      ownerId: s.ownerId,
      sketchId: s.id,
      projectId: s.projectId ?? undefined,
      title: s.title,
    });
    if (!r) return;
    if (r.id !== s.id) {
      // "Save a copy" made a second drawing: the text can point to it
      if (onReplace) onReplace(r.id, r.title);
      else
        void navigator.clipboard
          ?.writeText(r.markdown)
          .then(() => toast.success('Saved a copy', 'Its markdown is copied.'));
    } else {
      void q.refetch();
      onChanged?.(r.sketch);
    }
  };
  const view = () => api.openViewer({ id: s.id, title: s.title, version: s.version });

  return (
    <figure
      className={cls}
      id={`sketch-${s.id}`}
      data-testid="sketch-embed"
      data-sketch={s.id}
      style={{ margin: '10px 0' }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className={styles.embedStage}>
        {broken ? (
          <span className={styles.embedStateText}>The picture could not be loaded.</span>
        ) : (
          <img
            src={sketchPngUrl(s.id, s.version)}
            alt={s.title || label}
            loading="lazy"
            onError={() => setBroken(true)}
            onClick={view}
          />
        )}
      </span>
      <span className={styles.toolbar} role="toolbar" aria-label="Sketch actions">
        {canEdit && (
          <button type="button" className={styles.tbBtn} onClick={() => void edit()} data-testid="sketch-edit">
            <SketchIcon name="edit" size={14} /> Edit sketch
          </button>
        )}
        <button type="button" className={styles.tbBtn} aria-label="View large" onClick={view} data-testid="sketch-view">
          <SketchIcon name="expand" size={14} />
        </button>
      </span>
      <figcaption className={styles.embedFooter}>
        <span className={styles.chip}>
          <SketchIcon name="sketch" size={12} /> Sketch
        </span>
        <span className={styles.embedName}>{s.title}</span>
        <span className={styles.embedWhen}>
          {s.version > 1 ? 'Edited' : 'Added'} by {actorName(s.updatedBy)} · {relativeTime(s.updatedAt)}
        </span>
      </figcaption>
    </figure>
  );
}
