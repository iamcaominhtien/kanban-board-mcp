import { useEffect, useMemo, useRef, useState } from 'react';
import { docsErrorDetail, useDuplicatePage } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { useToast } from '../Toast';
import { Icon } from './Icon';
import { FooterNote, ModalShell, Spacer, plural } from './docsShared';

interface DuplicateDialogProps {
  projectId: string;
  page: DocsPage;
  nodes: DocsTreeNode[];
  onClose: () => void;
  onDuplicated?: (page: DocsPage) => void;
}

interface Option {
  id: string | null;
  label: string;
}

function sortedChildren(nodes: DocsTreeNode[], parentId: string | null): DocsTreeNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.position - b.position);
}

// Tree board, frame 35: 38 px fields, 36 px toggle rows, list rows 30 high with 18 px per level
const field: React.CSSProperties = {
  height: 38,
  boxSizing: 'border-box',
  padding: '0 11px',
  borderRadius: 8,
  borderColor: '#C7D2CB',
  fontSize: 13.5,
};
const toggleRow: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'flex-start', minHeight: 36 };
const listRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 30,
  boxSizing: 'border-box',
  padding: '2px 8px 2px 6px',
  fontSize: 13,
  fontWeight: 500,
  color: '#3A4A3E',
};

const checkRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  fontSize: 12.5,
  color: '#3A4A3E',
};

/**
 * Dialog to duplicate a page with its sub-pages.
 * @param props.page - Page to duplicate (sub-pages are copied too).
 * @param props.nodes - Page tree, used to pick the destination.
 * @param props.onClose - Called to dismiss the dialog.
 * @param props.onDuplicated - Called with the new page after duplicating.
 */
export function DuplicateDialog({ projectId, page, nodes, onClose, onDuplicated }: DuplicateDialogProps) {
  const toast = useToast();
  const duplicate = useDuplicatePage(projectId);
  const [title, setTitle] = useState(`${page.title} (copy)`);
  const origParent = page.parentId;
  const [parentId, setParentId] = useState<string | null>(page.parentId);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(true);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    // caret after "Copy of …", ready to extend the name (design/screens/docs-actions.md C)
    const n = titleRef.current?.value.length ?? 0;
    titleRef.current?.setSelectionRange(n, n);
  }, []);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const options: Option[] = useMemo(() => {
    const out: Option[] = [{ id: null, label: 'Top level' }];
    const walk = (pid: string | null, depth: number) => {
      for (const n of sortedChildren(nodes, pid)) {
        out.push({ id: n.id, label: `${'  '.repeat(depth)}${n.title}` });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [nodes]);

  const subPages = useMemo(() => {
    const out: { id: string; title: string; depth: number }[] = [];
    const walk = (pid: string, depth: number) => {
      for (const n of sortedChildren(nodes, pid)) {
        out.push({ id: n.id, title: n.title, depth });
        walk(n.id, depth + 1);
      }
    };
    walk(page.id, 1);
    return out;
  }, [nodes, page.id]);

  const location = useMemo(() => {
    if (!page.parentId) return 'Top level';
    const parts: string[] = [page.title];
    let cur = byId.get(page.parentId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(' › ');
  }, [byId, page.parentId, page.title]);

  const hasChildren = subPages.length > 0;
  const on = hasChildren && includeChildren;
  const trimmed = title.trim();
  const directKids = subPages.filter((s) => s.depth === 1).map((s) => s.title);
  const names =
    directKids.length > 1
      ? `${directKids.slice(0, -1).join(', ')} and ${directKids[directKids.length - 1]}`
      : directKids[0];

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!trimmed) return;
    setError(null);
    try {
      const copy = await duplicate.mutateAsync({ pageId: page.id, title: trimmed, parentId, includeChildren: on });
      toast.success(`Duplicated “${page.title}”`, 'The copy is a draft.');
      onDuplicated?.(copy);
      onClose();
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  const current = options.find((o) => o.id === parentId);

  return (
    <ModalShell
      boardFrame
      width={580}
      ariaLabel={`Duplicate “${page.title}”`}
      icon="i24"
      title={<>Duplicate “{page.title}”</>}
      subtitle={
        <>
          {location}
          {hasChildren && ` · ${plural(subPages.length, 'child page')}`}
        </>
      }
      onClose={onClose}
      bodyStyle={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 13 }}
      footer={
        <>
          <FooterNote>The copy is created as a draft.</FooterNote>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={!trimmed || duplicate.isPending}
            onClick={() => void submit()}
          >
            <Icon name="i24" size={14} />
            {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
          </button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} style={{ display: 'contents' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label className="st-field-label" htmlFor="dup-title" style={{ fontSize: 11 }}>
            Title
          </label>
          <input
            id="dup-title"
            ref={titleRef}
            className="st-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            style={{
              ...field,
              ...(focus ? { borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.14)' } : null),
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label className="st-field-label" htmlFor="dup-parent" style={{ fontSize: 11 }}>
            Location
          </label>
          <div
            className="st-input"
            style={{ ...field, display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}
          >
            <span style={{ display: 'flex', color: '#2E6F40' }}>
              <Icon name={parentId === null ? 'i27' : 'i00'} size={15} strokeWidth={1.8} />
            </span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {current?.label.trim()}
              {parentId === origParent && ' · same place as the original'}
            </span>
            <Icon name="i06" size={12} strokeWidth={2.3} />
            <select
              id="dup-parent"
              value={parentId ?? ''}
              onChange={(e) => setParentId(e.target.value || null)}
              style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer' }}
            >
              {options.map((o) => (
                <option key={o.id ?? 'top'} value={o.id ?? ''}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ height: 1, background: '#E3E8E5' }} />

        <div style={toggleRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: hasChildren ? '#1E2A22' : '#9AA8A0' }}>
              Include child pages
            </div>
            <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45, marginTop: 1 }}>
              {hasChildren ? `Copies ${names} as well, under the new page.` : `${page.title} has no child pages.`}
            </div>
          </div>
          <span style={{ opacity: hasChildren ? 1 : 0.45, display: 'flex' }}>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label="Include child pages"
              disabled={!hasChildren}
              onClick={() => setIncludeChildren((v) => !v)}
              className="st-toggle-track"
              style={{
                background: on ? '#2E6F40' : '#C7D2CB',
                border: 'none',
                padding: 0,
                cursor: hasChildren ? 'pointer' : 'default',
              }}
            >
              <span className="st-toggle-dot" style={{ left: on ? 17 : 2 }} />
            </button>
          </span>
        </div>

        {on && (
          <div
            role="list"
            aria-label="Pages that will be created"
            style={{ border: '1px solid #E3EAE5', borderRadius: 9, overflow: 'hidden', background: '#FFFFFF' }}
          >
            <div role="listitem" style={{ ...listRow, fontWeight: 600, color: '#1E2A22' }}>
              <span style={{ display: 'flex', width: 20, justifyContent: 'center', color: '#5B6B60' }}>
                <Icon name="i00" size={15} strokeWidth={1.8} />
              </span>
              {trimmed || `${page.title} (copy)`}
              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#2E6F40' }}>New</span>
            </div>
            {subPages.map((s) => (
              <div key={s.id} role="listitem" style={{ ...listRow, paddingLeft: 6 + s.depth * 18 }}>
                <span style={{ display: 'flex', width: 20, justifyContent: 'center', color: '#5B6B60' }}>
                  <Icon name="i00" size={15} strokeWidth={1.8} />
                </span>
                {s.title}
              </div>
            ))}
          </div>
        )}

        {/* the server copies neither yet: shown, switched off, so the choice is known to come */}
        {(
          [
            ['Include comments', 'Off: comments and their threads stay on the original.'],
            ['Include files and uploads', 'Off: the copy shows the same files as the original.'],
          ] as const
        ).map(([label, hint]) => (
          <div
            key={label}
            style={{ ...toggleRow, opacity: 0.6 }}
            data-testid={`dup-${label === 'Include comments' ? 'comments' : 'files'}`}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1E2A22' }}>
                {label} <span style={{ fontSize: 11.5, fontWeight: 600, color: '#5B6B60' }}>· coming later</span>
              </div>
              <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45, marginTop: 1 }}>{hint}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={false}
              aria-label={label}
              disabled
              className="st-toggle-track"
              style={{ background: '#C7D2CB', border: 'none', padding: 0, cursor: 'default' }}
            >
              <span className="st-toggle-dot" style={{ left: 2 }} />
            </button>
          </div>
        ))}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '9px 12px',
            borderRadius: 9,
            border: '1px solid #E3EAE5',
            background: '#F6FAF7',
          }}
          data-testid="dup-always"
        >
          <div style={checkRow}>
            <Icon name="i10" size={13} strokeWidth={2.4} />
            Content as of v{page.version}, headings and tables
          </div>
          <div style={checkRow}>
            <Icon name="i10" size={13} strokeWidth={2.4} />
            Links and ticket chips, unchanged
          </div>
          <div style={checkRow}>
            <Icon name="i08" size={13} strokeWidth={2.4} />
            Version history, comments and Referenced by (the copy starts at v1)
          </div>
        </div>
        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
            {error}
          </div>
        )}
      </form>
    </ModalShell>
  );
}
