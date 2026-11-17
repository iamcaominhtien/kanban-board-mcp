/**
 * Word, HTML and pasted text into a rich page, in the browser (design "Starting and shaping a page", E and G):
 * a Word file goes to HTML with `mammoth`; HTML is cleaned (scripts, styles, forms and frames out; an embedded frame or
 * video becomes a link), its `data:` pictures are uploaded to the project, and the Docs editor's own schema reads it
 * (`generateJSON`). The page is then created and its draft saved as rich JSON. Markdown files keep the server's
 * import route (folders, [[links]] resolved by title); a pasted Markdown text is read like the editor reads it.
 */

import { generateJSON, type JSONContent } from '@tiptap/core';
import { client } from '../../../api/client';
import { uploadDocsFile } from '../embeds/embedApi';
import { uploadedSrc } from '../editor/blocks/imageUpload';
import { buildExtensions } from '../editor/extensions';
import { canonicalDoc, ensureBlockIds, markdownToDoc, randomBlockId, stripBlockIds } from '../../../richdoc';
import type { DocsPage } from '../../../types/docs';

/** Where imported pages come from (the four tiles of the dialog). */
export type ImportSource = 'markdown' | 'word' | 'html' | 'paste';

/** The largest file the import reads (20 MB); a larger one is refused before it is read. */
export const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** The kind of file a name says it is, or `null` for a file the import does not take. */
export function sourceOfFile(name: string): Exclude<ImportSource, 'paste'> | null {
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.docx$/i.test(name)) return 'word';
  if (/\.html?$/i.test(name)) return 'html';
  return null;
}

/**
 * The source a set of chosen or dropped files opens on: Markdown when they are all Markdown (or there are none),
 * otherwise the first Word or HTML file's.
 */
export function sourceForFiles(files: { name: string }[]): Exclude<ImportSource, 'paste'> {
  const kinds = files.map((f) => sourceOfFile(f.name));
  if (kinds.every((k) => k === 'markdown' || k === null)) return 'markdown';
  return kinds.find((k): k is 'word' | 'html' => k === 'word' || k === 'html') ?? 'markdown';
}

/** Why a chosen file cannot be imported. */
export interface FileProblem {
  code: 'unsupported' | 'too_large' | 'markdown';
  /** The short state on the file's row. */
  title: string;
  /** What to do about it. */
  text: string;
}

const EXPORT_HINT: Record<string, string> = {
  pages: 'Export it from Pages as Word (.docx) and import that.',
  doc: 'Save it as .docx in Word and import that.',
  odt: 'Save it as Word (.docx) and import that.',
  rtf: 'Save it as Word (.docx) and import that.',
  pdf: 'Copy its text and use Paste instead.',
  txt: 'Open it and use Paste instead.',
};

/**
 * What is wrong with a file before it is read, if anything.
 * @param file - Its name and size (bytes).
 */
export function fileProblem(file: { name: string; size: number }): FileProblem | null {
  const kind = sourceOfFile(file.name);
  if (!kind) {
    const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
    return {
      code: 'unsupported',
      title: 'Not supported',
      text: EXPORT_HINT[ext] ?? 'Import takes .md, .markdown, .docx, .html and .htm files.',
    };
  }
  if (kind === 'markdown')
    return { code: 'markdown', title: 'Markdown', text: 'Markdown files come in through the Markdown tile.' };
  if (file.size > IMPORT_FILE_MAX_BYTES)
    return {
      code: 'too_large',
      title: 'Too large',
      text: 'Over the 20 MB limit. Take the pictures out or split the file, then add it again.',
    };
  return null;
}

/** "48 KB", "2.1 MB". */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A file the import could not read, with the reason the person sees. */
export class ImportError extends Error {}

/** The first bytes of an OLE compound file: a password-protected .docx (or an old .doc) is one. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * A Word file as HTML (`mammoth`, loaded the first time a Word file is imported). Pictures come as `data:` URIs.
 * @param file - The .docx file.
 * @returns The HTML and mammoth's warnings.
 * @throws {ImportError} The file is password-protected or is not a Word file.
 */
export async function docxToHtml(file: Blob): Promise<{ html: string; warnings: string[] }> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  if (OLE.every((b, i) => head[i] === b))
    throw new ImportError('This file is password-protected. Remove the password and try again.');
  const mammoth = (await import('mammoth')).default;
  try {
    const res = await mammoth.convertToHtml({ arrayBuffer: buf });
    return { html: res.value, warnings: res.messages.map((m) => m.message) };
  } catch {
    throw new ImportError('This file could not be read as a Word file. Open it in Word, save it again and retry.');
  }
}

/** Elements dropped with everything in them. */
const DROP =
  'script, style, link, meta, noscript, template, form, input, button, select, textarea, object, embed, frameset';

/**
 * Cleans HTML for the editor: scripts, styles, forms and frames are removed, an `<iframe>` or `<video>` becomes a link
 * to what it showed, `on…`, `class` and `id` attributes go. Only the `<body>` is kept.
 * @param html - A whole HTML file or a fragment.
 * @returns The cleaned document (read its `body`) and its `<title>`, if it has one.
 */
export function cleanHtml(html: string): { dom: Document; title: string | null } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim() || null;
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  doc.querySelectorAll('iframe, frame, video, audio').forEach((el) => {
    const src = el.getAttribute('src') ?? el.querySelector('source')?.getAttribute('src') ?? '';
    if (/^https?:\/\//i.test(src)) {
      const p = doc.createElement('p');
      const a = doc.createElement('a');
      a.href = src;
      a.textContent = src;
      p.appendChild(a);
      el.replaceWith(p);
    } else el.remove();
  });
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'class' || n === 'id') el.removeAttribute(attr.name);
      if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  return { dom: doc, title };
}

/** Uploads a picture taken out of a file; returns where the page should point, or throws. */
export type PictureUpload = (file: File) => Promise<string>;

/** Uploads to the project's Docs uploads (kind `image`). */
export function projectPictureUpload(projectId: string): PictureUpload {
  return async (file) => uploadedSrc((await uploadDocsFile(projectId, file, 'image')).src);
}

function dataUriFile(uri: string, i: number): File | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1];
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let k = 0; k < raw.length; k++) bytes[k] = raw.charCodeAt(k);
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
  return new File([bytes], `picture-${i + 1}.${ext}`, { type: mime });
}

let extensions: ReturnType<typeof buildExtensions> | null = null;
const editorExtensions = () => (extensions ??= buildExtensions({ isTicket: () => true, onLink: () => {} }));

/** A page read from a file or from the clipboard. */
export interface ConvertedPage {
  /** The rich page, with a block id on every block. */
  doc: JSONContent;
  /** The title the file gives (its first heading 1, or its `<title>`), or `null`. */
  title: string | null;
  /** Pictures that could not be kept (the upload failed or the picture was unreadable). */
  droppedPictures: number;
}

function textOf(node: JSONContent): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

/** Takes a leading heading 1 off a page as its title (the page title is not a block of the page). */
function liftTitle(doc: JSONContent): { doc: JSONContent; title: string | null } {
  const first = doc.content?.[0];
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    const title = textOf(first).trim();
    const rest = doc.content!.slice(1);
    return { doc: { ...doc, content: rest.length ? rest : [{ type: 'paragraph' }] }, title: title || null };
  }
  return { doc, title: null };
}

const finish = (json: JSONContent) => canonicalDoc(ensureBlockIds(stripBlockIds(json), randomBlockId));

/**
 * HTML into a rich page: cleaned ({@link cleanHtml}), `data:` pictures uploaded (or dropped when that fails), then
 * read with the Docs editor's schema.
 * @param html - The HTML (a file, Word's conversion or a paste).
 * @param upload - Uploads a picture; leave out to drop `data:` pictures.
 */
export async function htmlToDoc(html: string, upload?: PictureUpload): Promise<ConvertedPage> {
  const { dom, title: docTitle } = cleanHtml(html);
  let dropped = 0;
  const imgs = Array.from(dom.body.querySelectorAll('img'));
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('data:')) continue;
    const file = upload ? dataUriFile(src, i) : null;
    try {
      if (!file || !upload) throw new Error('no upload');
      img.setAttribute('src', await upload(file));
    } catch {
      img.remove();
      dropped += 1;
    }
  }
  const json = generateJSON(dom.body.innerHTML, editorExtensions());
  const lifted = liftTitle(json);
  return { doc: finish(lifted.doc), title: lifted.title ?? docTitle, droppedPictures: dropped };
}

/** What a pasted text looks like. */
export type PasteKind = 'html' | 'markdown' | 'text';

/** Guesses what a pasted text is: HTML when it has tags, Markdown when it has Markdown marks, plain text otherwise. */
export function guessPaste(text: string): PasteKind {
  const t = text.trim();
  if (!t) return 'text';
  if (/<(html|body|p|div|h[1-6]|ul|ol|li|table|b|strong|em|i|a|br|span|img|pre|blockquote)\b[^>]*>/i.test(t))
    return 'html';
  if (
    /^#{1,6}\s+\S/m.test(t) ||
    /^\s*([-*+]|\d+\.)\s+\S/m.test(t) ||
    /\*\*[^*]+\*\*|__[^_]+__/.test(t) ||
    /^```/m.test(t) ||
    /\[[^\]]+\]\([^)]+\)/.test(t) ||
    /^\s*>\s+\S/m.test(t) ||
    /^\|.+\|\s*$/m.test(t)
  )
    return 'markdown';
  return 'text';
}

/** "headings, list and bold found": what a paste holds, for the line under the paste box. */
export function pasteFindings(text: string, kind: PasteKind): string[] {
  const found: string[] = [];
  if (kind === 'html') {
    if (/<h[1-6]\b/i.test(text)) found.push('headings');
    if (/<(ul|ol)\b/i.test(text)) found.push('list');
    if (/<table\b/i.test(text)) found.push('table');
    if (/<(b|strong)\b/i.test(text)) found.push('bold');
    if (/<a\b/i.test(text)) found.push('links');
    if (/<img\b/i.test(text)) found.push('pictures');
  } else if (kind === 'markdown') {
    if (/^#{1,6}\s/m.test(text)) found.push('headings');
    if (/^\s*([-*+]|\d+\.)\s/m.test(text)) found.push('list');
    if (/^\|.+\|\s*$/m.test(text)) found.push('table');
    if (/\*\*[^*]+\*\*/.test(text)) found.push('bold');
    if (/\[[^\]]+\]\([^)]+\)/.test(text)) found.push('links');
  }
  return found;
}

/** "headings, list and bold". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * A pasted text into a rich page.
 * @param text - What was pasted.
 * @param kind - How to read it (the guess, or what the person switched it to).
 * @param upload - Uploads pictures of pasted HTML.
 */
export async function pasteToDoc(text: string, kind: PasteKind, upload?: PictureUpload): Promise<ConvertedPage> {
  if (kind === 'html') return htmlToDoc(text, upload);
  if (kind === 'markdown') {
    const lifted = liftTitle(markdownToDoc(text));
    return { doc: lifted.doc, title: lifted.title, droppedPictures: 0 };
  }
  const paras = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const lines = p.split('\n');
      const content: JSONContent[] = [];
      lines.forEach((l, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        if (l) content.push({ type: 'text', text: l });
      });
      return { type: 'paragraph', content } as JSONContent;
    });
  return {
    doc: finish({ type: 'doc', content: paras.length ? paras : [{ type: 'paragraph' }] }),
    title: null,
    droppedPictures: 0,
  };
}

/**
 * Reads one Word or HTML file into a page.
 * @param file - The file.
 * @param upload - Uploads its pictures.
 * @throws {ImportError} The file cannot be read.
 */
export async function fileToDoc(file: File, upload?: PictureUpload): Promise<ConvertedPage> {
  const kind = sourceOfFile(file.name);
  if (kind === 'word') {
    const { html } = await docxToHtml(file);
    return htmlToDoc(html, upload);
  }
  if (kind === 'html') return htmlToDoc(await file.text(), upload);
  throw new ImportError('Import takes .docx, .html and .htm files here.');
}

/** The file name without its folder and extension, as a title. */
export function titleFromName(name: string): string {
  const base = name.split('/').pop() ?? name;
  return (
    base
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]+/g, ' ')
      .trim() || 'Imported page'
  );
}

/**
 * Creates a page and saves the converted text as its draft (the page stays a draft for you to review).
 * @param projectId - The project.
 * @param v - Title, parent (`null`: top level) and the page; `pageId` when the page was already created by an earlier
 *   try (only its draft is saved again).
 * @returns The page's id.
 */
export async function saveImportedPage(
  projectId: string,
  v: { title: string; parentId: string | null; doc: JSONContent; pageId?: string },
): Promise<string> {
  const id =
    v.pageId ??
    (
      await client.post<DocsPage>(`/projects/${projectId}/docs/pages`, {
        title: v.title,
        parentId: v.parentId,
        template: 'blank',
      })
    ).data.id;
  try {
    await client.put(`/docs/pages/${id}/draft`, { content: v.doc, title: v.title }, { rawKeys: ['content'] });
  } catch (e) {
    (e as { pageId?: string }).pageId = id;
    throw e;
  }
  return id;
}

/** True when a request failed without an answer from the server (offline, or the server is down). */
export function unreachable(err: unknown): boolean {
  const e = err as { response?: unknown; isAxiosError?: boolean; code?: string };
  return (
    !!e &&
    typeof e === 'object' &&
    !(err instanceof ImportError) &&
    !e.response &&
    (e.isAxiosError === true || e.code === 'ERR_NETWORK')
  );
}
