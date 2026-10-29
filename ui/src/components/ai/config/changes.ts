import type { MemberDraft } from './parts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** How many separate things differ between the saved form and the draft (the “3 unsaved changes” of the bar):
 *  one per changed field, one per added, removed or edited item of a list, one for a typed key. */
export function countChanges(initial: MemberDraft, draft: MemberDraft, newKey: boolean): number {
  let n = newKey ? 1 : 0;
  for (const k of Object.keys(draft) as (keyof MemberDraft)[]) {
    if (k === 'config') continue;
    if (!same(initial[k], draft[k])) n += 1;
  }
  const a = initial.config as unknown as Record<string, unknown>;
  const b = draft.config as unknown as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    const x = a[k];
    const y = b[k];
    if (same(x, y)) continue;
    if (Array.isArray(x) && Array.isArray(y) && y.every((i) => i && typeof i === 'object' && 'id' in (i as object))) {
      const byId = new Map((x as { id: string }[]).map((i) => [i.id, i]));
      const ids = new Set((y as { id: string }[]).map((i) => i.id));
      n += (y as { id: string }[]).filter((i) => !byId.has(i.id) || !same(byId.get(i.id), i)).length;
      n += [...byId.keys()].filter((id) => !ids.has(id)).length;
    } else if (Array.isArray(x) && Array.isArray(y)) {
      const sx = new Set(x.map((i) => JSON.stringify(i)));
      const sy = new Set(y.map((i) => JSON.stringify(i)));
      n += [...sy].filter((i) => !sx.has(i)).length + [...sx].filter((i) => !sy.has(i)).length || 1;
    } else if (x && y && typeof x === 'object' && typeof y === 'object') {
      const ox = x as Record<string, unknown>;
      const oy = y as Record<string, unknown>;
      n += Object.keys(oy).filter((kk) => !same(ox[kk], oy[kk])).length || 1;
    } else {
      n += 1;
    }
  }
  return n;
}
