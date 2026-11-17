/**
 * The editor side of the block handle and menu: several blocks chosen at once (Shift+click on handles, the phone's
 * checkboxes), the keys that act on blocks (Ctrl+D duplicate, Alt+↑ / Alt+↓ move, Esc / Del on chosen blocks) and
 * the `openInsertCatalog` command (Ctrl+/ belongs to the ribbon's shortcut sheet, so it is not bound here). Its storage holds the bus the block layer listens on (bus.ts).
 */

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { BlockBus, type BlockKitStorage } from './bus';
import { blockAt, currentBlock, deleteBlocks, duplicateBlock, duplicateBlocks, moveBlock } from './commands';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockKit: {
      /** Opens the Insert catalog at the cursor: on an empty line in place, else on a new line below the block. */
      openInsertCatalog: () => ReturnType;
    };
  }
  interface Storage {
    blockKit: BlockKitStorage;
  }
}

/** The plugin key of the chosen-blocks state. */
export const blockSelectionKey = new PluginKey<number[]>('dkBlockSelection');

type SelMeta = { set: number[] } | { toggle: number } | { clear: true };

/** The positions of the chosen blocks, in document order (empty when none). */
export function chosenBlocks(state: EditorState): number[] {
  return blockSelectionKey.getState(state) ?? [];
}

/** Chooses exactly the blocks at `positions`. */
export function setChosenBlocks(editor: Editor, positions: number[]): void {
  editor.view.dispatch(editor.state.tr.setMeta(blockSelectionKey, { set: positions } satisfies SelMeta));
}

/** Adds the block at `pos` to the chosen ones, or takes it out. */
export function toggleChosenBlock(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setMeta(blockSelectionKey, { toggle: pos } satisfies SelMeta));
}

/** Chooses no block. */
export function clearChosenBlocks(editor: Editor): void {
  if (!chosenBlocks(editor.state).length) return;
  editor.view.dispatch(editor.state.tr.setMeta(blockSelectionKey, { clear: true } satisfies SelMeta));
}

/**
 * The blocks between two blocks of the same parent, both included (Shift+click on a second handle).
 * @returns Their positions, or just `b` when the two have different parents.
 */
export function blockRange(state: EditorState, a: number, b: number): number[] {
  const $a = state.doc.resolve(a);
  const $b = state.doc.resolve(b);
  if ($a.parent !== $b.parent || $a.depth !== $b.depth) return [b];
  const parent = $a.parent;
  const start = $a.start();
  const lo = Math.min($a.index(), $b.index());
  const hi = Math.max($a.index(), $b.index());
  const out: number[] = [];
  let pos = start;
  parent.forEach((child, offset, i) => {
    pos = start + offset;
    if (i >= lo && i <= hi) out.push(pos);
    void child;
  });
  return out;
}

function mapPositions(list: number[], tr: Transaction): number[] {
  const out: number[] = [];
  for (const p of list) {
    const r = tr.mapping.mapResult(p, 1);
    if (r.deleted) continue;
    if (tr.doc.nodeAt(r.pos)) out.push(r.pos);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Every block of the page (children of the document). */
function allTopBlocks(state: EditorState): number[] {
  const out: number[] = [];
  state.doc.forEach((_n, offset) => out.push(offset));
  return out;
}

/** The chosen blocks, the keys and Ctrl+/ (see the module comment). */
export const BlockKit = Extension.create<Record<string, never>, BlockKitStorage>({
  name: 'blockKit',

  addStorage() {
    return { bus: new BlockBus(), imageLimitMb: 10 };
  },

  addCommands() {
    return {
      openInsertCatalog:
        () =>
        ({ tr, dispatch, state }) => {
          const block = currentBlock(state);
          const { $from, empty } = state.selection;
          if (empty && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) {
            if (dispatch) tr.insertText('/', $from.pos);
            return true;
          }
          if (!block) return false;
          if (!dispatch) return true;
          const at = block.pos + block.node.nodeSize;
          const para = state.schema.nodes.paragraph.create(null, state.schema.text('/'));
          tr.insert(at, para);
          // the caret after the "/", so the catalog opens there
          tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView();
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    const onChosen = (fn: (positions: number[]) => boolean) => () => {
      const chosen = chosenBlocks(this.editor.state);
      return chosen.length ? fn(chosen) : false;
    };
    return {
      'Mod-d': () => {
        const chosen = chosenBlocks(this.editor.state);
        if (chosen.length) return duplicateBlocks(this.editor, chosen);
        const block = currentBlock(this.editor.state);
        return block ? duplicateBlock(this.editor, block.pos) !== null : false;
      },
      'Alt-ArrowUp': () => {
        const block = currentBlock(this.editor.state);
        if (!block) return false;
        const offset = this.editor.state.selection.from - block.pos;
        const to = moveBlock(this.editor, block.pos, -1);
        if (to !== null) this.editor.commands.setTextSelection(to + offset);
        return true;
      },
      'Alt-ArrowDown': () => {
        const block = currentBlock(this.editor.state);
        if (!block) return false;
        const offset = this.editor.state.selection.from - block.pos;
        const to = moveBlock(this.editor, block.pos, 1);
        if (to !== null) this.editor.commands.setTextSelection(to + offset);
        return true;
      },
      Escape: onChosen(() => {
        clearChosenBlocks(this.editor);
        return true;
      }),
      Delete: onChosen((p) => deleteBlocks(this.editor, p)),
      Backspace: onChosen((p) => deleteBlocks(this.editor, p)),
      'Mod-a': onChosen(() => {
        setChosenBlocks(this.editor, allTopBlocks(this.editor.state));
        return true;
      }),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<number[]>({
        key: blockSelectionKey,
        state: {
          init: () => [],
          apply: (tr, prev, _old, next) => {
            const meta = tr.getMeta(blockSelectionKey) as SelMeta | undefined;
            if (meta && 'clear' in meta) return [];
            if (meta && 'set' in meta)
              return [...new Set(meta.set)].filter((p) => !!next.doc.nodeAt(p)).sort((a, b) => a - b);
            if (meta && 'toggle' in meta) {
              const has = prev.includes(meta.toggle);
              const list = has ? prev.filter((p) => p !== meta.toggle) : [...prev, meta.toggle];
              return list.filter((p) => !!next.doc.nodeAt(p)).sort((a, b) => a - b);
            }
            if (!prev.length) return prev;
            // a click or a typed key elsewhere ends the choice; edits made on the chosen blocks keep it
            if (tr.selectionSet && !tr.docChanged) return [];
            return tr.docChanged ? mapPositions(prev, tr) : prev;
          },
        },
        props: {
          decorations: (state) => {
            const list = blockSelectionKey.getState(state) ?? [];
            if (!list.length) return null;
            const decos: Decoration[] = [];
            for (const p of list) {
              const node = state.doc.nodeAt(p);
              if (node) decos.push(Decoration.node(p, p + node.nodeSize, { class: 'dk-block-chosen' }));
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

/** The block at `pos` and every chosen block, for a menu opened on one of them. */
export function blocksForMenu(state: EditorState, pos: number): number[] {
  const chosen = chosenBlocks(state);
  if (chosen.includes(pos)) return chosen;
  const b = blockAt(state, pos);
  return b ? [b.pos] : [];
}
