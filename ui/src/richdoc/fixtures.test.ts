// @vitest-environment jsdom
/**
 * The shared fixtures of server/contract/richdoc/fixtures (README.md there): every Markdown input reads to its JSON,
 * every JSON writes its Markdown and its text, and writing again what was read gives the same Markdown. The server's
 * kb-richdoc reads the same files. `RICHDOC_WRITE=1 npx vitest run src/richdoc` writes them again.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalDoc, docToMarkdown, docToText, ensureBlockIds, markdownToDoc, seqIds } from '.';
import { Editor, type JSONContent } from '@tiptap/core';
import { buildExtensions } from '../components/docs/editor/extensions';

const ROOT = join(__dirname, '../../../server/contract/richdoc/fixtures');
const WRITE = !!process.env.RICHDOC_WRITE;

/** A file's text: the value and one final newline (nothing for an empty value). */
const file = (s: string) => (s === '' ? '' : `${s}\n`);
const json = (doc: JSONContent) => `${JSON.stringify(doc, null, 2)}\n`;

function check(path: string, actual: string) {
  if (WRITE) writeFileSync(path, actual);
  expect(existsSync(path), `${path} is missing (RICHDOC_WRITE=1 writes it)`).toBe(true);
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

/**
 * Inputs whose Markdown changes once more when read again: today's editor behaviour, kept (fixtures/README.md,
 * "Known lossy cases").
 */
const NOT_IDEMPOTENT = new Set([
  'code-fence-tilde', // a longer fence around a ``` fence is written with ```, so the inner fence closes it
  'html-inline', // `<not a tag>` is written `&lt;not a tag>`, which reads back as the text `<not a tag>`
  'lists-bullet', // two lists one after the other are written as one Markdown list
]);

/**
 * The editor's document without the empty paragraph it adds after a last block that is not a paragraph (StarterKit's
 * trailing node), when `input` has none.
 */
function withoutTrailer(out: JSONContent, input: JSONContent): JSONContent {
  const last = out.content?.[out.content.length - 1];
  const extra = (out.content?.length ?? 0) === (input.content?.length ?? 0) + 1;
  return extra && last?.type === 'paragraph' && !last.content ? { ...out, content: out.content!.slice(0, -1) } : out;
}

const names = (dir: string, ext: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(ext) && !f.endsWith(`.out${ext}`))
    .map((f) => f.slice(0, -ext.length))
    .sort();

describe('richdoc fixtures: md/', () => {
  for (const name of names('md', '.md')) {
    it(name, () => {
      const base = join(ROOT, 'md', name);
      const md = readFileSync(`${base}.md`, 'utf8');
      const doc = markdownToDoc(md, seqIds());
      check(`${base}.json`, json(doc));
      const out = docToMarkdown(doc);
      check(`${base}.out.md`, file(out));
      check(`${base}.txt`, file(docToText(doc)));
      const again = docToMarkdown(markdownToDoc(out, seqIds()));
      if (NOT_IDEMPOTENT.has(name)) expect(again).not.toBe(out);
      else expect(again).toBe(out);
    });
  }
});

describe('richdoc fixtures: json/', () => {
  const editor = new Editor({ extensions: buildExtensions({ isTicket: () => true, onLink: () => {} }) });
  for (const name of names('json', '.json')) {
    it(name, () => {
      const base = join(ROOT, 'json', name);
      const doc = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as JSONContent;
      // the inputs are canonical, with valid ids
      expect(canonicalDoc(doc)).toEqual(doc);
      expect(ensureBlockIds(doc, seqIds(0xf00000))).toEqual(doc);
      const out = docToMarkdown(doc);
      check(`${base}.out.md`, file(out));
      check(`${base}.txt`, file(docToText(doc)));
      // every attribute survives the editor, through JSON and through HTML (copy and paste)
      editor.commands.setContent(doc);
      expect(withoutTrailer(canonicalDoc(editor.getJSON()), doc)).toEqual(doc);
      editor.commands.setContent(editor.getHTML());
      expect(withoutTrailer(canonicalDoc(editor.getJSON()), doc)).toEqual(doc);
      // plain Markdown loses the rich parts, but what it keeps reads back stable after one more round
      const once = docToMarkdown(markdownToDoc(out, seqIds()));
      expect(docToMarkdown(markdownToDoc(once, seqIds()))).toBe(once);
    });
  }
});
