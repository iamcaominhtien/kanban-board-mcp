import { useEffect, useMemo, useState } from 'react';
import { useDocsDiff, useDocsVersions } from '../../api/docs';
import type { DocsPage } from '../../types/docs';
import { Icon } from './Icon';
import { Avatar, agoText, displayName, fmtDateTime, plural } from './docsShared';

interface SinceViewedBannerProps {
  page: DocsPage;
  onCompare: (from: number, to: number) => void;
}

const key = (pageId: string) => `docsSeen:${pageId}`;

function readSeen(pageId: string): number | null {
  try {
    const raw = localStorage.getItem(key(pageId));
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Record that the viewer has seen `version` of the page (also call this after your own publish). */
export function markDocsSeen(pageId: string, version: number): void {
  try {
    localStorage.setItem(key(pageId), String(version));
  } catch {
    /* storage unavailable */
  }
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Changes since you last viewed": collapsed by default, expands to the edits behind it. */
export function SinceViewedBanner({ page, onCompare }: SinceViewedBannerProps) {
  const [seen, setSeen] = useState<number | null>(() => readSeen(page.id));
  const [open, setOpen] = useState(false);
  const versionsQ = useDocsVersions(page.id);

  // First visit: nothing to compare against yet, so remember the version being shown.
  useEffect(() => {
    const s = readSeen(page.id);
    if (s == null && page.version > 0) {
      markDocsSeen(page.id, page.version);
      setSeen(page.version);
    } else {
      setSeen(s);
    }
    setOpen(false);
  }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const behind = seen != null && seen < page.version;
  const edits = useMemo(
    () => (versionsQ.data ?? []).filter((v) => seen != null && v.version > seen && v.version <= page.version).sort((a, b) => b.version - a.version),
    [versionsQ.data, seen, page.version],
  );
  const diffQ = useDocsDiff(behind ? page.id : null, behind ? seen : null, behind ? page.version : null);
  const sectionNames = (diffQ.data?.sections ?? []).map((s) => s.heading.replace(/^#+\s*/, '').trim() || 'Top of page');
  const seenVersion = (versionsQ.data ?? []).find((v) => v.version === seen);

  if (!behind || seen == null) return null;

  const authors = Array.from(new Set(edits.map((e) => displayName(e.author))));
  const count = edits.length || page.version - seen;

  function markSeen() {
    markDocsSeen(page.id, page.version);
    setSeen(page.version);
  }

  return (
    <div
      data-testid="since-viewed-banner"
      className="docs-root"
      style={{ padding: '11px 14px', borderRadius: 10, background: '#E8F1FB', border: '1px solid #B9D3EE' }}
    >
      <div style={{ display: 'flex', alignItems: open ? 'flex-start' : 'center', gap: 10 }}>
        <span style={{ display: 'flex', color: '#2F6FB0', marginTop: 1 }}>
          <Icon name="i44" size={17} />
        </span>
        {open ? (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, lineHeight: 1.45, color: '#1E2A22' }}>
              <b style={{ fontWeight: 700 }}>Changes since you last viewed</b>{' '}
              <span style={{ color: '#5B6B60' }}>
                ({seenVersion ? `${fmtDateTime(seenVersion.createdAt)}, ` : ''}v{seen})
              </span>
            </div>
            {sectionNames.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {sectionNames.map((n) => (
                  <span key={n} className="mc-chip" style={{ background: '#FFFFFF', border: '1px solid #B9D3EE', color: '#1F5A8E' }}>
                    {n}
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {edits.map((e) => (
                <div
                  key={e.version}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12.5, color: '#1E2A22', borderTop: '1px solid #CFE0F2' }}
                >
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700 }}>v{e.version}</span>
                  <Avatar name={e.author} />
                  <b style={{ fontWeight: 600 }}>{displayName(e.author)}</b>
                  <span style={{ color: '#5B6B60' }}>{e.note ?? ''}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap' }}>{agoText(e.createdAt)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={() => onCompare(seen, page.version)}>
                <Icon name="i40" size={13} strokeWidth={2} />
                Compare v{seen} to v{page.version}
              </button>
              <button type="button" className="st-btn st-btn-sm" onClick={markSeen}>
                Mark as seen
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.45, color: '#1E2A22' }}>
              <b style={{ fontWeight: 700 }}>Changes since you last viewed</b> · {plural(count, 'edit')}
              {authors.length > 0 && ` by ${listNames(authors)}`}
              {sectionNames.length > 0 && `, ${plural(sectionNames.length, 'section')}`}
            </div>
            <button type="button" className="st-btn st-btn-sm" onClick={() => setOpen(true)}>
              <Icon name="i40" size={13} strokeWidth={2} />
              Show changes
            </button>
          </>
        )}
        <button type="button" className="dk-icobtn" aria-label="Dismiss" style={{ width: 26, height: 26 }} onClick={markSeen}>
          <Icon name="i08" size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
