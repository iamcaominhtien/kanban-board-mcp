/**
 * The block menu (board J 53, 54, 64): opened from a block's handle (or a long press on a phone). Turn into, the
 * list's style, the block's properties, Duplicate, Move up / down, Copy link to block, Comment, Select several
 * blocks (touch) and Delete. With several blocks chosen it acts on all of them.
 */

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useToast } from '../../../Toast';
import { askBlockUi } from './bus';
import { blocksForMenu, clearChosenBlocks } from './BlockKit';
import {
  BULLET_STYLES,
  NUMBER_STYLES,
  TURN_INTO,
  blockLabel,
  blockLink,
  canTurnInto,
  deleteBlocks,
  duplicateBlocks,
  moveBlock,
  setNodeAttrs,
  turnInto,
  type TurnIntoKind,
} from './commands';
import { cardToChip, chipToCard, chipsIn } from './refCards';
import { Row, Seg, useBlockLayout, useCoarsePointer } from './ui';
import { useEditorTick } from './useInside';
import { useBlockLock } from '../../suggestions/pageAi';
import { WHOLE_COMMENT_BLOCKS } from '../../comments/blockAnchor';

const LISTS = ['bulletList', 'orderedList', 'taskList'];

/** Puts the caret at the start of the first text inside the block at `pos`. */
function caretInto(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const sel = node.isAtom
    ? NodeSelection.create(editor.state.doc, pos)
    : TextSelection.near(editor.state.doc.resolve(pos + 1));
  editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
  editor.view.focus();
}

/** Selects the text of the first text block inside the block at `pos` (a comment attaches to it). */
function selectBlockText(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  let range: { from: number; to: number } | null = null;
  node.descendants((child, offset) => {
    if (range) return false;
    if (child.isTextblock && child.content.size > 0) {
      const start = pos + 1 + offset + 1;
      range = { from: start, to: start + child.content.size };
      return false;
    }
    return true;
  });
  if (node.isTextblock && node.content.size > 0) range = { from: pos + 1, to: pos + 1 + node.content.size };
  if (!range) return false;
  const r = range as { from: number; to: number };
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, r.from, r.to)));
  editor.view.focus();
  return true;
}

/** One row of the menu. */
/** The row icons of the block menu (Blocks board, frames 53, 54 and 64): 24 px view box, drawn in strokes. */
const BM_ICONS = {
  turn: <path d="M4 8h14l-3-3M20 16H6l3 3" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  props: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4" />,
  card: <path d="M4 6h16v12H4zM8 10h8M8 14h5" />,
  duplicate: (
    <>
      <rect height="12" rx="2" width="12" x="8" y="8" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  lock: <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />,
  comment: <path d="M4 5h16v11H9l-5 4z" />,
  select: (
    <>
      <rect height="5" rx="1" width="5" x="3.5" y="4" />
      <path d="M4.5 6.5l1.2 1.2 2-2.4M12 6h8M12 12h8M12 18h8" />
      <rect height="5" rx="1" width="5" x="3.5" y="10" />
      <rect height="5" rx="1" width="5" x="3.5" y="16" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
} as const;

type BmIcon = keyof typeof BM_ICONS;

function Item({
  label,
  kbd,
  onClick,
  danger,
  disabled,
  icon,
  more,
  children,
}: {
  label: string;
  kbd?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** The row's icon (a cell of its own, so the labels line up). */
  icon?: BmIcon;
  /** The row opens a second list: a chevron at its end. */
  more?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`dk-mi dk-bm-item${danger ? ' dk-bm-danger' : ''}`}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon && (
        <span className="dk-bm-ico" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {BM_ICONS[icon]}
          </svg>
        </span>
      )}
      <span className="dk-bm-label">{label}</span>
      {children}
      {kbd && <span className="dk-bm-kbd">{kbd}</span>}
      {more && (
        <svg
          className="dk-bm-more"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      )}
    </button>
  );
}

/** The list settings of a list block: type, marker, start number. */
function ListStyle({ editor, pos, node }: { editor: Editor; pos: number; node: PMNode }) {
  const type = node.type.name;
  const set = (a: Record<string, unknown>) => setNodeAttrs(editor, pos, a);
  return (
    <div
      className="dk-bm-list"
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <Row label="Type">
        <Seg
          label="List type"
          value={type}
          onChange={(v) => turnInto(editor, pos, v as TurnIntoKind)}
          options={[
            { value: 'bulletList', label: 'Bullets' },
            { value: 'orderedList', label: 'Numbers' },
            { value: 'taskList', label: 'Task list' },
          ]}
        />
      </Row>
      {type !== 'taskList' && (
        <Row label="Marker">
          <Seg
            label="Marker"
            wrap
            value={(node.attrs.listStyle as string | null) ?? null}
            onChange={(v) => set({ listStyle: v })}
            options={(type === 'orderedList' ? NUMBER_STYLES : BULLET_STYLES).map((s) => ({
              value: s.value as string | null,
              label: s.sample,
              title: s.label,
            }))}
          />
        </Row>
      )}
      {type === 'orderedList' && (
        <Row label="Start at">
          <input
            className="dk-bp-input"
            type="number"
            aria-label="Start at"
            min={0}
            style={{ width: 80 }}
            value={typeof node.attrs.start === 'number' ? node.attrs.start : 1}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) set({ start: Math.round(n) });
            }}
          />
        </Row>
      )}
      <div className="dk-bp-row-inline">
        <button
          type="button"
          className="dk-btn-ghost"
          onClick={() => {
            caretInto(editor, pos);
            editor
              .chain()
              .focus()
              .sinkListItem(type === 'taskList' ? 'taskItem' : 'listItem')
              .run();
          }}
        >
          Indent
        </button>
        <button
          type="button"
          className="dk-btn-ghost"
          onClick={() => {
            caretInto(editor, pos);
            editor
              .chain()
              .focus()
              .liftListItem(type === 'taskList' ? 'taskItem' : 'listItem')
              .run();
          }}
        >
          Outdent
        </button>
      </div>
      <p className="dk-bp-note">Tab and Shift+Tab do the same. Lists nest up to six levels.</p>
    </div>
  );
}

/**
 * The menu for the block at `pos`.
 * @param props.anchor - The handle's rect (the menu opens beside it); null opens it as a sheet.
 * @param props.onComment - Starts a comment on the selected text; unset hides Comment.
 */
export function BlockMenu({
  editor,
  pos,
  anchor,
  onClose,
  onComment,
}: {
  editor: Editor;
  pos: number;
  anchor: DOMRect | null;
  onClose: () => void;
  onComment?: () => void;
}) {
  const toast = useToast();
  const lock = useBlockLock();
  const layout = useBlockLayout();
  const coarse = useCoarsePointer();
  const [sub, setSub] = useState<'turn' | 'list' | null>(null);
  useEditorTick(editor);
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef(onClose);
  live.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        live.current();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Element)) live.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, []);

  const node = editor.state.doc.nodeAt(pos);
  if (!node) return null;
  const all = blocksForMenu(editor.state, pos);
  const many = all.length > 1;
  const done = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const isList = LISTS.includes(node.type.name);
  const blockId = typeof node.attrs.blockId === 'string' ? node.attrs.blockId : null;
  const props = (() => {
    switch (node.type.name) {
      case 'image':
        return () => askBlockUi(editor, { type: 'imageProps', pos });
      case 'columns':
      case 'table':
      case 'callout':
      case 'blockquote':
      case 'pullQuote':
      case 'horizontalRule':
        return () => caretInto(editor, pos);
      default:
        return null;
    }
  })();

  const turn = (kind: TurnIntoKind) => {
    // last first, so the positions of the earlier blocks stay right
    for (const p of [...all].sort((a, b) => b - a)) turnInto(editor, p, kind);
    clearChosenBlocks(editor);
  };

  const body = (
    <>
      <div className="dk-bm-head">{many ? `${all.length} blocks` : blockLabel(node)}</div>
      {sub === 'turn' ? (
        <div role="menu" aria-label="Turn into">
          <Item label="‹ Back" onClick={() => setSub(null)} />
          {TURN_INTO.map((t) => (
            <Item key={t.id} label={t.label} onClick={done(() => turn(t.id))}>
              <span className="dk-bm-tile" aria-hidden="true">
                {t.tile}
              </span>
            </Item>
          ))}
        </div>
      ) : sub === 'list' ? (
        <div role="menu" aria-label="List">
          <Item label="‹ Back" onClick={() => setSub(null)} />
          <ListStyle editor={editor} pos={pos} node={node} />
        </div>
      ) : (
        <div role="menu" aria-label="Block">
          {(many || canTurnInto(node)) && <Item label="Turn into" icon="turn" more onClick={() => setSub('turn')} />}
          {!many && isList && <Item label="List style" icon="list" more onClick={() => setSub('list')} />}
          {!many && props && (
            <Item
              label={node.type.name === 'image' ? 'Image properties…' : 'Properties…'}
              icon="props"
              onClick={done(props)}
            />
          )}
          {!many &&
            chipsIn(node)
              .slice(0, 3)
              .map((c, i, list) => (
                <Item
                  key={`card-${i}`}
                  label={list.length === 1 ? 'Show as card' : `Show ${c.label} as card`}
                  icon="card"
                  onClick={done(() => chipToCard(editor, pos, i))}
                />
              ))}
          {!many && (node.type.name === 'pageCard' || node.type.name === 'ticketCard') && (
            <Item label="Show as chip" icon="card" onClick={done(() => cardToChip(editor, pos))} />
          )}
          <span className="dk-bm-sep" />
          <Item label="Duplicate" icon="duplicate" kbd="Ctrl D" onClick={done(() => duplicateBlocks(editor, all))} />
          {!many && <Item label="Move up" icon="up" kbd="Alt ↑" onClick={done(() => moveBlock(editor, pos, -1))} />}
          {!many && <Item label="Move down" icon="down" kbd="Alt ↓" onClick={done(() => moveBlock(editor, pos, 1))} />}
          {!many && blockId && (
            <Item
              label="Copy link to block"
              icon="link"
              onClick={done(() => {
                const link = blockLink(window.location.href, blockId);
                void navigator.clipboard
                  ?.writeText(link)
                  .then(() => toast.success('Link copied', 'It opens this page at this block.'))
                  .catch(() => toast.error('Could not copy the link', link));
              })}
            />
          )}
          {!many && blockId && lock && (
            <Item label="Teams cannot change this" icon="lock" onClick={done(() => lock.toggle(blockId))}>
              <span className="dk-bm-kbd" data-testid="block-lock-state">
                {lock.locked.includes(blockId) ? '✓ On' : 'Off'}
              </span>
            </Item>
          )}
          {!many && onComment && (
            <Item
              label="Comment"
              icon="comment"
              kbd="Ctrl Alt M"
              onClick={done(() => {
                // an image, a table or an embed is commented on as a whole
                const node = editor.state.doc.nodeAt(pos);
                if (node && WHOLE_COMMENT_BLOCKS.has(node.type.name)) {
                  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
                  onComment();
                } else if (selectBlockText(editor, pos)) onComment();
                else toast.error('Nothing to comment on', 'A comment attaches to text inside a block.');
              })}
            />
          )}
          {(coarse || layout === 'phone') && !many && (
            <Item
              label="Select several blocks"
              icon="select"
              onClick={done(() => askBlockUi(editor, { type: 'selectBlocks', pos }))}
            />
          )}
          <span className="dk-bm-sep" />
          <Item
            label="Delete"
            icon="trash"
            kbd="Del"
            danger
            onClick={done(() => {
              deleteBlocks(editor, all);
              clearChosenBlocks(editor);
            })}
          />
        </div>
      )}
    </>
  );

  if (layout === 'phone' || !anchor) {
    return (
      <div className="dk-bp-overlay" data-block-ui="">
        <div className="dk-bp-scrim" />
        <div ref={ref} className="dk-bp dk-bp-sheet dk-bm dk-bm-touch" data-testid="block-menu">
          <div className="dk-bp-grab" aria-hidden="true" />
          {body}
        </div>
      </div>
    );
  }
  const width = sub === 'list' ? 330 : layout === 'tablet' || coarse ? 270 : 240;
  const left = Math.max(8, Math.min(anchor.right + 6, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 420));
  return (
    <div
      ref={ref}
      className={`dk-menu dk-bm${layout === 'tablet' || coarse ? ' dk-bm-touch' : ''}`}
      data-testid="block-menu"
      data-block-ui=""
      style={{ position: 'fixed', top, left, width, zIndex: 70 }}
    >
      {body}
    </div>
  );
}
