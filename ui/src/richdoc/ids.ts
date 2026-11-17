/**
 * Block ids of a rich document (server/contract/richdoc/README.md, "Block ids"): every node that is not inline, not
 * `text` and not `doc` carries `blockId` = `b-` + 6 lower-case hex digits, unique within the page. Pure helpers on
 * TipTap JSON; the editor plugin that keeps them unique while typing is in `blockId.ts`.
 */

import type { JSONContent } from '@tiptap/core';

/** The pattern of a valid block id. */
export const BLOCK_ID_RE = /^b-[0-9a-f]{6}$/;

/** Node types that are inline (or text), so carry no block id. */
export const INLINE_NODES: ReadonlySet<string> = new Set(['text', 'hardBreak', 'docRef', 'ticketRef', 'mathInline']);

/** Node types whose children are the page's top-level blocks (schema.json `topLevelParents`). */
export const TOP_LEVEL_PARENTS: ReadonlySet<string> = new Set(['doc', 'column']);

/** Makes a new block id. */
export type BlockIdGenerator = () => string;

/** A random id `b-xxxxxx` (crypto when the platform has it). */
export function randomBlockId(): string {
  const bytes = new Uint8Array(3);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 3; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `b-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A deterministic generator for tests and fixtures: `b-000001`, `b-000002`… (hexadecimal, so `b-00000a` follows
 * `b-000009`).
 * @param start - The first number handed out (default 1).
 */
export function seqIds(start = 1): BlockIdGenerator {
  let n = start;
  return () => {
    const id = `b-${n.toString(16).padStart(6, '0')}`;
    n += 1;
    return id;
  };
}

/** Whether a node of this type carries a block id. */
export function carriesBlockId(type: string | undefined): boolean {
  return !!type && type !== 'doc' && !INLINE_NODES.has(type);
}

/**
 * Give every block a valid, unique id: a missing, malformed or duplicated one is replaced (the first holder of a
 * duplicated id, in document order, keeps it). Pure: returns a new document and leaves `doc` as it is.
 * @param doc - A TipTap JSON document (or any node).
 * @param newId - Makes a new id; ids it returns that are already taken are skipped.
 */
export function ensureBlockIds(doc: JSONContent, newId: BlockIdGenerator = randomBlockId): JSONContent {
  const taken = new Set<string>();
  // first pass: valid ids, in document order; the first holder keeps a duplicate
  const keeps = new Set<JSONContent>();
  const collect = (node: JSONContent) => {
    const id = node.attrs?.blockId;
    if (carriesBlockId(node.type) && typeof id === 'string' && BLOCK_ID_RE.test(id) && !taken.has(id)) {
      taken.add(id);
      keeps.add(node);
    }
    node.content?.forEach(collect);
  };
  collect(doc);
  const fresh = () => {
    let id = newId();
    while (taken.has(id) || !BLOCK_ID_RE.test(id)) id = newId();
    taken.add(id);
    return id;
  };
  const walk = (node: JSONContent): JSONContent => {
    const out: JSONContent = { ...node };
    if (carriesBlockId(node.type) && !keeps.has(node)) out.attrs = { ...node.attrs, blockId: fresh() };
    if (node.content) out.content = node.content.map(walk);
    return out;
  };
  return walk(doc);
}

/** The document without any `blockId` attribute (an `attrs` left empty is dropped). Pure. */
export function stripBlockIds(doc: JSONContent): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    const out: JSONContent = { ...node };
    if (node.attrs && 'blockId' in node.attrs) {
      const { blockId: _drop, ...rest } = node.attrs;
      if (Object.keys(rest).length) out.attrs = rest;
      else delete out.attrs;
    }
    if (node.content) out.content = node.content.map(walk);
    return out;
  };
  return walk(doc);
}

/**
 * The top-level blocks of a page, in reading order: the children of `doc`, except that a `columns` block is
 * followed by the blocks of each of its columns (the `columns` block itself is listed too, before them).
 * @param doc - A TipTap JSON document.
 */
export function topLevelBlocks(doc: JSONContent): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (parent: JSONContent) => {
    for (const child of parent.content ?? []) {
      out.push(child);
      if (child.type === 'columns') for (const col of child.content ?? []) visit(col);
    }
  };
  visit(doc);
  return out;
}
