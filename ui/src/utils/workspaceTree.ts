import type { WorkspaceFile } from '../types/ticket';

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatTimeAgo(iso: string, now = Date.now()): string {
  const sec = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatTimeLeft(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'due now';
  const hr = Math.ceil(ms / 3600000);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.ceil(hr / 24)}d`;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function depthOf(path: string): number {
  return path.split('/').length - 1;
}

/** Entries whose every ancestor folder is expanded (i.e. not in `collapsed`). */
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

export function previewKind(name: string): 'image' | 'text' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'text'; // server detects binary and reports it
}
