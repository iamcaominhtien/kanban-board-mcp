/**
 * The block layer of the editor: draws what the blocks ask for (the Insert image dialog, image properties, crop, the
 * block menu), the bar for several chosen blocks (board J 52, 55), the 44 px handle beside the block with the cursor
 * on a touch screen, the long press that opens the block menu on a phone, and the checkboxes for choosing blocks one
 * by one. It also reads the project's image limit (Docs settings `uploads.imageMb`, 10 MB when unknown).
 */

import type { Editor } from '@tiptap/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { client } from '../../../../api/client';
import { Icon } from '../../Icon';
import { blockKitOf, type BlockUiRequest, type ImageTab } from './bus';
import { blockRange, chosenBlocks, clearChosenBlocks, setChosenBlocks, toggleChosenBlock } from './BlockKit';
import { BlockMenu } from './BlockMenu';
import { currentBlock, deleteBlocks, duplicateBlocks, moveBlock } from './commands';
import { CropDialog } from './CropDialog';
import { ImageProps } from './ImageProps';
import { InsertImageDialog } from './InsertImageDialog';
import { useBlockLayout, useCoarsePointer } from './ui';
import { useEditorTick } from './useInside';
import './blocks.css';

/** The project's image limit in MB (Docs settings), kept in the editor's BlockKit storage. */
function useImageLimit(editor: Editor, projectId: string): number {
  const q = useQuery({
    queryKey: ['docs', 'space-settings', projectId],
    queryFn: async () =>
      (await client.get<{ uploads?: { imageMb?: number } }>(`/projects/${projectId}/docs/settings`)).data,
    staleTime: 60_000,
    retry: false,
  });
  const mb = typeof q.data?.uploads?.imageMb === 'number' && q.data.uploads.imageMb > 0 ? q.data.uploads.imageMb : 10;
  useEffect(() => {
    const kit = blockKitOf(editor);
    if (kit) kit.imageLimitMb = mb;
  }, [editor, mb]);
  return mb;
}

/** The top-level block (a child of the document) at a point of the screen, or null. */
function topBlockAtPoint(editor: Editor, x: number, y: number): number | null {
  const hit = editor.view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const $p = editor.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  return $p.depth >= 1 ? $p.before(1) : hit.inside >= 0 ? hit.inside : null;
}

interface Rect {
  pos: number;
  top: number;
  left: number;
  height: number;
}

/**
 * The layer.
 * @param props.hostRef - The element the overlays are placed in (the page column).
 * @param props.onComment - Starts a comment on the selected text (block menu, Comment); unset hides it.
 */
export function BlockLayer({
  editor,
  hostRef,
  projectId,
  onComment,
}: {
  editor: Editor;
  hostRef: RefObject<HTMLDivElement>;
  projectId: string;
  onComment?: () => void;
}) {
  const layout = useBlockLayout();
  const coarse = useCoarsePointer();
  const limitMb = useImageLimit(editor, projectId);
  const tick = useEditorTick(editor);
  const [imageDialog, setImageDialog] = useState<{ replacePos?: number } | null>(null);
  const [props, setProps] = useState<{ pos: number; tab?: ImageTab } | null>(null);
  const [crop, setCrop] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ pos: number; anchor: DOMRect | null } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const editable = editor.isEditable;
  const chosen = chosenBlocks(editor.state);

  useEffect(() => {
    const kit = blockKitOf(editor);
    if (!kit) return undefined;
    return kit.bus.on((req: BlockUiRequest) => {
      switch (req.type) {
        case 'insertImage':
          setImageDialog({ replacePos: req.replacePos });
          break;
        case 'imageProps':
          setProps({ pos: req.pos, tab: req.tab });
          break;
        case 'crop':
          setCrop(req.pos);
          break;
        case 'blockMenu':
          setMenu({ pos: req.pos, anchor: req.anchor });
          break;
        case 'selectBlocks':
          setSelectMode(true);
          setChosenBlocks(editor, [req.pos]);
          break;
        case 'chooseBlock': {
          const list = chosenBlocks(editor.state);
          const from = list.length ? list[0] : currentBlock(editor.state)?.pos;
          const top = (p: number | undefined) => {
            if (p == null) return null;
            const $p = editor.state.doc.resolve(Math.min(p + 1, editor.state.doc.content.size));
            return $p.depth >= 1 ? $p.before(1) : p;
          };
          const a = top(from);
          setChosenBlocks(editor, a == null ? [req.pos] : blockRange(editor.state, a, req.pos));
          // the keys (Esc, Del, Ctrl+D) go to the editor, not to the handle that was clicked
          editor.view.focus();
          break;
        }
        default:
          break;
      }
    });
  }, [editor]);

  // leaving select mode clears the choice; clearing the choice ends select mode
  useEffect(() => {
    if (selectMode && chosen.length === 0) setSelectMode(false);
  }, [selectMode, chosen.length]);

  // a long press on a block opens its menu (phones and tablets)
  useEffect(() => {
    if (!coarse || !editable) return undefined;
    const dom = editor.view.dom as HTMLElement;
    let timer: number | null = null;
    let start: { x: number; y: number } | null = null;
    const cancel = () => {
      if (timer) window.clearTimeout(timer);
      timer = null;
    };
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      start = { x: t.clientX, y: t.clientY };
      cancel();
      timer = window.setTimeout(() => {
        const pos = topBlockAtPoint(editor, start!.x, start!.y);
        if (pos == null) return;
        const nodeDom = editor.view.nodeDOM(pos);
        setMenu({
          pos,
          anchor: layout === 'phone' || !(nodeDom instanceof HTMLElement) ? null : nodeDom.getBoundingClientRect(),
        });
      }, 550);
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
    };
    dom.addEventListener('touchstart', down, { passive: true });
    dom.addEventListener('touchmove', move, { passive: true });
    dom.addEventListener('touchend', cancel);
    dom.addEventListener('touchcancel', cancel);
    return () => {
      cancel();
      dom.removeEventListener('touchstart', down);
      dom.removeEventListener('touchmove', move);
      dom.removeEventListener('touchend', cancel);
      dom.removeEventListener('touchcancel', cancel);
    };
  }, [editor, coarse, editable, layout]);

  // where the blocks are: the touch handle (the cursor's block) and the checkboxes (every block)
  const cursorBlock = coarse && editable ? currentBlock(editor.state) : null;
  const cursorTop = cursorBlock
    ? (() => {
        const $p = editor.state.doc.resolve(Math.min(cursorBlock.pos + 1, editor.state.doc.content.size));
        return $p.depth >= 1 ? $p.before(1) : cursorBlock.pos;
      })()
    : null;
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || editor.isDestroyed) return;
    const base = layer.getBoundingClientRect();
    const want: number[] = selectMode
      ? (() => {
          const all: number[] = [];
          editor.state.doc.forEach((_n, offset) => all.push(offset));
          return all;
        })()
      : cursorTop != null
        ? [cursorTop]
        : [];
    const next: Rect[] = [];
    for (const pos of want) {
      const dom = editor.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) continue;
      const r = dom.getBoundingClientRect();
      next.push({ pos, top: r.top - base.top, left: r.left - base.left, height: r.height });
    }
    setRects((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [editor, tick, selectMode, cursorTop, layout]);

  const firstChosenRect = (() => {
    if (!chosen.length) return null;
    const dom = editor.view.nodeDOM(chosen[0]);
    const layer = layerRef.current?.getBoundingClientRect();
    if (!(dom instanceof HTMLElement) || !layer) return null;
    const r = dom.getBoundingClientRect();
    return { top: r.top - layer.top, left: r.left - layer.left };
  })();

  const many = chosen.length;
  const bar = many > 0 && editable && (
    <div
      className={`dk-chosen-bar${layout === 'phone' || selectMode ? ' dk-chosen-bar-bottom' : ''}`}
      role="toolbar"
      aria-label={`${many} blocks`}
      data-block-ui=""
      style={
        layout === 'phone' || selectMode || !firstChosenRect
          ? undefined
          : { top: Math.max(0, firstChosenRect.top - 46), left: firstChosenRect.left }
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      <strong>{selectMode ? `${many} selected` : `${many} blocks`}</strong>
      <button
        type="button"
        onClick={(e) =>
          setMenu({ pos: chosen[0], anchor: layout === 'phone' ? null : e.currentTarget.getBoundingClientRect() })
        }
      >
        Turn into
      </button>
      <button type="button" onClick={() => duplicateBlocks(editor, chosen)}>
        Duplicate
      </button>
      {selectMode && (
        <>
          <button
            type="button"
            disabled={many !== 1}
            onClick={() => {
              const to = moveBlock(editor, chosen[0], -1);
              if (to != null) setChosenBlocks(editor, [to]);
            }}
          >
            Up
          </button>
          <button
            type="button"
            disabled={many !== 1}
            onClick={() => {
              const to = moveBlock(editor, chosen[0], 1);
              if (to != null) setChosenBlocks(editor, [to]);
            }}
          >
            Down
          </button>
        </>
      )}
      <button
        type="button"
        className="danger"
        onClick={() => {
          deleteBlocks(editor, chosen);
          clearChosenBlocks(editor);
        }}
      >
        Delete
      </button>
      <button type="button" aria-label="Clear the selection" onClick={() => clearChosenBlocks(editor)}>
        <Icon name="close" size={13} />
      </button>
      {!selectMode && layout === 'desktop' && (
        <span className="dk-chosen-hint">Esc clears the selection · Ctrl A selects every block · Del deletes</span>
      )}
    </div>
  );

  return (
    <div ref={layerRef} className="dk-block-layer" aria-hidden={false}>
      {!selectMode &&
        coarse &&
        editable &&
        rects.slice(0, 1).map((r) => (
          <button
            key={r.pos}
            type="button"
            className="dk-touch-handle"
            aria-label="Block menu"
            data-block-ui=""
            style={{
              top: r.top,
              left: Math.max(r.left - 46, -((hostRef.current?.getBoundingClientRect().left ?? 0) - 2)),
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) =>
              setMenu({ pos: r.pos, anchor: layout === 'phone' ? null : e.currentTarget.getBoundingClientRect() })
            }
          >
            <Icon name="grip" size={18} />
          </button>
        ))}
      {selectMode &&
        rects.map((r) => {
          const on = chosen.includes(r.pos);
          return (
            <button
              key={r.pos}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label="Choose this block"
              className={`dk-block-check${on ? ' on' : ''}`}
              data-block-ui=""
              style={{
                top: r.top + Math.min(r.height / 2 - 22, 0),
                left: Math.max(r.left - 46, -((hostRef.current?.getBoundingClientRect().left ?? 0) - 2)),
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleChosenBlock(editor, r.pos)}
            >
              {on && <Icon name="check" size={16} />}
            </button>
          );
        })}
      {bar}
      {imageDialog && (
        <InsertImageDialog
          editor={editor}
          projectId={projectId}
          replacePos={imageDialog.replacePos}
          limitMb={limitMb}
          onClose={() => setImageDialog(null)}
        />
      )}
      {props && <ImageProps editor={editor} pos={props.pos} tab={props.tab} onClose={() => setProps(null)} />}
      {crop != null && <CropDialog editor={editor} pos={crop} onClose={() => setCrop(null)} />}
      {menu && (
        <BlockMenu
          editor={editor}
          pos={menu.pos}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onComment={onComment}
        />
      )}
    </div>
  );
}
