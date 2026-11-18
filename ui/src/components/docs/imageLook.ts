/**
 * How a picture is framed (Blocks 7): its border, corners and shadow, shared by the editor and every reading view.
 */

import type { CSSProperties } from 'react';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A picture's border widths (Thin, Medium, Thick) in px. */
export const BORDER_PX: Record<string, number> = { thin: 1, medium: 2, thick: 3 };

/**
 * The style a picture's border, corners and shadow give it (Blocks 7): a 1, 2 or 3 px line in its colour (the light
 * grey one when none is set), and a soft or a lifted shadow. The reader draws pictures with it too.
 * @param attrs - The image node's attributes.
 */
export function imageLook(attrs: Record<string, unknown>): CSSProperties {
  const radius = num(attrs.radius) ?? 0;
  const border = BORDER_PX[str(attrs.border)];
  const color = /^#[0-9a-fA-F]{6}$/.test(str(attrs.borderColor)) ? str(attrs.borderColor) : '#D3DBD6';
  return {
    ...(radius ? { borderRadius: radius >= 999 ? '50%' : radius } : {}),
    ...(border ? { border: `${border}px solid ${color}` } : {}),
    ...(attrs.shadow
      ? {
          boxShadow:
            str(attrs.shadowStyle) === 'soft' ? '0 2px 8px rgba(30,42,34,0.12)' : '0 6px 18px rgba(30,42,34,0.16)',
        }
      : {}),
  };
}
