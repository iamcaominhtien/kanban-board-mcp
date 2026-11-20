/**
 * The New page menu of the tree (design "Starting and shaping a page", frames 24 and 56): Blank page, From
 * template…, Import…, Paste from the clipboard, and the templates used lately on this device.
 */

import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { recentTemplates } from './galleryRules';
import './start.css';

/** What the menu asks for. */
export type NewPageChoice =
  { kind: 'blank' } | { kind: 'gallery' } | { kind: 'import' } | { kind: 'paste' } | { kind: 'template'; id: string };

/**
 * The menu (position it with a relatively positioned wrapper; it opens above its button).
 * @param props.onChoose - Called with the choice; the menu closes itself first.
 * @param props.onClose - Called to dismiss the menu.
 * @param props.touch - Tablet and phone: 48 px rows.
 */
export function NewPageMenu({
  onChoose,
  onClose,
  touch = false,
}: {
  onChoose: (c: NewPageChoice) => void;
  onClose: () => void;
  touch?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const recent = recentTemplates();
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const pick = (c: NewPageChoice) => {
    onClose();
    onChoose(c);
  };
  const row = touch ? { minHeight: 48 } : undefined;
  const newTag = (
    <span
      style={{
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        boxSizing: 'border-box',
        padding: '0 9px',
        fontSize: 9.5,
        fontWeight: 700,
        color: '#244E78',
        background: '#E8F1FA',
        border: '1px solid #C9DDF0',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        flex: 'none',
      }}
    >
      New
    </span>
  );
  const item = (label: string, icon: string, c: NewPageChoice, extra?: React.ReactNode, testId?: string) => (
    <button
      key={testId ?? label}
      type="button"
      role="menuitem"
      className="dk-mi"
      data-testid={testId}
      onClick={() => pick(c)}
      style={{ width: '100%', border: 'none', background: 'none', textAlign: 'left', fontFamily: 'inherit', ...row }}
    >
      <span style={{ color: '#5B6B60', display: 'flex' }}>
        <Icon name={icon} size={14} strokeWidth={1.9} />
      </span>
      <span>{label}</span>
      {extra}
    </button>
  );
  return (
    <div
      ref={ref}
      className="dk-menu docs-root"
      role="menu"
      aria-label="New page"
      style={{ position: 'absolute', left: 0, bottom: 'calc(100% + 6px)', width: 260, zIndex: 60 }}
    >
      {item(
        'Blank page',
        'i00',
        { kind: 'blank' },
        touch ? undefined : (
          <span style={{ marginLeft: 'auto' }}>
            <span className="dk-kbd">N</span>
          </span>
        ),
        'new-menu-blank',
      )}
      {item('From template…', 'i24', { kind: 'gallery' }, newTag, 'new-menu-template')}
      {item('Import…', 'i26', { kind: 'import' }, newTag, 'new-menu-import')}
      {item('Paste from the clipboard', 'i18', { kind: 'paste' }, newTag, 'new-menu-paste')}
      {recent.length > 0 && (
        <>
          <div style={{ height: 1, background: '#E3E8E5', margin: '4px 6px' }} />
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: '#9AA8A0',
              padding: '5px 10px 2px',
            }}
          >
            Recent templates
          </div>
          {recent.map((t) => item(t.name, 'page', { kind: 'template', id: t.id }))}
        </>
      )}
    </div>
  );
}
