import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { docsErrorDetail, useCreatePage, useDocsTemplates } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { slugify } from '../../utils/docsMarkdown';
import { Icon } from './Icon';

interface Props {
  projectId: string;
  nodes: DocsTreeNode[];
  initialParentId: string | null;
  initialTemplate?: string;
  initialTitle?: string;
  onClose: () => void;
  onCreated: (page: DocsPage) => void;
}

const TEMPLATE_ICON: Record<string, string> = {
  blank: 'i00',
  requirements: 'i13',
  'meeting-notes': 'i32',
  'decision-log': 'i17',
  'technical-design': 'i33',
};

function pathOf(nodes: DocsTreeNode[], id: string | null): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur) {
    parts.unshift(cur.title);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' › ');
}

const previewHead = { fontSize: 13, fontWeight: 700, color: '#1E2A22', margin: '10px 0 3px' } as const;
const previewText = { fontSize: 12, color: '#9AA8A0', lineHeight: 1.5 } as const;

function TemplatePreview({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <div style={previewHead}>{children}</div>,
        h2: ({ children }) => <div style={previewHead}>{children}</div>,
        h3: ({ children }) => <div style={previewHead}>{children}</div>,
        p: ({ children }) => <div style={previewText}>{children}</div>,
        ul: ({ children }) => <div style={previewText}>{children}</div>,
        ol: ({ children }) => <div style={previewText}>{children}</div>,
        li: ({ children, className }) => (
          <div>
            {className?.includes('task-list-item') ? null : '• '}
            {children}
          </div>
        ),
        input: () => <span>☐ </span>,
        code: ({ children }) => <span style={{ fontFamily: 'var(--font-mono)' }}>{children}</span>,
        pre: ({ children }) => <div style={{ ...previewText, fontFamily: 'var(--font-mono)' }}>{children}</div>,
        table: ({ children }) => (
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #E3E8E5' }}>{children}</table>
        ),
        th: ({ children }) => (
          <th style={{ textAlign: 'left', padding: '4px 8px', fontSize: 11, background: '#F6FAF7', color: '#5B6B60' }}>
            {children}
          </th>
        ),
        td: ({ children }) => {
          const t = String(children ?? '');
          const id = /^[A-Z]{1,3}\d+$/.test(t);
          return (
            <td
              style={{
                padding: '4px 8px',
                borderBottom: '1px solid #EEF3EF',
                fontSize: id ? 11 : 12,
                color: id ? '#5B6B60' : '#9AA8A0',
                fontFamily: id ? 'var(--font-mono)' : undefined,
              }}
            >
              {children}
            </td>
          );
        },
        blockquote: ({ children }) => <div style={previewText}>{children}</div>,
        a: ({ children }) => <span>{children}</span>,
        strong: ({ children }) => <b>{children}</b>,
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

/** Dialog to create a page, optionally from a template. */
export function NewPageDialog({
  projectId,
  nodes,
  initialParentId,
  initialTemplate = 'blank',
  initialTitle,
  onClose,
  onCreated,
}: Props) {
  const { data: templates = [] } = useDocsTemplates();
  const create = useCreatePage(projectId);
  const [template, setTemplate] = useState(initialTemplate);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [titleTouched, setTitleTouched] = useState(!!initialTitle);
  const [titleFocus, setTitleFocus] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  const tpl = templates.find((t) => t.id === template);

  // the title defaults to the template name until the user types their own
  useEffect(() => {
    if (!titleTouched && tpl) setTitle(tpl.id === 'blank' ? '' : tpl.name);
  }, [tpl, titleTouched]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pickOpen) setPickOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pickOpen]);

  useEffect(() => {
    if (!pickOpen) return;
    const close = (e: MouseEvent) => {
      if (!pickRef.current?.contains(e.target as Node)) setPickOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [pickOpen]);

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, DocsTreeNode[]>();
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      const k = n.parentId && ids.has(n.parentId) ? n.parentId : null;
      (m.get(k) ?? m.set(k, []).get(k)!).push(n);
    }
    m.forEach((l) => l.sort((a, b) => a.position - b.position));
    return m;
  }, [nodes]);
  const flat = useMemo(() => {
    const out: { n: DocsTreeNode; depth: number }[] = [];
    const walk = (p: string | null, depth: number) => {
      for (const n of childrenOf.get(p) ?? []) {
        out.push({ n, depth });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [childrenOf]);
  const shown = pickQuery.trim()
    ? flat.filter(({ n }) => pathOf(nodes, n.id).toLowerCase().includes(pickQuery.trim().toLowerCase()))
    : flat;
  const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null;

  const trimmed = title.trim();
  const clash =
    !!trimmed && nodes.some((n) => n.parentId === parentId && n.title.toLowerCase() === trimmed.toLowerCase());
  const empty = (titleTouched || submitted) && !trimmed;
  const nextAddress = useMemo(() => {
    const base = slugify(trimmed) || 'page';
    const used = new Set(nodes.map((n) => n.slug));
    let i = 2;
    while (used.has(`${base}-${i}`)) i += 1;
    return `${base}-${i}`;
  }, [nodes, trimmed]);

  async function submit() {
    if (!trimmed) {
      setSubmitted(true);
      return;
    }
    setError(null);
    try {
      const page = await create.mutateAsync({ title: trimmed, parentId, template });
      onCreated(page);
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  const titleBorder = empty
    ? { borderColor: '#C4432A', boxShadow: '0 0 0 3px rgba(196,67,42,0.14)' }
    : titleFocus
      ? { borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' }
      : clash
        ? { borderColor: '#E3C27A' }
        : null;

  return (
    <div
      className="docs-root"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(37,61,44,0.5)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New page"
        style={{
          position: 'relative',
          width: 780,
          maxWidth: '96vw',
          maxHeight: '96vh',
          overflow: 'auto',
          borderRadius: 12,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.28)',
          background: '#FFFFFF',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '16px 22px',
            borderBottom: '1px solid #E3E8E5',
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: '#DCEEE1',
              color: '#2E6F40',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon name="i23" size={16} strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>New page</div>
            <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>Choose a template, then name the page</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: 'none',
              background: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#9AA8A0',
            }}
          >
            <Icon name="close" size={16} strokeWidth={1.8} />
          </button>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div
              role="radiogroup"
              aria-label="Template"
              style={{ width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              {templates.map((t) => {
                const on = template === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="dk-tpl-row"
                    data-testid={`template-${t.id}`}
                    onClick={() => setTemplate(t.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '9px 10px',
                      borderRadius: 9,
                      border: '1px solid',
                      cursor: 'pointer',
                      textAlign: 'left',
                      font: 'inherit',
                      background: on ? '#F1F8F3' : '#FFFFFF',
                      borderColor: on ? '#2E6F40' : '#E3E8E5',
                    }}
                  >
                    <div
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        background: on ? '#DCEEE1' : '#EEF3EF',
                        color: on ? '#2E6F40' : '#5B6B60',
                      }}
                    >
                      <Icon name={TEMPLATE_ICON[t.id] ?? 'i00'} size={16} strokeWidth={1.8} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>{t.name}</div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: '#5B6B60',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.description}
                      </div>
                    </div>
                    {on && <Icon name="check" size={14} strokeWidth={2.6} style={{ color: '#2E6F40' }} />}
                  </button>
                );
              })}
            </div>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                height: 300,
                borderRadius: 10,
                border: '1px solid #E3E8E5',
                background: '#FFFFFF',
                padding: '14px 18px',
                boxSizing: 'border-box',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: '#5B6B60',
                  marginBottom: 6,
                }}
              >
                Preview · {tpl?.name ?? ''}
              </div>
              {tpl && tpl.markdown ? (
                <TemplatePreview markdown={tpl.markdown} />
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    marginTop: 10,
                    fontSize: 12,
                    color: '#9AA8A0',
                  }}
                >
                  <span className="dk-caret" style={{ height: 13, background: '#9AA8A0' }} />
                  Type / to start
                </div>
              )}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 46,
                  background: 'linear-gradient(rgba(255,255,255,0),#FFFFFF)',
                }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="st-field-label" htmlFor="docs-new-title" style={{ fontSize: 11 }}>
                  Title
                </label>
                <input
                  id="docs-new-title"
                  autoFocus
                  className="st-input"
                  value={title}
                  placeholder="Page title"
                  aria-label="Title"
                  aria-invalid={empty}
                  onFocus={() => setTitleFocus(true)}
                  onBlur={() => setTitleFocus(false)}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleTouched(true);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  style={titleBorder ?? undefined}
                />
                {empty && (
                  <div
                    role="alert"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#C4432A',
                    }}
                  >
                    <Icon name="i22" size={13} strokeWidth={2} />
                    Give the page a title to create it.
                  </div>
                )}
                {clash && !empty && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 6,
                      fontSize: 12,
                      lineHeight: 1.45,
                      color: '#7A4F08',
                    }}
                  >
                    <Icon name="i14" size={13} strokeWidth={2} style={{ color: '#B4791E', marginTop: 1 }} />
                    <span>
                      A page named <b>{trimmed}</b> already exists under{' '}
                      {parentNode ? parentNode.title : 'the top level'}. You can still create it; the new page gets the
                      address <span className="st-code">{nextAddress}</span>.
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div ref={pickRef} style={{ width: 250, flexShrink: 0, position: 'relative' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="st-field-label" style={{ fontSize: 11 }}>
                  Parent page
                </span>
                <button
                  type="button"
                  className="st-input"
                  aria-label="Parent page"
                  aria-haspopup="listbox"
                  aria-expanded={pickOpen}
                  data-testid="parent-select"
                  onClick={() => {
                    setPickOpen((v) => !v);
                    setPickQuery('');
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    textAlign: 'left',
                    cursor: 'pointer',
                    ...(pickOpen ? { borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' } : null),
                  }}
                >
                  <span style={{ display: 'flex', color: '#2E6F40' }}>
                    <Icon name={parentNode ? 'page' : 'i27'} size={15} strokeWidth={1.8} />
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {parentNode ? parentNode.title : 'Top level (no parent)'}
                  </span>
                  <Icon name="chevronDown" size={12} strokeWidth={2.3} style={{ color: '#9AA8A0' }} />
                </button>
              </div>
              {pickOpen && (
                <div
                  className="dk-menu"
                  role="listbox"
                  style={{
                    position: 'absolute',
                    right: 0,
                    bottom: 'calc(100% + 6px)',
                    width: 320,
                    padding: 6,
                    zIndex: 20,
                    maxHeight: 360,
                    overflowY: 'auto',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '6px 9px',
                      marginBottom: 4,
                      borderRadius: 7,
                      border: '1px solid #E3E8E5',
                      background: '#FBFCFB',
                    }}
                  >
                    <Icon name="search" size={13} strokeWidth={2} style={{ color: '#9AA8A0' }} />
                    <input
                      autoFocus
                      value={pickQuery}
                      onChange={(e) => setPickQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && shown[0]) {
                          setParentId(shown[0].n.id);
                          setPickOpen(false);
                        }
                      }}
                      placeholder="Find a page…"
                      aria-label="Find a page"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: 'none',
                        outline: 'none',
                        background: 'none',
                        padding: 0,
                        font: 'inherit',
                        fontSize: 12.5,
                        color: '#1E2A22',
                      }}
                    />
                  </div>
                  {!pickQuery.trim() && (
                    <div
                      role="option"
                      aria-selected={parentId === null}
                      className={`dk-mi${parentId === null ? ' dk-mi-on' : ''}`}
                      style={parentId === null ? { fontWeight: 700 } : undefined}
                      onClick={() => {
                        setParentId(null);
                        setPickOpen(false);
                      }}
                    >
                      <span style={{ color: '#5B6B60', display: 'flex' }}>
                        <Icon name="i27" size={15} strokeWidth={1.8} />
                      </span>
                      <span>Top level (no parent)</span>
                      {parentId === null && (
                        <span style={{ marginLeft: 'auto', display: 'flex' }}>
                          <Icon name="check" size={14} strokeWidth={2.6} style={{ color: '#2E6F40' }} />
                        </span>
                      )}
                    </div>
                  )}
                  {shown.map(({ n, depth }) => {
                    const on = n.id === parentId;
                    return (
                      <div
                        key={n.id}
                        role="option"
                        aria-selected={on}
                        className={`dk-mi${on ? ' dk-mi-on' : ''}`}
                        style={{
                          paddingLeft: pickQuery.trim() ? 10 : 10 + depth * 18,
                          fontWeight: on ? 700 : undefined,
                        }}
                        onClick={() => {
                          setParentId(n.id);
                          setPickOpen(false);
                        }}
                      >
                        <Icon
                          name="page"
                          size={15}
                          strokeWidth={1.8}
                          style={{ color: on ? '#2E6F40' : depth ? '#9AA8A0' : '#5B6B60' }}
                        />
                        <span>{pickQuery.trim() ? pathOf(nodes, n.id) : n.title}</span>
                        {on && (
                          <span style={{ marginLeft: 'auto', display: 'flex' }}>
                            <Icon name="check" size={14} strokeWidth={2.6} style={{ color: '#2E6F40' }} />
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {shown.length === 0 && (
                    <div style={{ padding: '8px 10px', fontSize: 12.5, color: '#9AA8A0' }}>
                      No page matches “{pickQuery}”
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.5 }}>
            The new page will be placed at the end of{' '}
            {parentNode ? <b style={{ color: '#1E2A22', fontWeight: 700 }}>{parentNode.title}</b> : 'the top level'}.
            You can drag it elsewhere later.
          </div>
          {error && (
            <div role="alert" style={{ fontSize: 12.5, color: '#C4432A', fontWeight: 600 }}>
              {error}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '14px 22px',
            borderTop: '1px solid #E3E8E5',
            background: '#FBFCFB',
          }}
        >
          <span style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45 }}>
            Created as a draft. Only you can see it until you publish.
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={create.isPending}
            onClick={() => void submit()}
            data-testid="create-page"
          >
            <Icon name="plus" size={14} strokeWidth={1.9} />
            {create.isPending ? 'Creating…' : 'Create page'}
          </button>
        </div>
      </div>
    </div>
  );
}
