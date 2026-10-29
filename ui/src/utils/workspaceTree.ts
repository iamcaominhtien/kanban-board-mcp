import type { WorkspaceFile } from '../types/ticket';

/** Format bytes as a short size. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format a past time as a short "ago" text.
 * @param iso - ISO timestamp in the past.
 * @param now - Reference time in epoch ms (defaults to the current time).
 */
export function formatTimeAgo(iso: string, now = Date.now()): string {
  const sec = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Format time until `iso` as "in 5h", "in 2d" or "due now".
 * @param iso - ISO timestamp in the future.
 * @param now - Reference time in epoch ms (defaults to the current time).
 */
export function formatTimeLeft(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'due now';
  const hr = Math.ceil(ms / 3600000);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.ceil(hr / 24)}d`;
}

/** Return the last path segment. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Return the path without its last segment. */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Return how many folders deep a path is. */
export function depthOf(path: string): number {
  return path.split('/').length - 1;
}

/**
 * Entries whose every ancestor folder is expanded (i.e. not in `collapsed`).
 * @param files - Flat list of workspace files with slash-separated names.
 * @param collapsed - Folder paths that are collapsed.
 */
export function visibleEntries(files: WorkspaceFile[], collapsed: Set<string>): WorkspaceFile[] {
  return files.filter((f) => {
    let dir = parentDir(f.name);
    while (dir) {
      if (collapsed.has(dir)) return false;
      dir = parentDir(dir);
    }
    return true;
  });
}

const TEXT_EXT = new Set([
  'txt',
  'md',
  'log',
  'json',
  'yaml',
  'yml',
  'toml',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'sh',
  'html',
  'css',
  'xml',
  'sql',
  'ini',
  'env',
  'diff',
  'patch',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Return whether a file previews as an image or text. */
export function previewKind(name: string): 'image' | 'text' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'text'; // server detects binary and reports it
}
