/**
 * The status rules of a page (design board "Rich Docs — reading", D): when a published page may be outdated, and
 * the words for its dates.
 */

import type { DocsPage } from '../../types/docs';

/** A published page not edited (or reviewed) for this many months may be outdated. */
export const OUTDATED_MONTHS = 6;

/** Why a page may be outdated. */
export interface Outdated {
  /** Whole months since the last edit or review. */
  months: number;
  /** Someone set its status to Outdated (page settings), whatever its age. */
  marked: boolean;
}

/**
 * Whole calendar months from one time to another (0 when `to` is not later).
 * @param from - The earlier time.
 * @param to - The later time.
 */
export function monthsBetween(from: Date, to: Date): number {
  let m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) m -= 1;
  return Math.max(0, m);
}

function time(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Whether a page may be outdated: published, and either marked Outdated in its settings or not edited for
 * {@link OUTDATED_MONTHS} months. "Mark as reviewed" (settings.reviewedAt) starts the clock again. A page that was
 * never published shows no note.
 * @param page - The page.
 * @param now - The time to judge at.
 * @param afterMonths - Months without edits after which a page may be outdated.
 * @returns Why it may be outdated, or `null`.
 */
export function outdatedOf(
  page: Pick<DocsPage, 'version' | 'updatedAt' | 'settings'>,
  now: Date = new Date(),
  afterMonths: number = OUTDATED_MONTHS,
): Outdated | null {
  if (page.version < 1) return null;
  const s = page.settings ?? {};
  const last = Math.max(time(page.updatedAt) ?? 0, time(s.reviewedAt) ?? 0);
  const months = last ? monthsBetween(new Date(last), now) : 0;
  if (s.status === 'outdated') return { months, marked: true };
  return last && months >= afterMonths ? { months, marked: false } : null;
}

/**
 * "9 months", "1 year", "3 years": how long a page has gone without edits.
 * @param months - Whole months.
 */
export function ageText(months: number): string {
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'}`;
  const y = Math.floor(months / 12);
  return `${y === 1 ? 'a year' : `${y} years`}`;
}

/**
 * The note readers see on a page that may be outdated.
 * @param o - Why it may be outdated.
 */
export function outdatedText(o: Outdated): string {
  if (o.marked) return 'This page is marked as outdated. Check it before you rely on it.';
  return `This page has not been edited for ${ageText(o.months)}, so it may be out of date. Check it before you rely on it.`;
}

/**
 * "Oct 5, 2026 at 9:42 AM".
 * @param iso - An ISO time.
 */
export function longDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${t}`;
}

/**
 * "Oct 5, 2026".
 * @param iso - An ISO time.
 */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
