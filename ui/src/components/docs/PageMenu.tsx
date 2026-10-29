import { useEffect, useRef } from 'react';
import type { DocsPage } from '../../types/docs';
import { Icon } from './Icon';

export type PageMenuAction =
  'rename' | 'add-child' | 'duplicate' | 'copy-link' | 'copy-markdown' | 'move' | 'history' | 'export' | 'delete';

interface PageMenuProps {
  page: DocsPage;
  onAction: (a: PageMenuAction) => void;
  onClose: () => void;
}

interface Item {
  action: PageMenuAction;
  label: string;
  icon: string;
  kbd?: string;
  danger?: boolean;
}

const GROUPS: Item[][] = [
  [
    { action: 'rename', label: 'Rename', icon: 'i15', kbd: 'F2' },
    { action: 'add-child', label: 'Add child page', icon: 'i23', kbd: 'N' },
    { action: 'duplicate', label: 'Duplicate', icon: 'i24', kbd: 'Ctrl D' },
    { action: 'copy-link', label: 'Copy link', icon: 'i11', kbd: 'Ctrl L' },
    { action: 'copy-markdown', label: 'Copy as Markdown', icon: 'i18', kbd: 'Ctrl Shift C' },
    { action: 'move', label: 'Move to…', icon: 'i35', kbd: 'M' },
  ],
  [
    { action: 'history', label: 'Page history', icon: 'i39', kbd: 'H' },
    { action: 'export', label: 'Export as Markdown', icon: 'i43' },
  ],
  [{ action: 'delete', label: 'Delete', icon: 'i12', kbd: 'Del', danger: true }],
];

/**
 * Page-level keyboard shortcuts from the menu (F2, N, Ctrl D, Ctrl L, Ctrl Shift C, M, H, Del).
 * They apply while the page is open and no text field is focused.
 * @param onAction - Called with the menu action matching the pressed key.
 * @param enabled - Set false to disable the shortcuts.
 */
export function usePageShortcuts(onAction: (a: PageMenuAction) => void, enabled = true) {
  const ref = useRef(onAction);
  ref.current = onAction;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      let a: PageMenuAction | null = null;
      if (!mod && !e.altKey && !e.shiftKey) {
        if (e.key === 'F2') a = 'rename';
        else if (k === 'n') a = 'add-child';
        else if (k === 'm') a = 'move';
        else if (k === 'h') a = 'history';
        else if (e.key === 'Delete') a = 'delete';
      } else if (mod && !e.altKey) {
        if (!e.shiftKey && k === 'd') a = 'duplicate';
        else if (!e.shiftKey && k === 'l') a = 'copy-link';
        else if (e.shiftKey && k === 'c') a = 'copy-markdown';
      }
      if (!a) return;
      e.preventDefault();
      ref.current(a);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/**
 * The page header "···" menu. Position it with a relatively-positioned wrapper; it opens below, right-aligned.
 * @param props.onAction - Called with the chosen menu action.
 * @param props.onClose - Called to dismiss the menu.
 */
export function PageMenu({ onAction, onClose }: PageMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  function moveFocus(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div
      ref={rootRef}
      className="dk-menu docs-root"
      role="menu"
      aria-label="Page actions"
      onKeyDown={moveFocus}
      style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 290, zIndex: 60 }}
    >
      {GROUPS.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div style={{ height: 1, background: '#EEF3EF', margin: '4px 6px' }} />}
          {group.map((it) => (
            <button
              key={it.action}
              type="button"
              role="menuitem"
              className="dk-mi"
              data-testid={`menu-${it.action}`}
              onClick={() => {
                onClose();
                onAction(it.action);
              }}
              style={{
                width: '100%',
                border: 'none',
                background: 'none',
                textAlign: 'left',
                fontFamily: 'inherit',
                ...(it.danger ? { color: '#C4432A' } : {}),
              }}
            >
              <span style={{ color: it.danger ? '#C4432A' : '#5B6B60', display: 'flex' }}>
                <Icon name={it.icon} size={15} strokeWidth={1.8} />
              </span>
              <span>{it.label}</span>
              {it.kbd && (
                <span style={{ marginLeft: 'auto' }}>
                  <span className="dk-kbd">{it.kbd}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
