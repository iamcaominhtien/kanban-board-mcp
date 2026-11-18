/**
 * The top of a page's document (design board "Rich Docs — app frame", A): the cover, the eyebrow, the title and the
 * byline ("Name · date · N min read"), drawn as the page's Header and Cover settings say. The reader shows the title
 * as a heading; the editor puts its title field in the same place.
 */

import type { CSSProperties, ReactNode } from 'react';
import { resolveOrigin } from '../../api/resolveOrigin';
import { COVER_PX, coverUrl, type PageLook } from './pageSettings';
import './docFonts.css';

/** The author line under the title. */
export interface Byline {
  name: string;
  initials: string;
  /** Avatar colours. */
  avatar: { background: string; color: string };
  /** ISO time shown as the date. */
  date: string;
  /** Reading time in minutes. */
  minutes: number;
}

interface Props {
  look: PageLook;
  /** The title: an `<h1>` in the reader, the title field in the editor. */
  title: ReactNode;
  /** The author line; null leaves it out. */
  byline?: Byline | null;
  /** Shown as the eyebrow when the title style is "With eyebrow" and the page has none of its own. */
  fallbackEyebrow?: string;
}

/**
 * Class names of the title for the page's Header settings (docs.css `.dk-ph-title-*`).
 * @param look - The page's settings.
 */
export function titleClass(look: PageLook): string {
  return `dk-ph-title dk-ph-title-${look.titleStyle}`;
}

/** "12 Nov 2026". */
function bylineDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The page header: cover, eyebrow, title and byline.
 * @param props.look - The page's settings.
 * @param props.title - The title element.
 * @param props.byline - The author line (null: none; the page's `showByline` and `showReadingTime` apply on top).
 * @param props.fallbackEyebrow - The eyebrow of the "With eyebrow" title style when the page set none.
 */
export function PageHeader({ look, title, byline, fallbackEyebrow }: Props) {
  const eyebrow = look.eyebrow ?? (look.titleStyle === 'eyebrow' ? fallbackEyebrow : null);
  const by = look.showByline && byline ? byline : null;
  const date = by ? bylineDate(by.date) : '';
  const head = (
    <header className={`dk-ph dk-ph-${look.titleAlign}`} data-testid="page-header" data-title-style={look.titleStyle}>
      {eyebrow && (
        <div className="dk-ph-eyebrow" data-testid="page-eyebrow">
          {eyebrow}
        </div>
      )}
      {title}
      {look.titleStyle === 'eyebrow' && look.titleAlign === 'center' && (
        // the book look (Editor board, frame 1): a centred eyebrow title ends in a rule, a diamond and a rule
        <div className="dk-ph-ornament" aria-hidden="true" data-testid="page-ornament">
          <span />
          <i />
          <span />
        </div>
      )}
      {by && (
        <div className="dk-ph-byline" data-testid="page-byline">
          <span className="dk-ph-avatar" style={by.avatar} aria-hidden="true">
            {by.initials}
          </span>
          <span className="dk-ph-name">{by.name}</span>
          {date && (
            <>
              <span aria-hidden="true">·</span>
              <span>{date}</span>
            </>
          )}
          {look.showReadingTime && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="reading-time">{by.minutes} min read</span>
            </>
          )}
        </div>
      )}
    </header>
  );
  const cover = look.cover;
  if (!cover) return head;
  const style: CSSProperties = {
    height: COVER_PX[cover.height],
    backgroundImage: `url("${coverUrl(cover.src, resolveOrigin())}")`,
    backgroundPosition: `center ${cover.positionY}%`,
  };
  return (
    <>
      <div
        className={`dk-cover${cover.titleOnCover ? ' dk-cover-titled' : ''}`}
        style={style}
        data-testid="page-cover"
        role={cover.titleOnCover ? undefined : 'img'}
        aria-label={cover.titleOnCover ? undefined : 'Cover picture'}
      >
        {cover.titleOnCover && head}
      </div>
      {!cover.titleOnCover && head}
    </>
  );
}
