import { useEffect } from 'react';
import { inElectron } from './notificationUi';

const PREFIX = /^\(\d+\) /;

/** The web tab shows the red count in front of its title: "(5) Kanban Board". Not inside the desktop app (its icon has it). */
export function useTabTitle(needs: number) {
  useEffect(() => {
    if (inElectron()) return;
    const apply = () => {
      const base = document.title.replace(PREFIX, '');
      const want = needs > 0 ? `(${needs}) ${base}` : base;
      if (document.title !== want) document.title = want;
    };
    apply();
    const el = document.querySelector('title');
    const mo = el ? new MutationObserver(apply) : null;
    if (el) mo?.observe(el, { childList: true, characterData: true, subtree: true });
    return () => {
      mo?.disconnect();
      document.title = document.title.replace(PREFIX, '');
    };
  }, [needs]);
}
