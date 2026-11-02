import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LineIcon } from './LineIcon';
import styles from './MenuSelect.module.css';

export interface MenuOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A second line under the label (the design's two-line options). */
  hint?: ReactNode;
  /** Shown before the label (an avatar, a dot, a LineIcon). */
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * The design's own dropdown, for the places where it draws more than a plain field: a chip ("All agents ⌄"), a
 * range button with a calendar icon ("Last 7 days ⌄"), options with a second line or an avatar. For a plain field
 * the styled native <select> (index.css) is enough.
 *
 * It behaves like a select for keyboard and screen-reader users: a button with aria-haspopup="listbox", a listbox of
 * options with aria-selected; Arrow keys, Home, End and type-ahead move, Enter or Space picks, Esc and Tab close and
 * give the focus back. The list is rendered in the body (a transformed or clipped parent cannot cut it off) under the
 * button, or above it when there is no room.
 */
export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  variant = 'field',
  icon,
  prefix,
  placeholder = 'Choose…',
  disabled,
  testId,
  menuWidth,
  style,
  className,
}: {
  value: T | null | undefined;
  options: readonly MenuOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name of the control (as an aria-label). */
  label: string;
  /** "field": a full input-sized box; "chip": a small rounded filter chip; "button": a white button. */
  variant?: 'field' | 'chip' | 'button';
  /** Icon at the start of the trigger (e.g. <LineIcon name="clock" />). */
  icon?: ReactNode;
  /** Grey words before the value inside the trigger ("Assignee:"). */
  prefix?: ReactNode;
  placeholder?: ReactNode;
  disabled?: boolean;
  testId?: string;
  /** Width of the list; the trigger's width when left out. */
  menuWidth?: number;
  style?: CSSProperties;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();
  const current = options.find((o) => o.value === value);

  const enabledIndex = (from: number, step: 1 | -1) => {
    for (let i = from, n = 0; n < options.length; i += step, n++) {
      const k = (i + options.length) % options.length;
      if (!options[k].disabled) return k;
    }
    return from;
  };

  function openMenu() {
    if (disabled) return;
    const at = options.findIndex((o) => o.value === value);
    setActive(at >= 0 ? at : enabledIndex(0, 1));
    setOpen(true);
  }

  function close(focusTrigger = true) {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function pick(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    close();
    if (o.value !== value) onChange(o.value);
  }

  // Place the list under the trigger, or above it when the room below is short
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const width = menuWidth ?? Math.max(t.width, 180);
      const left = Math.max(8, Math.min(t.left, window.innerWidth - width - 8));
      const h = listRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - t.bottom - 8;
      if (h && h > below && t.top - 8 > below) setPlace({ left, bottom: window.innerHeight - t.top + 4, width });
      else setPlace({ left, top: t.bottom + 4, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, menuWidth, options.length]);

  // Close on a click anywhere else
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !listRef.current?.contains(t)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the active option in view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => enabledIndex(a + 1, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => enabledIndex(a - 1, -1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(enabledIndex(0, 1));
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(enabledIndex(options.length - 1, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      // type-ahead: the first option whose text starts with what was typed in the last second
      const now = Date.now();
      typed.current = {
        text: (now - typed.current.at < 1000 ? typed.current.text : '') + e.key.toLowerCase(),
        at: now,
      };
      const i = options.findIndex((o) => !o.disabled && textOf(o.label).toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${styles[variant]} ${open ? styles.open : ''} ${className ?? ''}`}
        style={style}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        {icon && <span className={styles.icon}>{icon}</span>}
        {prefix && <span className={styles.prefix}>{prefix}</span>}
        <span className={styles.value}>
          {current ? current.label : <span className={styles.placeholder}>{placeholder}</span>}
        </span>
        <LineIcon name="chevronDown" size={14} color="#5B6B60" style={{ marginLeft: 'auto' }} />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className={styles.menu}
            style={{ left: place?.left ?? -9999, top: place?.top, bottom: place?.bottom, width: place?.width }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-index={i}
                className={`${styles.option} ${i === active ? styles.active : ''} ${o.disabled ? styles.disabled : ''}`}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onClick={() => pick(i)}
              >
                {o.icon && <span className={styles.icon}>{o.icon}</span>}
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{o.label}</span>
                  {o.hint && <span className={styles.optionHint}>{o.hint}</span>}
                </span>
                {o.value === value && <LineIcon name="check" size={14} color="#2E6F40" strokeWidth={2} />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The plain text of a label, for type-ahead. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}
