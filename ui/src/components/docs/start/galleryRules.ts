/**
 * The rules of the New page gallery and of "Save as template…", without React: which cards a chip and a search
 * show, the title checks made before a page is created, the checks on a template name, and the recent templates.
 */

import type { DocsTreeNode } from '../../../types/docs';
import type { DocsGallery, GallerySaved, TemplateCategory } from '../../../types/docsGallery';
import { slugify } from '../../../utils/docsMarkdown';

/** The longest template name the server takes (`MAX_TEMPLATE_NAME`). */
export const MAX_TEMPLATE_NAME = 60;

/** The chips over the gallery. */
export type GalleryChip = 'all' | 'work' | 'writing' | 'ba' | 'yours';

/** The chips in the order they are drawn, with their labels. */
export const GALLERY_CHIPS: readonly { id: GalleryChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'work', label: 'Work' },
  { id: 'writing', label: 'Writing' },
  { id: 'ba', label: 'BA' },
  { id: 'yours', label: 'Yours' },
];

/** One card of the gallery. */
export interface GalleryItem {
  /** The id sent as `template` (a built-in id, a saved template's id, or `canvas`). */
  id: string;
  name: string;
  description: string;
  category: TemplateCategory | null;
  /** `yours`: saved by the caller; `project`: shared with the project by someone else; `canvas`: a Canvas page. */
  source: 'builtin' | 'yours' | 'project' | 'canvas';
  /** The text the preview pane shows (Markdown of a built-in, plain text of a saved template). */
  preview: string;
  settings: Record<string, unknown>;
  /** The saved template, for its menu. */
  saved?: GallerySaved;
}

/** The Canvas card: not a template on the server, a page of its own kind. */
const CANVAS: GalleryItem = {
  id: 'canvas',
  name: 'Canvas',
  description: 'Boards on one large plane',
  category: 'work',
  source: 'canvas',
  preview: '',
  settings: {},
};

const savedItem = (t: GallerySaved, source: 'yours' | 'project'): GalleryItem => ({
  id: t.id,
  name: t.name,
  description: t.description ?? '',
  category: t.category,
  source,
  preview: t.preview,
  settings: t.settings ?? {},
  saved: t,
});

/**
 * The cards of the gallery in the order they are drawn: Blank first, then Canvas, the built-in templates the project
 * does not hide, then the caller's own templates and the ones shared with the project.
 * @param g - The gallery from the server.
 */
export function galleryItems(g: DocsGallery): GalleryItem[] {
  const hidden = new Set(g.hidden ?? []);
  const builtin = g.builtin.filter((b) => !hidden.has(b.id) || b.id === 'blank');
  const blank = builtin.find((b) => b.id === 'blank');
  const items: GalleryItem[] = [];
  if (blank) items.push({ ...blank, source: 'builtin' });
  items.push(CANVAS);
  for (const b of builtin) if (b.id !== 'blank') items.push({ ...b, source: 'builtin' });
  for (const t of g.yours ?? []) items.push(savedItem(t, 'yours'));
  for (const t of g.project ?? []) items.push(savedItem(t, 'project'));
  return items;
}

const isSaved = (it: GalleryItem) => it.source === 'yours' || it.source === 'project';

/** True when a card belongs under a chip (Blank and Canvas are listed under All and Work, as the server files them). */
export function inChip(it: GalleryItem, chip: GalleryChip): boolean {
  if (chip === 'all') return true;
  if (chip === 'yours') return isSaved(it);
  // a saved template is also listed under the category it was saved with
  return it.category === chip;
}

/** True when every word of the search is in the card's name or description (case and accents ignored). */
export function matchesSearch(it: GalleryItem, query: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(`${it.name} ${it.description}`);
  return words.every((w) => hay.includes(w));
}

/**
 * The cards a chip and a search show, in gallery order.
 * @param items - All cards ({@link galleryItems}).
 * @param chip - The chip that is on.
 * @param query - The search (blank: no search).
 */
export function filterGallery(items: GalleryItem[], chip: GalleryChip, query: string): GalleryItem[] {
  return items.filter((it) => inChip(it, chip) && matchesSearch(it, query));
}

/** How many cards each chip holds (without a search), for the counts on the chips. */
export function chipCounts(items: GalleryItem[]): Record<GalleryChip, number> {
  const out = { all: 0, work: 0, writing: 0, ba: 0, yours: 0 } as Record<GalleryChip, number>;
  for (const c of GALLERY_CHIPS) out[c.id] = items.filter((it) => inChip(it, c.id)).length;
  return out;
}

/** What the title field says before a page is created. */
export interface TitleCheck {
  trimmed: string;
  /** No title, once the field was touched or Create was pressed: "Give the page a title to create it." */
  empty: boolean;
  /** A page with this title is already under the same parent (creating stays possible). */
  clash: boolean;
  /** The address the new page gets when it clashes (`api-2`). */
  nextAddress: string;
}

/**
 * The checks on a new page's title.
 * @param nodes - The page tree.
 * @param parentId - The parent the page goes under (`null`: top level).
 * @param title - The title as typed.
 * @param shown - The field was touched or Create was pressed (an empty title only counts then).
 */
export function checkTitle(nodes: DocsTreeNode[], parentId: string | null, title: string, shown: boolean): TitleCheck {
  const trimmed = title.trim();
  const clash =
    !!trimmed && nodes.some((n) => n.parentId === parentId && n.title.toLowerCase() === trimmed.toLowerCase());
  const base = slugify(trimmed) || 'page';
  const used = new Set(nodes.map((n) => n.slug));
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return { trimmed, empty: shown && !trimmed, clash, nextAddress: `${base}-${i}` };
}

/** What a template name allows: Save is off unless `ok`. */
export type TemplateNameState = 'ok' | 'empty' | 'too_long';

/** The state of a template name as typed ({@link MAX_TEMPLATE_NAME} characters at most, not blank). */
export function templateNameState(name: string): TemplateNameState {
  const n = name.trim();
  if (!n) return 'empty';
  if ([...n].length > MAX_TEMPLATE_NAME) return 'too_long';
  return 'ok';
}

const RECENT_KEY = 'docsRecentTemplates';

/** A template used lately, for the New page menu. */
export interface RecentTemplate {
  id: string;
  name: string;
}

/** The templates used lately on this device, newest first (Blank and Canvas are not kept). */
export function recentTemplates(): RecentTemplate[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw)
      ? raw.filter((r): r is RecentTemplate => !!r && typeof r.id === 'string' && typeof r.name === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Remembers that a page was made from a template (two are kept). */
export function rememberTemplate(t: RecentTemplate): void {
  if (t.id === 'blank' || t.id === 'canvas') return;
  try {
    const list = [t, ...recentTemplates().filter((r) => r.id !== t.id)].slice(0, 2);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: nothing to remember */
  }
}
