/**
 * Compare two versions of a page, full screen (design "History and comments on rich pages", B 7–13): the page as it
 * looks, with each changed block wrapped and named in words; inline or side by side; any two versions (From and To,
 * swap); a jump list (chips on a tablet, a stepper on a phone, J / K); unchanged blocks folded; loading, error, no
 * difference and very large change states. Two rich versions are compared block by block; a pair with a Markdown
 * version (around the conversion) falls back to the line diff of their Markdown.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { docsErrorDetail, useDocsDiff, useDocsVersion } from '../../../api/docs';
import { extractError } from '../../../api/extractError';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsPage, DocsVersionSummary, RichDoc } from '../../../types/docs';
import { DiffView, type DiffMode } from '../DiffView';
import { Icon } from '../Icon';
import { RichDocView } from '../RichDocView';
import { Avatar, displayName, fmtDate } from '../docsShared';
import { BlockChangeView, CountsLine, FoldRow, type CompareMode } from './BlockChangeView';
import { countChanges, diffBlocks, diffItems, jumpLabel, noDifference, type BlockChange } from './blockDiff';
import { isConversion, isRich } from './versionInfo';
import './history.css';

/** Past this many changes, only the first {@link STEP} are drawn until asked. */
const LARGE = 30;
const STEP = 10;

/** Props of {@link CompareView}. */
export interface CompareViewProps {
  projectId: string;
  page: DocsPage;
  /** The page's versions, newest first. */
  versions: DocsVersionSummary[];
  /** The two versions compared (`from` is drawn as "before"; it may be the newer one after a swap). */
  from: number;
  to: number;
  onPair: (from: number, to: number) => void;
  /** Back to the version list. */
  onBack: () => void;
  onClose: () => void;
  /** Restore a version (asks first). */
  onRestore: (v: DocsVersionSummary) => void;
  layout: DocsLayout;
  /** False while a dialog is over it: J / K and Esc are left alone. */
  keys: boolean;
}

const when = (v: DocsVersionSummary) => {
  const d = new Date(v.createdAt);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? 'today' : fmtDate(v.createdAt);
};

/** A version picker: the version, its author and date, over a native select of every version. */
function VersionPick({
  label,
  value,
  other,
  versions,
  current,
  onChange,
}: {
  label: string;
  value: number;
  other: number;
  versions: DocsVersionSummary[];
  current: number;
  onChange: (v: number) => void;
}) {
  const v = versions.find((x) => x.version === value);
  return (
    <span className="hx-pick">
      <b className="hx-pick-v">v{value}</b>
      {v && (
        <span className="hx-pick-who">
          {displayName(v.author)}
          <span className="hx-pick-when">, {value === current ? 'current' : when(v)}</span>
        </span>
      )}
      <Icon name="i06" size={12} strokeWidth={2.4} />
      <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {versions
          .filter((x) => x.version !== other)
          .map((x) => (
            <option key={x.version} value={x.version}>
              v{x.version} · {displayName(x.author)}
              {x.version === current ? ' · Current' : ` · ${fmtDate(x.createdAt)}`}
            </option>
          ))}
      </select>
    </span>
  );
}

/** What each block of the merged page is in the drawing: a change, the first block of a fold, or a folded block. */
type Role =
  { kind: 'change'; c: BlockChange; index: number } | { kind: 'fold'; key: string; blocks: BlockChange[] } | null;

/**
 * Full-screen comparison of two versions.
 * @param props - See {@link CompareViewProps}.
 */
export function CompareView({
  projectId,
  page,
  versions,
  from,
  to,
  onPair,
  onBack,
  onClose,
  onRestore,
  layout,
  keys,
}: CompareViewProps) {
  const phone = layout === 'phone';
  const tablet = layout === 'tablet';
  const [pickMode, setPickMode] = useState<'inline' | 'side-by-side'>('inline');
  const mode: CompareMode = phone ? 'phone' : pickMode;
  const fromQ = useDocsVersion(page.id, from);
  const toQ = useDocsVersion(page.id, to);
  const fromD = fromQ.data;
  const toD = toQ.data;
  const bothRich = isRich(fromD) && isRich(toD);
  const lines = !!fromD && !!toD && !bothRich;
  const lineQ = useDocsDiff(page.id, lines ? Math.min(from, to) : null, lines ? Math.max(from, to) : null);

  const changes = useMemo(
    () => (isRich(fromD) && isRich(toD) ? diffBlocks(fromD.content, toD.content) : []),
    [fromD, toD],
  );
  const counts = useMemo(() => countChanges(changes), [changes]);
  const total = counts.changed + counts.added + counts.removed + counts.moved;
  const [limit, setLimit] = useState(Infinity);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLimit(total > LARGE ? STEP : Infinity);
    setOpen(new Set());
    setActive(0);
  }, [from, to, total]);

  const items = useMemo(() => diffItems(changes, limit, open), [changes, limit, open]);
  const listed = useMemo(() => changes.filter((c) => c.kind !== 'same'), [changes]);

  // the page drawn: the newer blocks, with each removed block where it was
  const { merged, roles } = useMemo(() => {
    const roleOf = new Map<RichDoc, Role>();
    const content: RichDoc[] = [];
    const nodeOf = (c: BlockChange) => (c.kind === 'removed' ? c.before : c.after) as RichDoc;
    for (const it of items) {
      if (it.type === 'change') {
        const n = nodeOf(it.change);
        content.push(n);
        roleOf.set(n, { kind: 'change', c: it.change, index: it.index });
      } else {
        it.blocks.forEach((b, i) => {
          const n = nodeOf(b);
          content.push(n);
          roleOf.set(n, i === 0 ? { kind: 'fold', key: it.key, blocks: it.blocks } : null);
        });
      }
    }
    return { merged: { type: 'doc', content } as RichDoc, roles: roleOf };
  }, [items]);

  const labels = useMemo(() => ({ from: `v${from}`, to: `v${to}` }), [from, to]);
  const names = useMemo(
    () => new Map(listed.map((c) => [c, jumpLabel(c, c.kind === 'removed' ? fromD?.content : toD?.content)])),
    [listed, fromD, toD],
  );
  const showFold = useCallback((key: string) => setOpen((s) => new Set(s).add(key)), []);
  const wrap = useCallback(
    (node: RichDoc, rendered: ReactNode): ReactNode => {
      const role = roles.get(node);
      if (role === null) return null;
      if (!role) return rendered;
      if (role.kind === 'fold') return <FoldRow blocks={role.blocks} onShow={() => showFold(role.key)} />;
      return (
        <BlockChangeView
          c={role.c}
          rendered={rendered}
          mode={mode}
          index={role.index}
          labels={labels}
          name={names.get(role.c)?.name}
        />
      );
    },
    [roles, mode, labels, names, showFold],
  );

  const jump = useCallback(
    (i: number) => {
      setActive(i);
      // a change past the limit is drawn first
      if (i >= limit) setLimit(Infinity);
      requestAnimationFrame(() => {
        const el = bodyRef.current?.querySelector<HTMLElement>(`[data-change-index="${i}"]`);
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      });
    },
    [limit],
  );
  useEffect(() => {
    bodyRef.current?.querySelectorAll('.hx-block.is-active').forEach((e) => e.classList.remove('is-active'));
    bodyRef.current?.querySelector(`[data-change-index="${active}"]`)?.classList.add('is-active');
  }, [active, items, mode]);

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (!listed.length || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j') jump(Math.min(listed.length - 1, active + 1));
      else if (k === 'k') jump(Math.max(0, active - 1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [keys, onClose, listed.length, active, jump]);

  const fromV = versions.find((v) => v.version === from);
  const toV = versions.find((v) => v.version === to);
  const loading = fromQ.isLoading || toQ.isLoading || (lines && lineQ.isLoading);
  const failed = fromQ.isError || toQ.isError || (lines && lineQ.isError);
  const err = fromQ.error ?? toQ.error ?? lineQ.error;
  const retry = () => {
    void fromQ.refetch();
    void toQ.refetch();
    if (lines) void lineQ.refetch();
  };
  const older = Math.min(from, to);
  const newer = Math.max(from, to);
  const olderD = older === from ? fromD : toD;
  const newerD = older === from ? toD : fromD;
  const olderV = versions.find((v) => v.version === older);
  const newerV = versions.find((v) => v.version === newer);
  const aroundConversion = lines && isRich(newerD) && !isRich(olderD);
  const restoreV = fromV && from !== page.version ? fromV : null;
  const restoreBtn = restoreV && (
    <button type="button" className="st-btn st-btn-primary hx-head-btn" onClick={() => onRestore(restoreV)}>
      <Icon name="i19" size={phone ? 15.5 : 13} strokeWidth={2.4} />
      Restore v{from}
    </button>
  );
  const modeToggle = !phone && (
    <div role="group" aria-label="Diff layout" className="hx-seg">
      {(['inline', 'side-by-side'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={pickMode === m} onClick={() => setPickMode(m)}>
          {m === 'inline' ? 'Inline' : 'Side by side'}
        </button>
      ))}
    </div>
  );

  const pickers = (
    <span className="hx-pair-pick">
      <VersionPick
        label="From version"
        value={from}
        other={to}
        versions={versions}
        current={page.version}
        onChange={(v) => onPair(v, to)}
      />
      <button
        type="button"
        className="hx-iconbtn"
        aria-label="Swap the versions"
        title="Swap"
        data-testid="hx-swap"
        onClick={() => onPair(to, from)}
      >
        <Icon name="i29" size={14} strokeWidth={2} />
      </button>
      <VersionPick
        label="To version"
        value={to}
        other={from}
        versions={versions}
        current={page.version}
        onChange={(v) => onPair(from, v)}
      />
    </span>
  );

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="hx-state" data-testid="hx-loading">
        <span className="hx-state-text">Loading diff…</span>
        {[60, 92, 84, 70].map((w) => (
          <span key={w} className="skel hx-skel" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  } else if (failed) {
    body = (
      <div className="hx-state" role="alert" data-testid="hx-error">
        <div className="hx-state-error">
          <Icon name="i22" size={14} strokeWidth={2.2} />
          <div>
            <b>
              Could not compare v{from} and v{to}.
            </b>{' '}
            The page is still readable. Check your connection and try again.
            <div className="hx-state-detail">{docsErrorDetail(err)?.message ?? extractError(err)}</div>
          </div>
        </div>
        <div>
          <button type="button" className="st-btn hx-btn" onClick={retry}>
            <Icon name="i41" size={13} strokeWidth={2.4} />
            Retry
          </button>
        </div>
      </div>
    );
  } else if (lines) {
    body = (
      <>
        <div className="hx-intro">
          <Icon name="i28" size={14} />
          {aroundConversion ? (
            <span data-testid="hx-conversion-note">
              v{newer} is the converted page. v{older} and older are Markdown, shown as they were. Spacing and small
              formatting may differ between them; nobody edited those.
            </span>
          ) : (
            <span>These versions are Markdown: changes are shown as the Markdown they were stored as.</span>
          )}
        </div>
        {lineQ.data && (
          <DiffView
            diff={lineQ.data}
            mode={(phone ? 'inline' : pickMode) as DiffMode}
            leftLabel={olderV ? { version: older, text: `${displayName(olderV.author)}, ${when(olderV)}` } : undefined}
            rightLabel={newerV ? { version: newer, text: `${displayName(newerV.author)}, ${when(newerV)}` } : undefined}
          />
        )}
      </>
    );
  } else if (noDifference(counts)) {
    body = (
      <div className="hx-state" data-testid="hx-same">
        <div className="hx-state-same">
          <span className="hx-state-ico">
            <Icon name="check" size={18} strokeWidth={2.4} />
          </span>
          <div>
            <b>These versions look the same</b>
            <div className="hx-state-sub">
              v{from} and v{to} have the same blocks.
            </div>
          </div>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        {!phone && !tablet && (
          <div className="hx-intro">
            <Icon name="i28" size={14} />
            <span>Comparing the published versions as the page looks. Changes are shown block by block.</span>
            <CountsLine counts={counts} />
          </div>
        )}
        {total > LARGE && limit !== Infinity && (
          <div className="hx-state hx-large" data-testid="hx-large">
            <b>{total} blocks changed</b>
            <span className="hx-state-sub">
              Showing the first {limit}. The rest are folded so the page stays quick.
            </span>
            <div className="hx-state-btns">
              <button type="button" className="st-btn hx-btn" onClick={() => setLimit(Infinity)}>
                Show all {total}
              </button>
              {limit + STEP < total && (
                <button type="button" className="st-btn hx-btn" onClick={() => setLimit(limit + STEP)}>
                  Next {STEP}
                </button>
              )}
            </div>
          </div>
        )}
        {mode === 'side-by-side' && fromV && toV && (
          <div className="hx-cols-head">
            {[fromV, toV].map((v) => (
              <div key={v.version}>
                <b className="hx-pick-v">v{v.version}</b>
                <Avatar name={v.author} />
                <span>
                  {displayName(v.author)}, {when(v)}
                </span>
              </div>
            ))}
          </div>
        )}
        {phone && (
          <div className="hx-phone-counts">
            <CountsLine counts={counts} words={false} />
          </div>
        )}
        <div className={`hx-page hx-mode-${mode}`} data-testid="hx-page">
          <RichDocView doc={merged} projectId={projectId} blockWrap={wrap} />
        </div>
      </>
    );
  }

  const jumpList = !lines && listed.length > 0 && !loading && !failed && (
    <nav aria-label="Jump to a change" className={tablet ? 'hx-chips' : 'hx-jump'}>
      {!tablet && <div className="hx-jump-head">Jump to a change</div>}
      {listed.map((c, i) => {
        const n = names.get(c);
        return (
          <button
            key={c.id + c.kind}
            type="button"
            className={`hx-jump-item hx-j-${c.kind}`}
            aria-current={i === active ? 'true' : undefined}
            onClick={() => jump(i)}
          >
            <span className="hx-jump-name">{n?.name}</span>
            <span className="hx-jump-what">{n?.what}</span>
          </button>
        );
      })}
      {!tablet && (
        <>
          <div className="hx-jump-keys">
            <span className="dk-kbd">J</span>
            <span className="dk-kbd">K</span>
            next / previous change
          </div>
          <div className="hx-jump-foot">Unchanged blocks are folded away.</div>
        </>
      )}
    </nav>
  );

  return (
    <div
      className="docs-root hx-compare"
      data-layout={layout}
      role="dialog"
      aria-modal="true"
      aria-label="Page history"
      data-testid="history-compare"
    >
      <header className="hx-compare-head">
        {phone ? (
          <>
            <button type="button" className="hx-iconbtn" aria-label="Back to the version list" onClick={onBack}>
              <Icon name="i60" size={20} strokeWidth={2} />
            </button>
            <span className="hx-compare-title">Compare</span>
            <button type="button" aria-label="Close" className="hx-iconbtn" onClick={onClose}>
              <Icon name="i08" size={18} strokeWidth={2} />
            </button>
          </>
        ) : tablet ? (
          <>
            <button type="button" className="hx-iconbtn" aria-label="Back to page" onClick={onBack}>
              <Icon name="i60" size={20} strokeWidth={2} />
            </button>
            <span className="hx-compare-title">{page.title}</span>
            <span className="hx-compare-sep" aria-hidden="true">
              ›
            </span>
            <span className="hx-compare-what">
              Compare v{from} and v{to}
            </span>
            <button type="button" aria-label="Close" className="hx-iconbtn" onClick={onClose}>
              <Icon name="i08" size={18} strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
            <button type="button" className="st-btn st-btn-sm" onClick={onBack}>
              <Icon name="i60" size={13} strokeWidth={2} />
              Back to page
            </button>
            <span className="hx-compare-title">{page.title}</span>
            {pickers}
            {fromV && toV && (isConversion(fromV) || isConversion(toV)) && (
              <span className="hx-conv-chip">Converted</span>
            )}
            <span style={{ flex: 1 }} />
            {modeToggle}
            {restoreBtn}
            <button type="button" aria-label="Close" className="hx-iconbtn" onClick={onClose}>
              <Icon name="i08" size={16} strokeWidth={2} />
            </button>
          </>
        )}
      </header>
      {phone && <div className="hx-phone-pick">{pickers}</div>}
      {tablet && (
        // History2 frame 12: the pair, the counts, Inline / Side by side and Restore in one bar under the head
        <div className="hx-subbar" data-testid="hx-subbar">
          {pickers}
          {!loading && !lines && <CountsLine counts={counts} />}
          <span style={{ flex: 1 }} />
          {modeToggle}
          {restoreBtn}
        </div>
      )}
      {tablet && jumpList}
      <div className="hx-compare-main">
        <div ref={bodyRef} className="hx-compare-body">
          {body}
        </div>
        {!tablet && !phone && jumpList}
      </div>
      {phone && (
        <footer className="hx-phone-foot">
          {listed.length > 0 && (
            <>
              <button
                type="button"
                className="hx-iconbtn hx-step"
                aria-label="Previous change"
                onClick={() => jump(Math.max(0, active - 1))}
              >
                <Icon name="i60" size={15} strokeWidth={2} />
              </button>
              <span className="hx-step-text">
                {Math.min(active + 1, listed.length)} of {listed.length}
              </span>
              <button
                type="button"
                className="hx-iconbtn hx-step"
                aria-label="Next change"
                onClick={() => jump(Math.min(listed.length - 1, active + 1))}
              >
                <Icon name="i29" size={15} strokeWidth={2} />
              </button>
            </>
          )}
          <span style={{ flex: 1 }} />
          {restoreBtn}
        </footer>
      )}
    </div>
  );
}
