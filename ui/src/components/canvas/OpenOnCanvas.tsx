import { useEffect, useRef, useState } from 'react';
import { client } from '../../api/client';
import { addBoard, canvasFailure, createCanvas, canvasMarkdown, type CanvasSummary } from '../../api/canvases';
import { useToast } from '../Toast';
import { CanvasIcon } from './CanvasIcon';
import { useCanvas, type CanvasOwner } from './CanvasContext';
import styles from './Canvas.module.css';

interface Props {
  owner: CanvasOwner;
  /** The file's name: its extension decides whether it becomes an HTML or a picture board. */
  name: string;
  /** Where the file's bytes are read from. */
  src: string;
  buttonClass?: string;
  labelClass?: string;
}

/**
 * "Open on a canvas", on an HTML file or a picture in the file viewer: choose a canvas of the same place (or a new
 * one) and the file becomes a board there. The attachment stays as it was.
 * @param props - The place the canvas belongs to and the file.
 */
export function OpenOnCanvas({ owner, name, src, buttonClass, labelClass }: Props) {
  const api = useCanvas();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CanvasSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    let off = false;
    client
      .get<CanvasSummary[]>('/canvases', { params: { ownerKind: owner.ownerKind, ownerId: owner.ownerId } })
      .then((r) => !off && setList(r.data))
      .catch(() => !off && setList([]));
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => {
      off = true;
      document.removeEventListener('mousedown', away);
    };
  }, [open, owner.ownerKind, owner.ownerId]);

  const put = async (existing: CanvasSummary | null) => {
    setBusy(true);
    try {
      const stem = name.replace(/\.[^.]+$/, '');
      const isHtml = /\.html?$/i.test(name);
      const blob = await (await fetch(src)).blob();
      let canvasId = existing?.id;
      let created: { id: string; title: string } | null = null;
      if (!canvasId) {
        const c = await createCanvas({
          ownerKind: owner.ownerKind,
          ownerId: owner.ownerId,
          title: stem,
          projectId: owner.projectId,
          start: 'none',
        });
        canvasId = c.id;
        created = { id: c.id, title: c.title };
      }
      const out = await addBoard(canvasId, { kind: isHtml ? 'html' : 'image', name: stem }, [
        { file: blob, path: isHtml ? 'index.html' : name },
      ]);
      if (created) owner.onCreated?.(canvasMarkdown(created), created.title);
      setOpen(false);
      void api.openCanvas({
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        projectId: owner.projectId,
        ownerLabel: owner.ownerLabel,
        canvasId,
        boardId: out.board.id,
      });
      toast.success('Added to the canvas', `“${stem}” is a board now. The attachment stays as it was.`);
    } catch (e) {
      toast.error('Could not open it on a canvas', canvasFailure(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span ref={box} className={styles.root} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className={buttonClass}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="open-on-canvas"
        title="Choose a canvas (or a new one): the file becomes a board there"
      >
        <CanvasIcon name="canvas" size={14} /> <span className={labelClass}>Open on a canvas</span>
      </button>
      {open && (
        <div className={styles.menu} role="menu" style={{ right: 0, top: 38, width: 260 }}>
          <div className={styles.menuHead}>Choose a canvas</div>
          {list === null && (
            <div className={styles.hint} style={{ padding: '6px 10px' }}>
              Loading…
            </div>
          )}
          {list?.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled={busy}
              onClick={() => void put(c)}
            >
              <CanvasIcon name="canvas" size={14} /> {c.title}
              <small>{c.boardCount}</small>
            </button>
          ))}
          <div className={styles.menuSep} />
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            disabled={busy}
            onClick={() => void put(null)}
            data-testid="open-on-new-canvas"
          >
            <CanvasIcon name="plus" size={14} /> New canvas
          </button>
        </div>
      )}
    </span>
  );
}
