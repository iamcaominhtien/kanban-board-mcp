import { useEffect, useMemo, useState } from 'react';
import { useDocsDiff, useDocsSeen, useDocsStepDiffs, useDocsVersions, useMarkDocsSeen } from '../../api/docs';
import type { DocsPage } from '../../types/docs';
import { Icon } from './Icon';
import { Avatar, agoText, displayName, fmtDateTime, plural } from './docsShared';

/** The last viewed version used to live in the browser; read it once so nobody loses their place. */
const legacyKey = (pageId: string) => `docsSeen:${pageId}`;

function readLegacySeen(pageId: string): number | null {
  try {
    const raw = localStorage.getItem(legacyKey(pageId));
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function clearLegacySeen(pageId: string): void {
  try {
    localStorage.removeItem(legacyKey(pageId));
  } catch {
    /* storage unavailable */
  }
}

/** Whether paragraphs changed since the last view carry their green bar and "Changed in vN" label; a reader's choice. */
const MARKS_KEY = 'docsChangeMarks';

function readMarks(): boolean {
  try {
    return localStorage.getItem(MARKS_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeMarks(on: boolean): void {
  try {
    localStorage.setItem(MARKS_KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable: the choice lasts until the page is closed */
  }
}

/** Lines that say nothing on their own, so they never mark a paragraph as changed. */
const TRIVIAL_LINE = /^[\s|:\-`>#*]*$/;

export interface SinceViewed {
  /** version this person last viewed; null until it is known */
  seen: number | null;
  /** the page was published since then */
  behind: boolean;
  /** published versions after `seen`, newest first */
  edits: ReturnType<typeof useDocsVersions>['data'];
  /** source line text -> latest version that added it, for marking changed paragraphs */
  changedIn: Map<string, number>;
  markSeen: () => void;
  /** whether changed paragraphs are marked in the page */
  marks: boolean;
  setMarks: (on: boolean) => void;
}

/**
 * Per-user "since you last viewed" state for a page: the last viewed version lives on the server, the first visit
 * records the version being shown, and `changedIn` says which lines were added by which later version.
 * @param page - Page being viewed.
 * @param enabled - False to skip recording and loading anything (e.g. while offline).
 */
export function useSinceViewed(page: DocsPage, enabled = true): SinceViewed {
  const [marks, setMarksState] = useState(readMarks);
  const seenQ = useDocsSeen(enabled ? page.id : null);
  const mark = useMarkDocsSeen();
  const versionsQ = useDocsVersions(enabled ? page.id : null);
  const serverSeen = seenQ.data;
  const loaded = seenQ.isSuccess || seenQ.isError;
  const seen = serverSeen ?? (loaded ? readLegacySeen(page.id) : null);

  // First visit: adopt the old browser-only value, else remember the version being shown.
  useEffect(() => {
    if (!enabled || !loaded || serverSeen != null || page.version <= 0) return;
    mark(page.id, readLegacySeen(page.id) ?? page.version);
    clearLegacySeen(page.id);
  }, [enabled, loaded, serverSeen, page.id, page.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const behind = seen != null && seen < page.version;
  const edits = useMemo(
    () =>
      (versionsQ.data ?? [])
        .filter((v) => seen != null && v.version > seen && v.version <= page.version)
        .sort((a, b) => b.version - a.version),
    [versionsQ.data, seen, page.version],
  );
  const steps = useDocsStepDiffs(
    behind ? page.id : null,
    edits.slice(0, 12).map((e) => e.version),
  );
  const stepKey = steps.map((q) => q.dataUpdatedAt).join(',');
  const changedIn = useMemo(() => {
    const out = new Map<string, number>();
    // oldest first, so a line edited again is attributed to the later version
    [...steps].reverse().forEach((q) => {
      for (const row of q.data?.rows ?? []) {
        const text = row.text.trim();
        if (row.type === 'add' && !TRIVIAL_LINE.test(text)) out.set(text, q.data!.to);
      }
    });
    return out;
  }, [stepKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    seen,
    behind,
    edits: edits.length ? edits : undefined,
    changedIn,
    markSeen: () => mark(page.id, page.version),
    marks,
    setMarks: (on: boolean) => {
      writeMarks(on);
      setMarksState(on);
    },
  };
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Show or hide the green bars and "Changed in vN" labels on the page. */
function MarksToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className="st-btn st-btn-sm"
      aria-pressed={on}
      title="Mark the paragraphs that changed since you last viewed this page"
      onClick={() => onChange(!on)}
    >
      {on ? 'Hide markers' : 'Show markers'}
    </button>
  );
}

interface SinceViewedBannerProps {
  page: DocsPage;
  since: SinceViewed;
  onCompare: (from: number, to: number) => void;
}

/**
 * "Changes since you last viewed": collapsed by default, expands to the edits behind it.
 * @param props.page - Page to compare against the last viewed version.
 * @param props.since - State from `useSinceViewed` for this page.
 * @param props.onCompare - Called with two version numbers to open their diff.
 */
export function SinceViewedBanner({ page, since, onCompare }: SinceViewedBannerProps) {
  const { seen, behind, markSeen, marks, setMarks } = since;
  const edits = since.edits ?? [];
  const [open, setOpen] = useState(false);
  const versionsQ = useDocsVersions(page.id);

  useEffect(() => setOpen(false), [page.id]);

  const diffQ = useDocsDiff(behind ? page.id : null, behind ? seen : null, behind ? page.version : null);
  const sectionNames = (diffQ.data?.sections ?? []).map((s) => s.heading.replace(/^#+\s*/, '').trim() || 'Top of page');
  const seenVersion = (versionsQ.data ?? []).find((v) => v.version === seen);

  if (!behind || seen == null) return null;

  const authors = Array.from(new Set(edits.map((e) => displayName(e.author))));
  const count = edits.length || page.version - seen;

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
                  <span
                    key={n}
                    className="mc-chip"
                    style={{ background: '#FFFFFF', border: '1px solid #B9D3EE', color: '#1F5A8E' }}
                  >
                    {n}
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {edits.map((e) => (
                <div
                  key={e.version}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 0',
                    fontSize: 12.5,
                    color: '#1E2A22',
                    borderTop: '1px solid #CFE0F2',
                  }}
                >
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700 }}>
                    v{e.version}
                  </span>
                  <Avatar name={e.author} />
                  <b style={{ fontWeight: 600 }}>{displayName(e.author)}</b>
                  <span style={{ color: '#5B6B60' }}>{e.note ?? ''}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap' }}>
                    {agoText(e.createdAt)}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="st-btn st-btn-sm st-btn-primary"
                onClick={() => onCompare(seen, page.version)}
              >
                <Icon name="i40" size={13} strokeWidth={2} />
                Compare v{seen} to v{page.version}
              </button>
              <button type="button" className="st-btn st-btn-sm" onClick={markSeen}>
                Mark as seen
              </button>
              <MarksToggle on={marks} onChange={setMarks} />
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
            <MarksToggle on={marks} onChange={setMarks} />
          </>
        )}
        <button
          type="button"
          className="dk-icobtn"
          aria-label="Dismiss"
          style={{ width: 26, height: 26 }}
          onClick={markSeen}
        >
          <Icon name="i08" size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
