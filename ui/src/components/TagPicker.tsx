import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTagColor } from './TagPill';
import { LineIcon } from './ui/LineIcon';

/**
 * "+ Add tag" and its picker popover (Tags 3 and 4, comp-1 TG-2): a search field; the project's existing tags that
 * match, click to attach; a "Create "…"" row when nothing matches exactly. Enter picks the highlighted row, a comma
 * attaches what is typed and keeps the picker open for the next tag, Esc closes it without adding anything.
 */
export function TagPicker({
  projectTags,
  currentTags,
  onAdd,
}: Readonly<{
  /** Every tag used in the project (suggestions). */
  projectTags: string[];
  /** The ticket's tags (left out of the suggestions). */
  currentTags: string[];
  onAdd: (tag: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const typed = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const have = new Set(currentTags.map((t) => t.toLowerCase()));
    const all = Array.from(new Set(projectTags.map((t) => t.trim().toLowerCase()).filter(Boolean)));
    return all
      .filter((t) => !have.has(t) && (!typed || t.includes(typed)))
      .sort((a, b) => Number(!a.startsWith(typed)) - Number(!b.startsWith(typed)) || a.localeCompare(b))
      .slice(0, 8);
  }, [projectTags, currentTags, typed]);
  const canCreate = !!typed && !matches.includes(typed) && !currentTags.includes(typed);
  const rows: { tag: string; create: boolean }[] = [
    ...matches.map((tag) => ({ tag, create: false })),
    ...(canCreate ? [{ tag: typed, create: true }] : []),
  ];

  // the highlighted row: the exact match if there is one, else the "Create" row, else the first row
  const exact = rows.findIndex((r) => r.tag === typed);
  const createAt = rows.findIndex((r) => r.create);
  const active = picked ?? (typed ? (exact >= 0 ? exact : createAt >= 0 ? createAt : 0) : 0);

  useEffect(() => setPicked(null), [typed]);

  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPlace({ left: Math.min(r.left, window.innerWidth - 228), top: r.bottom + 6 });
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) {
        // an outside click adds what is typed (as the inline input's blur did)
        if (typed) attach(typed, true);
        close(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typed, currentTags, onAdd]);

  function close(focusButton = true) {
    setOpen(false);
    setQuery('');
    if (focusButton) btnRef.current?.focus();
  }

  function attach(tag: string, keepOpen = false) {
    const t = tag.trim().toLowerCase();
    if (t && !currentTags.includes(t)) onAdd(t);
    setQuery('');
    if (!keepOpen) close();
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid="tag-add"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 10px 3px 8px',
          borderRadius: 3,
          border: open ? '1px solid #2E6F40' : '1px dashed #C7D2CB',
          background: 'none',
          color: open ? '#2E6F40' : '#9AA8A0',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        <LineIcon name="plus" size={11} strokeWidth={2.2} />
        Add tag
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Add tag"
            data-testid="tag-picker"
            style={{
              position: 'fixed',
              left: place?.left ?? -9999,
              top: place?.top ?? 0,
              zIndex: 2000,
              width: 220,
              boxSizing: 'border-box',
              border: '1px solid #E3E8E5',
              borderRadius: 8,
              background: '#FFFFFF',
              boxShadow: '0 12px 28px rgba(30,42,34,0.14)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <input
              ref={inputRef}
              aria-label="Tag name"
              placeholder="Find or create a tag…"
              value={query}
              onChange={(e) => setQuery(e.target.value.replace(',', ''))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation(); // the ticket stays open
                  close();
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPicked(Math.min(active + 1, rows.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setPicked(Math.max(active - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const row = rows[active];
                  if (row) attach(row.tag);
                  else if (typed) attach(typed);
                } else if (e.key === ',') {
                  // a comma commits what is typed and keeps the picker open for the next tag (Tags 3)
                  e.preventDefault();
                  if (typed) attach(typed, true);
                }
              }}
              style={{
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid #B9CBBF',
                background: '#FFFFFF',
                fontFamily: 'inherit',
                fontSize: 12.5,
                color: '#1E2A22',
                outline: 'none',
                boxShadow: '0 0 0 2px rgba(46,111,64,0.12)',
              }}
            />
            {rows.length > 0 ? (
              <div role="listbox" aria-label="Tags" style={{ display: 'flex', flexDirection: 'column' }}>
                {rows.map((row, i) => {
                  const { bg, color } = getTagColor(row.tag);
                  return (
                    <button
                      key={(row.create ? '+' : '') + row.tag}
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      onMouseEnter={() => setPicked(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => attach(row.tag)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: row.create ? 6 : 8,
                        padding: '6px 4px',
                        border: 'none',
                        background: i === active ? '#F6FAF7' : 'none',
                        borderRadius: 5,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'inherit',
                        color: '#5B6B60',
                        fontSize: 12,
                      }}
                    >
                      {row.create ? (
                        <>
                          <LineIcon name="plus" size={11} color="#9AA8A0" strokeWidth={2} />
                          Create &quot;{row.tag}&quot;
                        </>
                      ) : (
                        <>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 3,
                              background: bg,
                              color,
                              fontSize: 12,
                              fontWeight: 600,
                            }}
                          >
                            {row.tag}
                          </span>
                          <span style={{ fontSize: 11, color: '#9AA8A0' }}>existing tag</span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: '#9AA8A0', padding: '2px 4px' }}>
                {currentTags.length > 0 && !typed ? 'Type to create a tag.' : 'No tags in this project yet.'}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
