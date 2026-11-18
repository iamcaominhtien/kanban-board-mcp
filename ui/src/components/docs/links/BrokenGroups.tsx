/**
 * Docs health · Broken links grouped by what the links point at (RichDocsLinks G 40): one card per lost target with
 * why and how many links, the fix that mends them all when there is one (Create, Restore), and a row per page with
 * Go to link.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { HealthBroken } from '../../../api/docsAiCare';
import { plural } from '../docsShared';

/** A lost target and the links that point at it. */
export interface BrokenGroup {
  key: string;
  status: HealthBroken['status'];
  /** The page title the links name. */
  page: string;
  /** The heading or block, when they name one. */
  anchor: string | null;
  rows: HealthBroken[];
}

/** Splits `[[Page#Anchor]]` into its page and anchor. */
export function parseRef(ref: string): { page: string; anchor: string | null } {
  const inner = ref.replace(/^\[\[/, '').replace(/\]\]$/, '');
  const at = inner.indexOf('#');
  return at < 0 ? { page: inner, anchor: null } : { page: inner.slice(0, at), anchor: inner.slice(at + 1) || null };
}

/** Groups broken links by what they point at (and why), largest group first. */
export function groupBroken(items: HealthBroken[]): BrokenGroup[] {
  const by = new Map<string, BrokenGroup>();
  for (const it of items) {
    const key = `${it.status}|${it.ref}`;
    const g = by.get(key) ?? { key, status: it.status, ...parseRef(it.ref), rows: [] };
    g.rows.push(it);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.rows.length - a.rows.length);
}

const WHY: Record<string, string> = {
  missing: 'Page not found',
  in_bin: 'In Recycle Bin',
  section_missing: 'Heading not found',
  block_missing: 'Block not found',
};

const HEAD_BG: Record<string, string> = {
  missing: '#FDF1EE',
  in_bin: '#F6F7F6',
  section_missing: '#FDF6EA',
  block_missing: '#FDF6EA',
};

const CHIP: Record<string, CSSProperties> = {
  missing: { background: '#FDF1EE', color: '#C4432A', border: '1.5px dashed #C4432A' },
  in_bin: { background: '#F1F3F1', color: '#5B6B60', border: '1px solid #C7D2CB', textDecoration: 'line-through' },
  section_missing: { background: '#FDF3E3', color: '#8A5A00', border: '1.5px dashed #C98A1B' },
  block_missing: { background: '#FDF3E3', color: '#8A5A00', border: '1.5px dashed #C98A1B' },
};

const small: CSSProperties = {
  font: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  height: 28,
  padding: '0 10px',
  borderRadius: 7,
  border: '1px solid #D5DDD8',
  background: '#fff',
  color: '#1E2A22',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const primary: CSSProperties = { ...small, background: '#2E6F40', color: '#fff', borderColor: '#2E6F40' };

/**
 * The broken links of the space, one card per target.
 * @param props.items - Docs health's broken links.
 * @param props.onOpenPage - Opens a page, at the block the link sits in when known.
 * @param props.onCreate - Creates a page with this title (mends every link to a missing page by its title).
 * @param props.onRestore - Restores a page from the Recycle Bin.
 * @param props.dismiss - Each row's dismiss menu.
 */
export function BrokenGroups({
  items,
  onOpenPage,
  onCreate,
  onRestore,
  dismiss,
}: {
  items: HealthBroken[];
  onOpenPage: (id: string, anchor?: string) => void;
  onCreate?: (title: string) => void;
  onRestore?: (pageId: string) => void;
  dismiss: (row: HealthBroken) => ReactNode;
}) {
  const groups = groupBroken(items);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map((g) => {
        const pages = new Set(g.rows.map((r) => r.pageId)).size;
        const binId = g.rows.find((r) => r.targetPageId)?.targetPageId;
        return (
          <div
            key={g.key}
            data-testid="health-broken-group"
            style={{ border: '1px solid #E3E8E5', borderRadius: 12, background: '#fff', overflow: 'hidden' }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                background: HEAD_BG[g.status] ?? '#FBFCFB',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  height: 22,
                  padding: '0 8px',
                  borderRadius: 6,
                  fontSize: 12.5,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  boxSizing: 'border-box',
                  ...CHIP[g.status],
                }}
              >
                {g.page}
                {g.anchor && (
                  <>
                    <span style={{ opacity: 0.55 }}>›</span>
                    {g.anchor}
                  </>
                )}
              </span>
              <span style={{ fontSize: 12.5, color: '#3A4A3E', flex: 1, minWidth: 200 }}>
                <b>{WHY[g.status] ?? g.status}</b> · {plural(g.rows.length, 'link')} in {plural(pages, 'page')}
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {g.status === 'missing' && onCreate && (
                  <button type="button" style={primary} onClick={() => onCreate(g.page)}>
                    Create “{g.page}”
                  </button>
                )}
                {g.status === 'in_bin' && binId && onRestore && (
                  <button type="button" style={primary} onClick={() => onRestore(binId)}>
                    Restore “{g.page}”
                  </button>
                )}
              </div>
            </div>
            <div style={{ padding: '0 16px' }}>
              {g.rows.map((r) => (
                <div
                  key={`${r.pageId}|${r.blockId ?? ''}`}
                  data-testid="health-broken"
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    padding: '10px 0',
                    borderTop: '1px solid #EEF3EF',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700 }}>{r.title}</div>
                  <button
                    type="button"
                    onClick={() => onOpenPage(r.pageId, r.blockId ?? undefined)}
                    style={{
                      border: 'none',
                      background: 'none',
                      padding: 0,
                      font: 'inherit',
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: '#2E6F40',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.blockId ? 'Go to link' : 'Open page'}
                  </button>
                  {dismiss(r)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
