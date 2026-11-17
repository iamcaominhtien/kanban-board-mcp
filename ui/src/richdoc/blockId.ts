/**
 * The `blockId` attribute on every block of the Docs editor, and the plugin that keeps the ids valid and unique as
 * the page is edited: a block that is new, split off, pasted or duplicated gets a fresh id, while the block it came
 * from keeps its own (server/contract/richdoc/README.md, "Block ids").
 */

import { Extension, callOrReturn, getExtensionField, type AnyExtension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { AttrStep } from '@tiptap/pm/transform';
import { BLOCK_ID_RE, randomBlockId, type BlockIdGenerator } from './ids';

/** Options of {@link BlockId}. */
export interface BlockIdOptions {
  /** Makes a new id (random by default; tests pass `seqIds()`). */
  generate: BlockIdGenerator;
}

const key = new PluginKey('richdocBlockId');

/** Node extensions that carry a block id: not `doc`, not `text`, not inline. */
function blockTypes(extensions: AnyExtension[]): string[] {
  return extensions
    .filter((ext) => ext.type === 'node' && ext.name !== 'doc' && ext.name !== 'text')
    .filter((ext) => {
      const ctx = { name: ext.name, options: ext.options, storage: ext.storage } as never;
      const inline = callOrReturn(getExtensionField<unknown>(ext, 'inline', ctx));
      const group = callOrReturn(getExtensionField<unknown>(ext, 'group', ctx));
      return !inline && !(typeof group === 'string' ? group : '').split(' ').includes('inline');
    })
    .map((ext) => ext.name);
}

/**
 * Fix the ids of `doc` in one transaction, or return null when they are all fine. When an id is held twice, the
 * holder at `keepers().get(id)` (where the block that had it before the change ended up) keeps it, else the first
 * one; `keepers` is only called when there is a duplicate.
 */
function fixIds(
  doc: PMNode,
  tr: Transaction,
  generate: BlockIdGenerator,
  keepers: () => Map<string, number>,
): Transaction | null {
  const holders = new Map<string, number[]>();
  const bad: number[] = [];
  doc.descendants((node, pos) => {
    if (!('blockId' in node.attrs)) return;
    const id = node.attrs.blockId as unknown;
    if (typeof id === 'string' && BLOCK_ID_RE.test(id)) {
      const list = holders.get(id);
      if (list) list.push(pos);
      else holders.set(id, [pos]);
    } else bad.push(pos);
  });
  let moved: Map<string, number> | null = null;
  for (const [id, list] of holders) {
    if (list.length < 2) continue;
    moved ??= keepers();
    const keep = moved.get(id);
    const owner = keep !== undefined && list.includes(keep) ? keep : list[0];
    bad.push(...list.filter((p) => p !== owner));
  }
  if (!bad.length) return null;
  const fresh = () => {
    let id = generate();
    while (holders.has(id) || !BLOCK_ID_RE.test(id)) id = generate();
    holders.set(id, []);
    return id;
  };
  bad.sort((a, b) => a - b);
  // maybeStep: a block the schema does not allow where it is (an image inside a paragraph, which the Markdown
  // reader can make) cannot be changed; it keeps no id rather than failing the edit
  for (const pos of bad) tr.maybeStep(new AttrStep(pos, 'blockId', fresh()));
  return tr.docChanged ? tr : null;
}

/**
 * Adds the global `blockId` attribute (rendered as `data-block-id`, not kept on split) to every block node type, and
 * gives blocks without a valid, unique id a fresh one after each change of the document.
 */
export const BlockId = Extension.create<BlockIdOptions>({
  name: 'richdocBlockId',

  addOptions() {
    return { generate: randomBlockId };
  },

  addGlobalAttributes() {
    return [
      {
        types: blockTypes(this.extensions),
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => {
              const id = el.getAttribute('data-block-id');
              return id && BLOCK_ID_RE.test(id) ? id : null;
            },
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    const generate = this.options.generate;
    return [
      new Plugin({
        key,
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((t) => t.docChanged)) return null;
          // where each id of the old document is now: its block keeps the id against a pasted copy
          const keepers = () => {
            const out = new Map<string, number>();
            oldState.doc.descendants((node, pos) => {
              const id = node.attrs.blockId as unknown;
              if (typeof id !== 'string' || out.has(id)) return;
              let mapped: number | null = pos;
              for (const t of transactions) {
                const r = t.mapping.mapResult(mapped, 1);
                if (r.deleted) {
                  mapped = null;
                  break;
                }
                mapped = r.pos;
              }
              if (mapped !== null) out.set(id, mapped);
            });
            return out;
          };
          return fixIds(newState.doc, newState.tr, generate, keepers);
        },
      }),
    ];
  },
});
