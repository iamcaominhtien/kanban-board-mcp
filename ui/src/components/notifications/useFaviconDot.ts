import { useEffect } from 'react';
import { inElectron } from './notificationUi';

const SIZE = 64;

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

/** The icon with a red dot at its corner, as a PNG data URL (null when the icon cannot be drawn). */
async function withDot(src: string): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('icon'));
    img.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const r = SIZE * 0.22;
  const x = SIZE - r - 1;
  const y = r + 1;
  ctx.beginPath();
  ctx.arc(x, y, r + 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#e03b3b';
  ctx.fill();
  return canvas.toDataURL('image/png');
}

/**
 * The tab's icon carries a red dot while something needs the person (#270): the count in the title is cut off in a
 * crowded tab strip, the dot is not. Not inside the desktop app (its icon has the number).
 */
export function useFaviconDot(needs: number) {
  useEffect(() => {
    if (inElectron() || needs <= 0) return;
    const link = iconLink();
    if (!link) return;
    const original = { href: link.href, type: link.type };
    let cancelled = false;
    withDot(original.href)
      .then((url) => {
        if (cancelled || !url) return;
        link.type = 'image/png';
        link.href = url;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      link.type = original.type;
      link.href = original.href;
    };
  }, [needs > 0]); // eslint-disable-line react-hooks/exhaustive-deps
}
