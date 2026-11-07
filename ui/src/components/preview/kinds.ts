import { getFileExtension } from '../../utils/fileIcons';
import type { PreviewKind } from './types';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const MARKDOWN = new Set(['md', 'markdown']);
const JSON_EXT = new Set(['json', 'json5']);
const HTML = new Set(['html', 'htm']);
const TABLE = new Set(['csv', 'tsv', 'xlsx']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz']);
const MEDIA = new Set(['mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov', 'm4a']);
const CODE = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'css',
  'scss',
  'yaml',
  'yml',
  'xml',
  'sql',
  'sh',
  'env',
  'toml',
  'ini',
  'java',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
]);
const TEXT = new Set(['txt', 'log', 'text', 'conf', 'cfg', 'jsonl']);

/** Decide how a file opens from its name. */
export function previewKind(name: string): PreviewKind {
  const ext = getFileExtension(name);
  if (IMAGE.has(ext)) return 'image';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (JSON_EXT.has(ext)) return 'json';
  if (HTML.has(ext)) return 'html';
  if (TABLE.has(ext)) return 'table';
  if (ext === 'pdf') return 'pdf';
  if (ARCHIVE.has(ext)) return 'archive';
  if (MEDIA.has(ext)) return 'media';
  if (ext === 'docx') return 'word';
  if (ext === 'pptx') return 'powerpoint';
  if (CODE.has(ext)) return 'code';
  if (TEXT.has(ext)) return 'text';
  return 'none';
}

/** Whether the file is a video (otherwise a media file is audio). */
export function isVideoName(name: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(name);
}

/** Language label for a code file ("TypeScript"). */
export function languageLabel(name: string): string {
  const ext = getFileExtension(name);
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    py: 'Python',
    css: 'CSS',
    scss: 'SCSS',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
    sql: 'SQL',
    sh: 'Shell',
    toml: 'TOML',
    log: 'Log',
    txt: 'Plain text',
    json: 'JSON',
    md: 'Markdown',
    html: 'HTML',
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : 'Text');
}

const AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a']);

/**
 * The kind of a file as the viewer's subtitle names it ("CSV · 1.8 MB", design preview-types): the app-wide label
 * groups CSV with Excel, Markdown with plain text and audio with video, so the viewer names them itself.
 */
export function kindLabel(name: string, fallback: string): string {
  const ext = getFileExtension(name);
  if (ext === 'csv') return 'CSV';
  if (ext === 'tsv') return 'TSV';
  if (MARKDOWN.has(ext)) return 'Markdown';
  if (HTML.has(ext)) return 'HTML';
  if (MEDIA.has(ext)) return AUDIO.has(ext) ? 'Audio' : 'Video';
  if (CODE.has(ext)) return languageLabel(name);
  return fallback;
}

/** A deck's name without its extension, its "-office-fonts" copy and case: "Deck-office-fonts.pptx" and "deck.pdf" share it. */
const deckName = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/-office-fonts$/, '');

/**
 * The PDF that goes with a deck among the files shown with it. `exact` is the same file name with .pdf (the
 * deck's own PDF); otherwise only the name of its Office-font copy matches, so the person is asked, not told.
 */
export function pdfOfDeck(
  deck: { id: string; name: string },
  related: { id: string; name: string }[] = [],
): { item: (typeof related)[number]; exact: boolean } | null {
  const pdfs = related.filter((it) => it.id !== deck.id && getFileExtension(it.name) === 'pdf');
  const stem = (n: string) => n.replace(/\.[^.]+$/, '').toLowerCase();
  const same = pdfs.find((it) => stem(it.name) === stem(deck.name));
  if (same) return { item: same, exact: true };
  const near = pdfs.find((it) => deckName(it.name) === deckName(deck.name));
  return near ? { item: near, exact: false } : null;
}
