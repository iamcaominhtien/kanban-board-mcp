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

/** Extensions that can run programs; the viewer asks before opening them in the default app. */
const RUNNABLE = new Set(['exe', 'bat', 'cmd', 'ps1', 'sh', 'command', 'app', 'msi', 'jar']);

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

/** Whether opening the file in the default app could run a program. */
export function isRunnableFile(name: string): boolean {
  return RUNNABLE.has(getFileExtension(name));
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
