/**
 * Rich Docs format 1 on the UI side (server/contract/richdoc/README.md): conversion between the page JSON and the
 * plain Markdown flavour, the plain-text projection, and block ids. Works without a mounted editor: the Markdown
 * side runs on one headless TipTap editor built with the Docs editor's own extensions, so it reads and writes
 * exactly what the editor does.
 */

import { Editor, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { buildExtensions } from '../components/docs/editor/extensions';
import { compactMarkdown } from '../components/docs/editor/compactMarkdown';
import { cleanEditorMarkdown } from '../utils/docsMarkdown';
import { ensureBlockIds, randomBlockId, stripBlockIds, type BlockIdGenerator } from './ids';

export {
  BLOCK_ID_RE,
  carriesBlockId,
  ensureBlockIds,
  randomBlockId,
  seqIds,
  stripBlockIds,
  topLevelBlocks,
  type BlockIdGenerator,
} from './ids';
export { docToText } from './text';

/** The format version of schema.json. */
export const FORMAT_VERSION = 1;

/** The order of marks on a text node in canonical JSON (schema.json `marks`). */
export const MARK_ORDER = [
  'bold',
  'italic',
  'strike',
  'code',
  'underline',
  'superscript',
  'subscript',
  'link',
  'highlight',
  'textStyle',
] as const;

let shared: Editor | null = null;

/** The headless editor the conversions run on (made on first use). */
function converter(): Editor {
  if (!shared || shared.isDestroyed) {
    shared = new Editor({ extensions: buildExtensions({ isTicket: () => true, onLink: () => {} }) });
  }
  return shared;
}

/** The ProseMirror schema of the Docs editor (for checks against schema.json). */
export function editorSchema(): Schema {
  return converter().schema;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function canonicalAttrs(
  attrs: Record<string, unknown> | undefined,
  spec: Record<string, { default?: unknown }> | undefined,
): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const keys = Object.keys(attrs)
    .filter((k) => attrs[k] !== undefined && !(spec?.[k] && 'default' in spec[k] && same(attrs[k], spec[k].default)))
    .sort();
  return keys.length ? Object.fromEntries(keys.map((k) => [k, attrs[k]])) : undefined;
}

/**
 * The canonical form of a page JSON, which the fixtures hold and the server reproduces: attributes at their schema
 * default are left out (an empty `attrs` too), attribute keys are sorted, marks follow {@link MARK_ORDER}, and the
 * keys of a node come in the order `type`, `attrs`, `content`, `marks`, `text`. Pure.
 * @param doc - A TipTap JSON document (or node).
 */
export function canonicalDoc(doc: JSONContent): JSONContent {
  const schema = editorSchema();
  const markRank = (t: string) => {
    const i = (MARK_ORDER as readonly string[]).indexOf(t);
    return i < 0 ? MARK_ORDER.length : i;
  };
  const walk = (node: JSONContent): JSONContent => {
    const out: JSONContent = { type: node.type };
    const spec = node.type ? schema.nodes[node.type]?.spec.attrs : undefined;
    const attrs = canonicalAttrs(node.attrs, spec as never);
    if (attrs) out.attrs = attrs;
    if (node.content?.length) out.content = node.content.map(walk);
    if (node.marks?.length) {
      out.marks = [...node.marks]
        .sort((a, b) => markRank(a.type) - markRank(b.type))
        .map((m) => {
          const ma = canonicalAttrs(m.attrs, schema.marks[m.type]?.spec.attrs as never);
          return ma ? { type: m.type, attrs: ma } : { type: m.type };
        });
    }
    if (node.text !== undefined) out.text = node.text;
    return out;
  };
  return walk(doc);
}

/**
 * Read plain Markdown (the editor's flavour) into a page: what the Docs editor makes of it, in canonical form, with
 * a block id on every block.
 * @param md - Plain Markdown.
 * @param newId - Makes the block ids (random by default; `seqIds()` for fixtures).
 */
export function markdownToDoc(md: string, newId: BlockIdGenerator = randomBlockId): JSONContent {
  const ed = converter();
  ed.commands.setContent(md, { contentType: 'markdown', emitUpdate: false });
  return canonicalDoc(ensureBlockIds(stripBlockIds(ed.getJSON()), newId));
}

/**
 * Write a page as plain Markdown, exactly as the Docs editor stores it today
 * (`compactMarkdown(cleanEditorMarkdown(getMarkdown()))`), without a final newline.
 * @param doc - A TipTap JSON document.
 */
export function docToMarkdown(doc: JSONContent): string {
  const ed = converter();
  ed.commands.setContent(doc, { emitUpdate: false });
  return compactMarkdown(cleanEditorMarkdown(ed.getMarkdown()));
}
