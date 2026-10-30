import { useCallback, type MutableRefObject, type RefObject } from 'react';
import { resolveOrigin } from '../../api/resolveOrigin';
import type { SketchOwnerKind } from '../../api/sketches';
import { sketchBlockElement } from '../../utils/markdownWysiwyg';
import { useSketch } from './SketchContext';
import { SKETCH_LINE } from './sketchRefs';
import { useSketchStarter } from './useSketchStarter';

interface Options {
  /** The editable surface the blocks live in. */
  root: RefObject<HTMLElement>;
  /** Where the caret was before a toolbar button took focus. */
  savedRange: MutableRefObject<Range | null>;
  /** Write the surface's content back to the text. */
  sync: () => void;
  readOnly?: boolean;
  ownerKind: SketchOwnerKind;
  ownerId?: string;
  projectId?: string;
  ownerLabel?: string;
}

/**
 * Sketch support for the WYSIWYG markdown editor: the toolbar action, the block it inserts and clicks on a block.
 * @param o - The surface, the caret to restore, how to save, and who owns the drawings.
 */
export function useSketchBlocks(o: Options) {
  const api = useSketch();
  const { root, savedRange, sync, readOnly } = o;

  /** Put a saved sketch's block after the block the caret was in (or at the end) and save the text. */
  const insertBlock = useCallback(
    (md: string) => {
      const surface = root.current;
      const parts = SKETCH_LINE.exec(md);
      if (!surface || !parts) return;
      const block = sketchBlockElement(parts[2], parts[1]);
      const saved = savedRange.current;
      let anchor: Node | null = null;
      if (saved && surface.contains(saved.commonAncestorContainer)) {
        anchor = saved.commonAncestorContainer;
        while (anchor.parentNode && anchor.parentNode !== surface) anchor = anchor.parentNode;
        if (anchor === surface) anchor = null;
      }
      surface.insertBefore(block, anchor ? anchor.nextSibling : null);
      if (!block.nextElementSibling) {
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        surface.appendChild(p);
      }
      savedRange.current = null;
      sync();
    },
    [root, savedRange, sync],
  );

  const starter = useSketchStarter({
    ownerKind: o.ownerKind,
    ownerId: o.ownerId,
    projectId: o.projectId,
    ownerLabel: o.ownerLabel,
    onInsert: insertBlock,
  });

  /** A click inside the surface: handles "Edit sketch" and opening the picture large. Returns true when it did. */
  const handleClick = useCallback(
    (target: HTMLElement): boolean => {
      const block = target.closest('[data-sketch]') as HTMLElement | null;
      if (!block || !root.current?.contains(block)) return false;
      const id = block.getAttribute('data-sketch') ?? '';
      if (!/^sk_[0-9a-f]{8}$/.test(id)) return true;
      const title = block.getAttribute('data-label') ?? 'Sketch';
      if (target.closest('[data-sketch-edit]')) {
        if (!readOnly && api.available) {
          void api
            .openSketch({
              ownerKind: o.ownerKind,
              ownerId: o.ownerId || o.projectId || '',
              projectId: o.projectId,
              ownerLabel: o.ownerLabel,
              sketchId: id,
              title,
            })
            .then((r) => {
              if (!r) return;
              // "Save a copy" makes a second drawing: the block then points to the copy
              block.setAttribute('data-sketch', r.id);
              block.setAttribute('data-label', r.title);
              const name = block.querySelector('[data-sketch-name]');
              if (name) name.textContent = r.title;
              const img = block.querySelector('img');
              if (img) img.setAttribute('src', `${resolveOrigin()}/sketches/${r.id}/png?v=${r.version}`);
              sync();
            });
        }
      } else {
        api.openViewer({ id, title });
      }
      return true;
    },
    [api, root, readOnly, sync, o.ownerKind, o.ownerId, o.projectId, o.ownerLabel],
  );

  return { starter, handleClick };
}
