import type { CSSProperties } from 'react';
import { ICON_ALIASES, ICON_PATHS } from './iconPaths';

interface Props {
  /** Alias (page, plus, more, grip, hash, chevronRight, chevronDown, folder, close, search, check, link) or an id like `i23`. */
  name: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
}

/** The stroke icons used by the Docs design boards (24×24 viewBox, currentColor). */
export function Icon({ name, size = 16, strokeWidth = 1.9, style, className }: Props) {
  const key = ICON_ALIASES[name] ?? name;
  const html = ICON_PATHS[key];
  if (!html) return null;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
