/** Open a link in the system browser (the desktop app) or a new tab. Only web links are ever opened. */
export function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  const open = (window as unknown as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI
    ?.openExternal;
  if (open) open(url);
  else window.open(url, '_blank', 'noopener');
}

/** Copy text; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The clipboard's text, or null when the browser does not allow reading it. */
export async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
