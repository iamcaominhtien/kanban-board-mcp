/**
 * The block layer of the editor: draws what the blocks ask for (the Insert image dialog, image properties, crop, the
 * block menu), the bar for several chosen blocks (board J 52, 55), the 44 px handle beside the block with the cursor
 * on a touch screen, the long press that opens the block menu on a phone, and the checkboxes for choosing blocks one
 * by one, and the embeds' dialogs (Insert video, Embed from link, the menu of a pasted link, Insert diagram). It also
 * reads the project's upload limits (Docs settings `uploads`, 10 / 200 / 100 MB when unknown) and tells the editor's
 * storage the project, so uploads go to its Docs uploads.
 */

import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { uploadLimitMb, useDocsSpaceSettings } from '../../embeds/embedApi';
import { Icon } from '../../Icon';
import { blockKitOf, type BlockUiRequest, type ImageTab } from './bus';
import { blockRange, chosenBlocks, clearChosenBlocks, setChosenBlocks, toggleChosenBlock } from './BlockKit';
import { BlockMenu, selectBlockText } from './BlockMenu';
import { currentBlock, deleteBlocks, duplicateBlocks, moveBlock } from './commands';
import { CropDialog } from './CropDialog';
import { ImageProps } from './ImageProps';
import { InsertDiagramDialog } from './InsertDiagramDialog';
import { InsertImageDialog } from './InsertImageDialog';
import { InsertVideoDialog } from './InsertVideoDialog';
import { EmbedLinkDialog, PasteLinkMenu } from './LinkDialogs';
import { useBlockLayout, useCoarsePointer } from './ui';
import { useEditorTick } from './useInside';
import './blocks.css';

/**
 * The project's upload limits in MB (Docs settings), kept in the editor's BlockKit storage with the project id.
 * @returns The image limit (the Insert image dialog says it).
 */
function useUploadLimits(editor: Editor, projectId: string): { image: number; video: number } {
  const q = useDocsSpaceSettings(projectId);
  const image = uploadLimitMb(q.data, 'image');
  const video = uploadLimitMb(q.data, 'video');
  const file = uploadLimitMb(q.data, 'file');
  useEffect(() => {
    const kit = blockKitOf(editor);
    if (!kit) return;
    kit.imageLimitMb = image;
    kit.videoLimitMb = video;
    kit.fileLimitMb = file;
    kit.projectId = projectId || null;
  }, [editor, image, video, file, projectId]);
  return { image, video };
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
  const limits = useUploadLimits(editor, projectId);
  const limitMb = limits.image;
  const tick = useEditorTick(editor);
  const [imageDialog, setImageDialog] = useState<{ replacePos?: number } | null>(null);
  const [props, setProps] = useState<{ pos: number; tab?: ImageTab } | null>(null);
  const [crop, setCrop] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ pos: number; anchor: DOMRect | null } | null>(null);
  const [videoDialog, setVideoDialog] = useState<{ replacePos?: number } | null>(null);
  const [linkDialog, setLinkDialog] = useState(false);
  const [pasted, setPasted] = useState<{ pos: number; url: string } | null>(null);
  const [diagramDialog, setDiagramDialog] = useState<Extract<BlockUiRequest, { type: 'insertDiagram' }> | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const editable = editor.isEditable;
  const chosen = chosenBlocks(editor.state);
  const closePaste = useCallback(() => setPasted(null), []);

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
        case 'insertVideo':
          setVideoDialog({ replacePos: req.replacePos });
          break;
        case 'embedLink':
          setLinkDialog(true);
          break;
        case 'pasteLink':
          setPasted({ pos: req.pos, url: req.url });
          break;
        case 'insertDiagram':
          setDiagramDialog(req);
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
    // select mode (Blocks board, J 55): the blocks step 32 px right, their checkboxes stand in the margin
    const host = hostRef.current;
    if (host) {
      if (selectMode) host.setAttribute('data-select-mode', '');
      else host.removeAttribute('data-select-mode');
    }
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
  }, [editor, tick, selectMode, cursorTop, layout, hostRef]);

  const firstChosenRect = (() => {
    if (!chosen.length) return null;
    const dom = editor.view.nodeDOM(chosen[0]);
    const layer = layerRef.current?.getBoundingClientRect();
    if (!(dom instanceof HTMLElement) || !layer) return null;
    const r = dom.getBoundingClientRect();
    return { top: r.top - layer.top, left: r.left - layer.left };
  })();

  const many = chosen.length;
  const selIcon = (d: string) => (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
  const commentChosen = () => {
    if (!onComment || many !== 1) return;
    const pos = chosen[0];
    clearChosenBlocks(editor);
    if (selectBlockText(editor, pos)) onComment();
  };
  // select mode (Blocks board, J 55): a dark bar on top with the count, a white bar of six actions at the bottom
  const selectBars =
    selectMode &&
    many > 0 &&
    editable &&
    createPortal(
      <>
        <div
          className="dk-sel-top"
          role="status"
          data-block-ui=""
          style={{
            top: (hostRef.current?.closest('[data-testid="editor-scroll"]')?.getBoundingClientRect().top ?? 56) + 8,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <strong>{many} selected</strong>
          <button type="button" aria-label="Clear the selection" onClick={() => clearChosenBlocks(editor)}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div
          className="dk-sel-bar"
          role="toolbar"
          aria-label={`${many} blocks`}
          data-block-ui=""
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" onClick={() => setMenu({ pos: chosen[0], anchor: null })}>
            {selIcon('M4 8h13l-3-3M20 16H7l3 3')}
            <span>Turn into</span>
          </button>
          <button type="button" onClick={() => duplicateBlocks(editor, chosen)}>
            {selIcon('M8 8h12v12H8zM16 8V4H4v12h4')}
            <span>Duplicate</span>
          </button>
          <button
            type="button"
            disabled={many !== 1}
            onClick={() => {
              const to = moveBlock(editor, chosen[0], -1);
              if (to != null) setChosenBlocks(editor, [to]);
            }}
          >
            {selIcon('M12 19V5M6 11l6-6 6 6')}
            <span>Up</span>
          </button>
          <button
            type="button"
            disabled={many !== 1}
            onClick={() => {
              const to = moveBlock(editor, chosen[0], 1);
              if (to != null) setChosenBlocks(editor, [to]);
            }}
          >
            {selIcon('M12 5v14M6 13l6 6 6-6')}
            <span>Down</span>
          </button>
          <button type="button" disabled={!onComment || many !== 1} onClick={commentChosen}>
            {selIcon('M4 5h16v11H9l-5 4z')}
            <span>Comment</span>
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              deleteBlocks(editor, chosen);
              clearChosenBlocks(editor);
            }}
          >
            {selIcon('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6')}
            <span>Delete</span>
          </button>
        </div>
      </>,
      document.body,
    );
  const bar = many > 0 && editable && !selectMode && (
    <div
      className={`dk-chosen-bar${layout === 'phone' ? ' dk-chosen-bar-bottom' : ''}`}
      role="toolbar"
      aria-label={`${many} blocks`}
      data-block-ui=""
      style={
        layout === 'phone' || !firstChosenRect
          ? undefined
          : { top: Math.max(0, firstChosenRect.top - 46), left: firstChosenRect.left }
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      <strong>{`${many} blocks`}</strong>
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
      {layout === 'desktop' && (
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
              style={{ top: r.top + 1, left: r.left - 32 }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleChosenBlock(editor, r.pos)}
            >
              {on && (
                <svg
                  aria-hidden="true"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12.5L10 17.5L19 7" />
                </svg>
              )}
            </button>
          );
        })}
      {bar}
      {selectBars}
      {imageDialog && (
        <InsertImageDialog
          editor={editor}
          projectId={projectId}
          replacePos={imageDialog.replacePos}
          limitMb={limitMb}
          onClose={() => setImageDialog(null)}
        />
      )}
      {videoDialog && (
        <InsertVideoDialog
          editor={editor}
          projectId={projectId}
          replacePos={videoDialog.replacePos}
          limitMb={limits.video}
          onClose={() => setVideoDialog(null)}
        />
      )}
      {linkDialog && <EmbedLinkDialog editor={editor} projectId={projectId} onClose={() => setLinkDialog(false)} />}
      {pasted && (
        <PasteLinkMenu editor={editor} projectId={projectId} pos={pasted.pos} url={pasted.url} onClose={closePaste} />
      )}
      {diagramDialog && (
        <InsertDiagramDialog
          editor={editor}
          projectId={projectId}
          replacePos={diagramDialog.replacePos}
          onNew={diagramDialog.onNew}
          onImport={diagramDialog.onImport}
          onClose={() => setDiagramDialog(null)}
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
