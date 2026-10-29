import type { PreviewItem } from './types';

/** Whether the app runs inside the desktop shell, which can open files in other apps. */
export function isDesktop(): boolean {
  return Boolean(window.electronAPI?.openPath);
}

/** Whether the desktop shell can reveal a file in Finder or Explorer. */
export function canShowInFolder(): boolean {
  return Boolean(window.electronAPI?.showItemInFolder);
}

/** Find where a stored file lives on this computer. The server names it in the `X-File-Path` header. */
export async function resolveLocalPath(item: PreviewItem): Promise<string | null> {
  if (item.localPath) return item.localPath;
  try {
    const res = await fetch(item.src, { method: 'HEAD' });
    return res.headers.get('x-file-path');
  } catch {
    return null;
  }
}

/** Open the stored file with the default app for its type. */
export async function openInDefaultApp(item: PreviewItem): Promise<{ ok: boolean; message: string }> {
  const open = window.electronAPI?.openPath;
  if (!open) return { ok: false, message: 'Opening in an app is only available in the desktop app.' };
  const path = await resolveLocalPath(item);
  if (!path) return { ok: false, message: 'Could not find the file on this computer. Download it instead.' };
  const res = await open(path);
  return res.success
    ? { ok: true, message: `Opened ${item.name} in its default app` }
    : { ok: false, message: res.error || 'Could not open the file' };
}

/** Reveal the stored file in Finder or Explorer. */
export async function showInFolder(item: PreviewItem): Promise<{ ok: boolean; message: string }> {
  const show = window.electronAPI?.showItemInFolder;
  if (!show) return { ok: false, message: 'Show in folder is only available in the desktop app.' };
  const path = await resolveLocalPath(item);
  if (!path) return { ok: false, message: 'Could not find the file on this computer. Download it instead.' };
  const res = await show(path);
  return res.success
    ? { ok: true, message: 'Shown in folder' }
    : { ok: false, message: res.error || 'Could not show the file' };
}
