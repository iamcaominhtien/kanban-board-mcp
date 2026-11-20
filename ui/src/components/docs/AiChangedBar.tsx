import { useEffect, useMemo, useRef, useState } from 'react';
import { useDocsVersion, useRestoreVersion } from '../../api/docs';
import { usePageWork } from '../../api/docsWork';
import { extractError } from '../../api/extractError';
import type { Member } from '../../types/ticket';
import type { DocsPage } from '../../types/docs';
import { absoluteTime, relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { countChanges, diffBlocks, formatWords, type BlockChange, type ChangeCounts } from './history/blockDiff';
import { blockName, typeName } from './suggestions/describe';
import { SgIcon, Spark, rowIcon } from './suggestions/sgIcons';
import './suggestions/suggestions.css';

/** Whether the latest published version was written by an AI team of the project, and which one. */
export function aiWriter(page: DocsPage, members: Member[]): Member | null {
  if (page.version < 2) return null;
  const by = page.updatedBy.trim().toLowerCase();
  return members.find((m) => m.kind === 'ai' && m.name.trim().toLowerCase() === by) ?? null;
}

/** One row of the list: where the block is and what changed in it, in words. */
export interface EditedRow {
  /** The block to scroll to (null for a removed block). */
  blockId: string | null;
  /** "Paragraph 2", "Heading 2 “What changed”", "After paragraph 4". */
  place: string;
  /** "Colour: none → green", "Text edited", "Pull quote", "Removed". */
  what: string;
  /** The block's type, for its icon. */
  type: string | null;
  /** The first formatting change, for its icon. */
  firstChange: string | null;
}

/** The changes of a block comparison as rows of the chip's list (moves and unchanged blocks left out). */
export function editedRows(changes: BlockChange[], newDoc: DocsPage['content']): EditedRow[] {
  const doc = newDoc ?? null;
  const rows: EditedRow[] = [];
  changes.forEach((c, i) => {
    if (c.kind === 'same' || (c.kind === 'moved' && !c.changes.length)) return;
    const node = c.after ?? c.before;
    const id = typeof c.after?.attrs?.blockId === 'string' ? (c.after.attrs.blockId as string) : null;
    if (c.kind === 'added') {
      // "After paragraph 4" · "Pull quote" (A 2): where it went and what it is
      const prev = changes
        .slice(0, i)
        .reverse()
        .find((p) => p.after);
      const place = prev?.after
        ? (() => {
            const n = blockName(prev.after, doc);
            return `After ${n.charAt(0).toLowerCase()}${n.slice(1)}`;
          })()
        : 'At the start';
      rows.push({ blockId: id, place, what: typeName(node), type: node?.type ?? null, firstChange: null });
      return;
    }
    if (c.kind === 'removed') {
      rows.push({
        blockId: null,
        place: blockName(c.before, null),
        what: 'Removed',
        type: c.before?.type ?? null,
        firstChange: null,
      });
      return;
    }
    const first = c.changes[0];
    const what = first ? formatWords(first) : c.draw === 'text' ? 'Text edited' : 'Changed as a whole';
    rows.push({
      blockId: id,
      place: blockName(c.after, doc),
      what,
      type: node?.type ?? null,
      firstChange: first?.what ?? null,
    });
  });
  return rows;
}

/**
 * What a team did to the page, in the chip's words: "edited 3 blocks, added 1", "added 2 blocks", "removed 1 block";
 * "changed this page" when no block changed (the title, or a Markdown page).
 * @param counts - From {@link countChanges}.
 */
export function editedPhrase(counts: ChangeCounts | null): string {
  if (!counts) return 'changed this page';
  const parts = (
    [
      [counts.changed, 'edited'],
      [counts.added, 'added'],
      [counts.removed, 'removed'],
      [counts.moved, 'moved'],
    ] as [number, string][]
  ).filter(([n]) => n > 0);
  if (!parts.length) return 'changed this page';
  return parts
    .map(([n, verb], i) => (i === 0 ? `${verb} ${n} ${n === 1 ? 'block' : 'blocks'}` : `${verb} ${n}`))
    .join(', ');
}

interface Props {
  page: DocsPage;
  projectId: string;
  members: Member[];
  /** Whether the reader can edit the page (Undo restores the previous version). */
  canEdit: boolean;
  /** Open the diff between two versions. */
  onCompare?: (from: number, to: number) => void;
}

/**
 * "Docs team edited 3 blocks, added 1 · 2 min ago" (design "AI teams on rich pages", A 2): the header chip of a page
 * whose latest version an AI team published directly. It opens the list of what changed, block by block ("Paragraph
 * 2 · Colour: none → green"), with See changes and Undo. The rows come from comparing the version before with this
 * one (history/blockDiff.ts); a Markdown page shows the chip without rows.
 * @param props.page - Page being read.
 * @param props.projectId - Project of the page.
 * @param props.members - The project's members (an AI team's name is the page's `updatedBy`).
 * @param props.canEdit - Show Undo.
 * @param props.onCompare - Called with the previous version and the latest to open their diff.
 */
export function AiEditedChip({ page, projectId, members, canEdit, onCompare }: Props) {
  const toast = useToast();
  const restore = useRestoreVersion(projectId);
  const writer = aiWriter(page, members);
  const previous = page.version - 1;
  const rich = page.format === 'rich';
  const before = useDocsVersion(writer && rich ? page.id : null, writer && rich ? previous : null).data;
  const work = usePageWork(writer ? page.id : null).data;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const changes = useMemo(
    () => (rich && before?.content ? diffBlocks(before.content, page.content ?? null) : null),
    [rich, before, page.content],
  );
  if (!writer) return null;
  const rows = changes ? editedRows(changes, page.content) : [];
  const counts = changes ? countChanges(changes) : null;
  const line = `${writer.name} ${editedPhrase(counts)}`;
  const run = work?.tickets.find((t) => t.run?.member === writer.name);

  const undo = async () => {
    try {
      const p = await restore.mutateAsync({ pageId: page.id, version: previous });
      setConfirming(false);
      setOpen(false);
      toast.success(`Restored v${previous}`, `The page is v${p.version} now, with the text of v${previous}.`);
    } catch (e) {
      setConfirming(false);
      toast.error("Couldn't undo the change", extractError(e));
    }
  };
  const jump = (id: string | null) => {
    if (!id) return;
    setOpen(false);
    document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'center',
    });
  };

  return (
    <span className="sg-hchip-wrap" ref={wrap}>
      <button
        type="button"
        className="sg-hchip"
        data-testid="ai-edited-chip"
        aria-expanded={open}
        title={absoluteTime(page.updatedAt)}
        onClick={() => setOpen((v) => !v)}
      >
        <Spark size={13} color="#5B3AA6" />
        <span>
          {line} · {relativeTime(page.updatedAt)}
        </span>
        <SgIcon name={open ? 'chevUp' : 'chevDown'} size={12} sw={2.6} color="#5B3AA6" />
      </button>
      {open && (
        <div
          className="sg-edited-pop docs-root"
          role="dialog"
          aria-label="What the team changed"
          data-testid="ai-edited-list"
        >
          <div className="sg-edited-head">
            <b>{rows.length ? `${rows.length} change${rows.length === 1 ? '' : 's'}` : `v${page.version}`}</b>
            <span>
              by {writer.name}
              {run ? ` · Run ${run.id}` : ''}
            </span>
          </div>
          {rows.map((r, i) => (
            <button
              key={`${r.blockId ?? 'x'}-${i}`}
              type="button"
              className="sg-edited-row"
              data-testid="ai-edited-row"
              disabled={!r.blockId}
              onClick={() => jump(r.blockId)}
            >
              <span className="sg-edited-icon">
                <SgIcon name={rowIcon(r.firstChange, r.type)} size={14} />
              </span>
              <span className="sg-edited-text">
                <span className="sg-edited-place">{r.place}</span>
                <span className="sg-edited-what">{r.what}</span>
              </span>
              <span className="sg-edited-n">{i + 1}</span>
            </button>
          ))}
          {confirming ? (
            <div className="sg-edited-foot">
              <span className="sg-edited-ask">Go back to v{previous}? It is kept as a new version.</span>
              <button type="button" className="sg-btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="sg-btn sg-btn-primary"
                disabled={restore.isPending}
                onClick={() => void undo()}
                data-testid="ai-changed-undo-yes"
              >
                {restore.isPending ? 'Restoring…' : `Restore v${previous}`}
              </button>
            </div>
          ) : (
            <div className="sg-edited-foot">
              {onCompare && (
                <button
                  type="button"
                  className="sg-btn"
                  onClick={() => {
                    setOpen(false);
                    onCompare(previous, page.version);
                  }}
                  data-testid="ai-changed-diff"
                >
                  See changes
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="sg-btn"
                  onClick={() => setConfirming(true)}
                  data-testid="ai-changed-undo"
                >
                  Undo
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
