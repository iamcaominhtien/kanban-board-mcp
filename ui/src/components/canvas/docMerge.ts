import type { CanvasDoc } from '../../api/canvases';

const LISTS = ['pages', 'boards', 'notes', 'arrows', 'labels'] as const;
type Item = { id: string; rev: number } & Record<string, unknown>;

/** The plane as a plain copy. */
export function cloneDoc(doc: CanvasDoc): CanvasDoc {
  return JSON.parse(JSON.stringify(doc)) as CanvasDoc;
}

const sameItem = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * After a save: take the server's plane (it holds what other people did meanwhile and the new revisions), but keep
 * what this person changed *while the request was in flight* (compare `sent`, what was sent, with `working`, what is
 * on screen now). Items they added meanwhile stay, items they removed meanwhile stay removed.
 * @param server - The plane the server returned.
 * @param sent - The plane as it was when the save started.
 * @param working - The plane on screen now.
 */
export function mergeAfterSave(server: CanvasDoc, sent: CanvasDoc, working: CanvasDoc): CanvasDoc {
  const out = cloneDoc(server);
  for (const list of LISTS) {
    const srv = out[list] as unknown as Item[];
    const sentMap = new Map((sent[list] as unknown as Item[]).map((i) => [i.id, i]));
    const workMap = new Map((working[list] as unknown as Item[]).map((i) => [i.id, i]));
    for (const [id, w] of workMap) {
      const s = sentMap.get(id);
      const i = srv.findIndex((x) => x.id === id);
      if (!s || !sameItem(s, w)) {
        const keep = { ...w, rev: i >= 0 ? srv[i].rev : w.rev } as Item;
        if (i >= 0) srv[i] = keep;
        else if (!s) srv.push(keep);
      }
    }
    for (const id of sentMap.keys()) {
      if (!workMap.has(id)) {
        const i = srv.findIndex((x) => x.id === id);
        if (i >= 0) srv.splice(i, 1);
      }
    }
  }
  return out;
}

/**
 * Ids of the items that differ between two planes (to tell a person which frame or note both of them changed).
 * @param a - One plane.
 * @param b - The other.
 */
export function differingIds(a: CanvasDoc, b: CanvasDoc): string[] {
  const out: string[] = [];
  for (const list of LISTS) {
    const am = new Map((a[list] as unknown as Item[]).map((i) => [i.id, i]));
    for (const i of b[list] as unknown as Item[]) {
      const x = am.get(i.id);
      if (!x || !sameItem({ ...x, rev: 0 }, { ...i, rev: 0 })) out.push(i.id);
    }
  }
  return out;
}

/**
 * A plane from the undo history, made ready to save again: its items carry the revisions the server holds *now*
 * (they were older when the snapshot was taken, and an old revision reads as "somebody else changed it"). Boards that
 * are no longer on the server cannot be brought back by a layout save, so they are left out.
 * @param old - The plane from the history.
 * @param base - The plane as the server last had it.
 */
export function rebaseRevs(old: CanvasDoc, base: CanvasDoc): CanvasDoc {
  const out = cloneDoc(old);
  for (const list of LISTS) {
    const known = new Map((base[list] as unknown as Item[]).map((i) => [i.id, i.rev]));
    const items = out[list] as unknown as Item[];
    out[list] = items
      .filter((i) => list !== 'boards' || known.has(i.id))
      .map((i) => ({ ...i, rev: known.get(i.id) as number })) as never;
  }
  return out;
}
