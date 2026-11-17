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
function Item({
  label,
  kbd,
  onClick,
  danger,
  disabled,
  children,
}: {
  label: string;
  kbd?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="dk-mi dk-bm-item"
      disabled={disabled}
      style={danger ? { color: '#C4432A' } : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span>{label}</span>
      {children}
      {kbd && <span className="dk-bm-kbd">{kbd}</span>}
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
          {(many || canTurnInto(node)) && <Item label="Turn into ›" onClick={() => setSub('turn')} />}
          {!many && isList && <Item label="List style ›" onClick={() => setSub('list')} />}
          {!many && props && (
            <Item label={node.type.name === 'image' ? 'Image properties…' : 'Properties…'} onClick={done(props)} />
          )}
          {!many &&
            chipsIn(node)
              .slice(0, 3)
              .map((c, i, list) => (
                <Item
                  key={`card-${i}`}
                  label={list.length === 1 ? 'Show as card' : `Show ${c.label} as card`}
                  onClick={done(() => chipToCard(editor, pos, i))}
                />
              ))}
          {!many && (node.type.name === 'pageCard' || node.type.name === 'ticketCard') && (
            <Item label="Show as chip" onClick={done(() => cardToChip(editor, pos))} />
          )}
          <span className="dk-bm-sep" />
          <Item label="Duplicate" kbd="Ctrl D" onClick={done(() => duplicateBlocks(editor, all))} />
          {!many && <Item label="Move up" kbd="Alt ↑" onClick={done(() => moveBlock(editor, pos, -1))} />}
          {!many && <Item label="Move down" kbd="Alt ↓" onClick={done(() => moveBlock(editor, pos, 1))} />}
          {!many && blockId && (
            <Item
              label="Copy link to block"
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
            <Item label="Teams cannot change this" onClick={done(() => lock.toggle(blockId))}>
              <span className="dk-bm-kbd" data-testid="block-lock-state">
                {lock.locked.includes(blockId) ? '✓ On' : 'Off'}
              </span>
            </Item>
          )}
          {!many && onComment && (
            <Item
              label="Comment"
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
              onClick={done(() => askBlockUi(editor, { type: 'selectBlocks', pos }))}
            />
          )}
          <span className="dk-bm-sep" />
          <Item
            label="Delete"
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
  const width = sub === 'list' ? 300 : 240;
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
