import { useEffect, useMemo, useState } from 'react';
import { usePageSettled } from './pageSettled';
import {
  useDocsDiff,
  useDocsSeen,
  useDocsStepDiffs,
  useDocsVersion,
  useDocsVersions,
  useMarkDocsSeen,
} from '../../api/docs';
import type { DocsPage } from '../../types/docs';
import { Icon } from './Icon';
import { Avatar, agoText, displayName, fmtDateTime, plural } from './docsShared';
import { diffBlocks } from './history/blockDiff';
import { blockName, typeName } from './suggestions/describe';
import { publishedDoc } from './richPage';
import type { RichDoc } from '../../types/docs';
import './states/states.css';

/** The last viewed version used to live in the browser; read it once so nobody loses their place. */
const legacyKey = (pageId: string) => `docsSeen:${pageId}`;

function readLegacySeen(pageId: string): number | null {
  try {
    const raw = localStorage.getItem(legacyKey(pageId));
    const n = raw == null ? Number.NaN : Number(raw);
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

/** Show or hide the green bars and "Changed in vN" labels on the page: an eye, slashed when they are hidden. */
function MarksToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className="dk-icobtn"
      aria-label="Mark changed paragraphs in the page"
      aria-pressed={on}
      title={on ? 'Hide change markers in the page' : 'Show change markers in the page'}
      style={{
        width: 26,
        height: 26,
        color: '#5B6B60',
        border: '1px solid #B9D3EE',
        background: '#FFFFFF',
        borderRadius: 7,
        boxSizing: 'border-box',
      }}
      onClick={() => onChange(!on)}
    >
      <svg
        aria-hidden="true"
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
        {!on && <path d="M4 4l16 16" />}
      </svg>
    </button>
  );
}

/**
 * The blocks that changed since a version, named as the banner chips name them (AI board H 43): "Paragraph 2",
 * "Heading 2", "Image", "New: pull quote". Empty when either version is not rich.
 * @param before - The page as last viewed.
 * @param after - The page now.
 */
export function changedBlockChips(before: RichDoc | null | undefined, after: RichDoc | null | undefined): string[] {
  if (!before?.content || !after?.content) return [];
  const out: string[] = [];
  for (const c of diffBlocks(before, after)) {
    if (c.kind === 'added' && c.after) out.push(`New: ${typeName(c.after).toLowerCase()}`);
    else if (c.kind === 'changed' && c.after) {
      const t = c.after.type;
      out.push(t === 'heading' || t === 'image' || t === 'table' ? typeName(c.after) : blockName(c.after, after));
    }
  }
  return [...new Set(out)];
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
  const settled = usePageSettled();
  const versionsQ = useDocsVersions(settled ? page.id : null);

  useEffect(() => setOpen(false), [page.id]);

  const diffQ = useDocsDiff(behind ? page.id : null, behind ? seen : null, behind ? page.version : null);
  const sectionNames = (diffQ.data?.sections ?? []).map((s) => s.heading.replace(/^#+\s*/, '').trim() || 'Top of page');
  const seenVersion = (versionsQ.data ?? []).find((v) => v.version === seen);
  const seenDetail = useDocsVersion(behind && settled ? page.id : null, behind && settled ? seen : null).data;
  const blockChips = useMemo(
    () => changedBlockChips(seenDetail?.format === 'rich' ? (seenDetail.content ?? null) : null, publishedDoc(page)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seenDetail, page.content],
  );

  if (!behind || seen == null) return null;

  const authors = Array.from(new Set(edits.map((e) => displayName(e.author))));
  const count = edits.length || page.version - seen;

  const lastSeen = seenVersion ? `${fmtDateTime(seenVersion.createdAt)}, v${seen}` : `v${seen}`;
  const summary = (
    <>
      {plural(count, 'edit')}
      {authors.length > 0 && ` by ${listNames(authors)}`}
      {sectionNames.length > 0 && `, ${plural(sectionNames.length, 'section')}`} (v{page.version})
    </>
  );
  const chips = blockChips.length ? blockChips : sectionNames;

  return (
    <div data-testid="since-viewed-banner" className="docs-root dsv-banner">
      <div className="dsv-row">
        {/* a phone leads with the info mark (AI 45) */}
        <svg
          className="dsv-ico"
          aria-hidden="true"
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#2F6FB0"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8v.01" />
        </svg>
        <div className="dsv-body">
          <div className="dsv-line">
            <b>Changes since you last viewed</b>{' '}
            <span className="dsv-sum">
              <span className="dsv-dot">· </span>
              {summary}
            </span>
          </div>
          {chips.length > 0 && (
            <div className="dsv-chips" data-testid="since-chips">
              {chips.map((n) => (
                <span key={n} className="dsv-chip">
                  {n}
                </span>
              ))}
            </div>
          )}
          {open && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 12, color: '#5B6B60', paddingBottom: 6 }}>Last viewed {lastSeen}</div>
              {edits.map((e) => (
                <div key={e.version} className="dsv-edit">
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
          )}
          <div className="dsv-btns">
            {open ? (
              <button type="button" className="dsv-btn dsv-btn-primary" onClick={() => onCompare(seen, page.version)}>
                <Icon name="i40" size={13} strokeWidth={2} />
                Compare v{seen} to v{page.version}
              </button>
            ) : (
              <button type="button" className="dsv-btn dsv-btn-primary" onClick={() => setOpen(true)}>
                <Icon name="i40" size={13} strokeWidth={2} />
                Show changes
              </button>
            )}
            <button type="button" className="dsv-btn" onClick={markSeen}>
              Mark as seen
            </button>
          </div>
        </div>
        <span className="dsv-marks">
          <MarksToggle on={marks} onChange={setMarks} />
        </span>
        <button
          type="button"
          className="dk-icobtn"
          aria-label="Dismiss"
          style={{ width: 26, height: 26, color: '#5B6B60' }}
          onClick={markSeen}
        >
          <Icon name="i08" size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
