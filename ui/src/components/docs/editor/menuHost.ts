import type { Editor, Range } from '@tiptap/core';

export interface MenuState {
  editor: Editor;
  range: Range;
  query: string;
  /** The text of the current line before the trigger, for the "Enter inserts" preview. */
  lineBefore: string;
  rect: DOMRect | null;
  run: (payload: unknown) => void;
}

/** Bridges a Tiptap suggestion plugin to a React menu rendered by the editor component (keeps React context). */
export class MenuHost {
  state: MenuState | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.state;

  set(state: MenuState | null) {
    this.state = state;
    this.listeners.forEach((l) => l());
  }
}
