import { useEffect, useRef, useState } from 'react';
import type { NotificationRow } from '../../types/notifications';

/** Whether a key press belongs to something being typed into. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

type RowAction = 'open' | 'read' | 'snooze';
const KEY_ACTIONS = new Map<string, RowAction>([
  ['enter', 'open'],
  ['e', 'read'],
  ['s', 'snooze'],
]);

/** The index J (down) or K (up) moves to; K on no selection lands on the first row. */
function moveIndex(k: string, i: number, count: number): number {
  if (k === 'j') return Math.min(count - 1, i + 1);
  return Math.max(0, i < 0 ? 0 : i - 1);
}

/**
 * J and K move through the rows, Enter opens, E marks read, S snoozes for an hour (design H, Keyboard). Ignored
 * while typing. Returns the id of the row the keys are on.
 */
export function useRowKeys(
  active: boolean,
  rows: NotificationRow[],
  act: (row: NotificationRow, id: RowAction) => void,
): string | null {
  const [selected, setSelected] = useState<string | null>(null);
  const state = useRef({ rows, selected, act });
  state.current = { rows, selected, act };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e.target)) return;
      const { rows: list, selected: sel, act: run } = state.current;
      const i = list.findIndex((r) => r.id === sel);
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'k') {
        if (list.length === 0) return;
        e.preventDefault();
        const next = moveIndex(k, i, list.length);
        setSelected(list[next].id);
        document.querySelector(`[data-row-id="${list[next].id}"]`)?.scrollIntoView?.({ block: 'nearest' });
        return;
      }
      const what = KEY_ACTIONS.get(k);
      if (i < 0 || !what) return;
      // Enter on a focused button keeps its own meaning
      if (k === 'enter' && (e.target as HTMLElement | null)?.closest?.('button')) return;
      e.preventDefault();
      run(list[i], what);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  return selected;
}
