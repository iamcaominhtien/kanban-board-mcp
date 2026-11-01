import { expect, test } from 'vitest';
import type { CanvasBoard, CanvasDoc } from '../../api/canvases';
import { cloneDoc, differingIds, mergeAfterSave } from './docMerge';

const b = (id: string, x: number, rev = 1): CanvasBoard => ({
  id,
  page: 'p_1',
  name: id,
  kind: 'html',
  x,
  y: 0,
  w: 1280,
  h: 800,
  order: 0,
  ref: null,
  content: null,
  rev,
});
const doc = (boards: CanvasBoard[]): CanvasDoc => ({
  format: 'kanban-canvas',
  version: 1,
  pages: [{ id: 'p_1', name: 'P', rev: 1 }],
  boards,
  notes: [],
  arrows: [],
  labels: [],
});

test('after a save the server plane wins, with what I did meanwhile on top', () => {
  const sent = doc([b('b_1', 10), b('b_2', 0)]);
  // the server applied my move of b_1 (rev 5) and holds a frame somebody else added
  const server = doc([b('b_1', 10, 5), b('b_2', 0, 1), b('b_3', 900, 4)]);
  // while the request was in flight I moved b_2 and removed nothing
  const working = cloneDoc(sent);
  working.boards[1].x = 77;
  const merged = mergeAfterSave(server, sent, working);
  expect(merged.boards.map((x) => [x.id, x.x, x.rev])).toEqual([
    ['b_1', 10, 5],
    ['b_2', 77, 1],
    ['b_3', 900, 4],
  ]);
});

test('what I added or removed while the save was in flight is kept', () => {
  const sent = doc([b('b_1', 0), b('b_2', 5)]);
  const server = doc([b('b_1', 0, 3), b('b_2', 5, 3)]);
  const working = cloneDoc(sent);
  working.boards.splice(1, 1); // removed b_2 meanwhile
  working.notes.push({
    id: 'n_new',
    page: 'p_1',
    x: 0,
    y: 0,
    w: 160,
    h: 100,
    text: 'x',
    color: 'yellow',
    by: 'U',
    rev: undefined as unknown as number,
  });
  const merged = mergeAfterSave(server, sent, working);
  expect(merged.boards.map((x) => x.id)).toEqual(['b_1']);
  expect(merged.notes.map((x) => x.id)).toEqual(['n_new']);
});

test('which items differ between two planes', () => {
  const a = doc([b('b_1', 0), b('b_2', 0)]);
  const c = doc([b('b_1', 0, 9), b('b_2', 50), b('b_3', 0)]);
  expect(differingIds(a, c).sort()).toEqual(['b_2', 'b_3']);
});

test('an undone plane is saved with the revisions the server holds now, and cannot bring back a deleted board', async () => {
  const { rebaseRevs } = await import('./docMerge');
  const old = doc([b('b_1', 0, 2), b('b_2', 0, 2)]);
  old.notes.push({
    id: 'n_gone',
    page: 'p_1',
    x: 0,
    y: 0,
    w: 160,
    h: 100,
    text: 'x',
    color: 'yellow',
    by: 'U',
    rev: 2,
  });
  const base = doc([b('b_1', 50, 9)]); // b_2 was deleted and saved; the note never existed on the server
  const out = rebaseRevs(old, base);
  expect(out.boards.map((x) => [x.id, x.rev])).toEqual([['b_1', 9]]);
  expect(out.notes[0].rev).toBeUndefined(); // saved again as a new note
});
