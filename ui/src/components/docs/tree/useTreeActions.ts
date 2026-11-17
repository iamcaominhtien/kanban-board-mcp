/**
 * The tree's actions on pages, each followed by a toast that says what happened and offers Undo for 10 seconds
 * (design "Rich Docs — organising pages", C 22 and D 39): moving one page (drag, keyboard, reorder buttons), and
 * moving, duplicating, deleting or exporting several selected pages.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { client } from '../../../api/client';
import { docsErrorDetail, docsKeys } from '../../../api/docs';
import { extractError } from '../../../api/extractError';
import type { DocsTreeNode } from '../../../types/docs';
import { useToast } from '../../Toast';
import { plural } from '../docsShared';
import { childrenMap, descendantsOf, describeTarget, placeOf, type MoveTarget } from './treeModel';

/** How long Undo stays on a toast. */
export const UNDO_MS = 10_000;

/** The event the Export dialog listens for: export the given pages as one book. */
export const DOCS_EXPORT_EVENT = 'docs:export';

/** Asks the Export dialog to export pages as a book, in the given order. */
export function requestBookExport(pageIds: string[]): void {
  window.dispatchEvent(new CustomEvent(DOCS_EXPORT_EVENT, { detail: { scope: 'book', pageIds } }));
}

const errText = (e: unknown) => docsErrorDetail(e)?.message ?? extractError(e);

async function movePage(id: string, t: MoveTarget) {
  await client.post(`/docs/pages/${id}/move`, { parentId: t.parentId, beforeId: t.beforeId, afterId: t.afterId });
}

/**
 * The actions, for a project's tree.
 * @param projectId - The project.
 * @param nodes - The tree as it is now (where pages go back to on Undo).
 */
export function useTreeActions(projectId: string, nodes: DocsTreeNode[]) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    void qc.invalidateQueries({ queryKey: ['docs'] });
  }, [qc, projectId]);

  /** Moves one page with its children; says where it went, with Undo. Resolves to whether it moved. */
  const moveOne = useCallback(
    async (id: string, target: MoveTarget): Promise<boolean> => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return false;
      const back = placeOf(nodes, id);
      const kids = descendantsOf(nodes, id).length;
      try {
        await movePage(id, target);
      } catch (e) {
        toast.error(`Couldn’t move “${node.title}”`, errText(e), 8000, {
          label: 'Try again',
          onClick: () => void moveOne(id, target),
        });
        return false;
      } finally {
        refresh();
      }
      const parent = target.parentId ? nodes.find((n) => n.id === target.parentId) : undefined;
      const where = describeTarget(nodes, target, 'Moved', id);
      const detail = where.replace(/^Moved (under [^,]+|to the top level),? ?/, '');
      toast.showToast({
        variant: 'success',
        title: parent ? `Moved “${node.title}” under ${parent.title}` : `Moved “${node.title}” to the top level`,
        message: [
          detail && detail[0].toUpperCase() + detail.slice(1),
          kids ? `${plural(kids, 'child page')} moved with it` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            movePage(id, back)
              .then(() => toast.success(`Moved “${node.title}” back`))
              .catch((e) => toast.error("Couldn't undo the move", errText(e)))
              .finally(refresh);
          },
        },
      });
      return true;
    },
    [nodes, toast, refresh],
  );

  /** Moves the selected pages (roots, in tree order) to one place, one after the other, with Undo. */
  const moveMany = useCallback(
    async (roots: string[], target: MoveTarget) => {
      if (roots.length === 1) return moveOne(roots[0], target);
      const backs = roots.map((id) => ({ id, at: placeOf(nodes, id) }));
      let prev: string | null = null;
      try {
        for (const id of roots) {
          await movePage(id, prev ? { parentId: target.parentId, afterId: prev, beforeId: null } : target);
          prev = id;
        }
      } catch (e) {
        toast.error("Couldn't move every page", errText(e));
        refresh();
        return false;
      }
      refresh();
      const parent = target.parentId ? nodes.find((n) => n.id === target.parentId)?.title : null;
      toast.showToast({
        variant: 'success',
        title: `Moved ${plural(roots.length, 'page')} ${parent ? `under ${parent}` : 'to the top level'}`,
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            (async () => {
              for (const b of [...backs].reverse()) await movePage(b.id, b.at);
            })()
              .then(() => toast.success('Moved the pages back'))
              .catch((e) => toast.error("Couldn't undo the move", errText(e)))
              .finally(refresh);
          },
        },
      });
      return true;
    },
    [nodes, moveOne, toast, refresh],
  );

  /** Duplicates the selected pages with their child pages; each copy is a draft next to its original. */
  const duplicateMany = useCallback(
    async (roots: string[]) => {
      let made = 0;
      try {
        for (const id of roots) {
          const n = nodes.find((x) => x.id === id);
          await client.post(`/docs/pages/${id}/duplicate`, {
            title: n ? `Copy of ${n.title}` : undefined,
            includeChildren: true,
          });
          made += 1;
        }
        toast.success(`Duplicated ${plural(made, 'page')}`, 'The copies are drafts, with their child pages.');
      } catch (e) {
        toast.error(made ? `Duplicated ${made} of ${roots.length} pages` : "Couldn't duplicate the pages", errText(e));
      } finally {
        refresh();
      }
    },
    [nodes, toast, refresh],
  );

  /** Moves the selected pages (and their child pages) to the Recycle Bin, with Undo. */
  const deleteMany = useCallback(
    async (roots: string[]) => {
      const done: string[] = [];
      let pages = 0;
      try {
        for (const id of roots) {
          const res = await client.delete<{ deletedPages?: number }>(`/docs/pages/${id}`);
          done.push(id);
          pages += res.data?.deletedPages ?? 1 + descendantsOf(nodes, id).length;
        }
      } catch (e) {
        toast.error(
          done.length ? `Deleted ${done.length} of ${roots.length} pages` : "Couldn't delete the pages",
          errText(e),
        );
      } finally {
        refresh();
      }
      if (!done.length) return;
      toast.showToast({
        variant: 'success',
        title: `Moved ${plural(pages, 'page')} to the Recycle Bin`,
        message: 'Kept for 30 days',
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            (async () => {
              for (const id of done) await client.post(`/docs/pages/${id}/restore`);
            })()
              .then(() => toast.success(`Restored ${plural(pages, 'page')}`, 'Back in the tree, in their old places.'))
              .catch((e) => toast.error("Couldn't restore the pages", errText(e)))
              .finally(refresh);
          },
        },
      });
    },
    [nodes, toast, refresh],
  );

  /** Exports the selected pages as one book: their pages in tree order, children after their parent. */
  const exportMany = useCallback(
    (roots: string[]) => {
      const kids = childrenMap(nodes);
      const out: string[] = [];
      const walk = (id: string) => {
        out.push(id);
        for (const c of kids.get(id) ?? []) walk(c.id);
      };
      roots.forEach(walk);
      requestBookExport(out);
    },
    [nodes],
  );

  return { moveOne, moveMany, duplicateMany, deleteMany, exportMany };
}
