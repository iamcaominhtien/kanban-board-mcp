/**
 * The editor's link checker (RichDocsLinks G 38-39): every page link of the page being edited, resolved; the ones
 * that need attention say why (page not found, in the Recycle Bin, heading or block gone) with their fix, and
 * "Link to a page…" opens Relink, which points every link to the lost target at another page at once.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Editor } from '@tiptap/core';
import { client } from '../../../api/client';
import { useCreatePage, useRestorePage } from '../../../api/docs';
import type { DocsRefRequest, DocsRefResult, DocsTreeNode } from '../../../types/docs';
import { useToast } from '../../Toast';
import { ModalShell, plural } from '../docsShared';
import { PageIcon } from '../tree/treeParts';
import { KindGlyph } from './BlockKind';

/** One docRef of the page, where it is. */
interface Site {
  pos: number;
  page: string;
  section: string | null;
  label: string | null;
  pageId: string | null;
  targetBlockId: string | null;
  targetLabel: string | null;
}

/** The links of the page that point at the same place, and what that place is now. */
export interface LinkGroup {
  key: string;
  sites: Site[];
  result: DocsRefResult | null;
}

/** The docRefs of a document, in order. */
export function linkSites(editor: Editor): Site[] {
  const out: Site[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'docRef') return true;
    const a = node.attrs as Record<string, string | null>;
    out.push({
      pos,
      page: a.page ?? '',
      section: a.section || null,
      label: a.label || null,
      pageId: a.pageId || null,
      targetBlockId: a.targetBlockId || null,
      targetLabel: a.targetLabel || null,
    });
    return false;
  });
  return out;
}

const keyOf = (s: Site) => `${s.pageId ?? s.page.toLowerCase()}#${s.targetBlockId ?? s.section ?? ''}`;

/** Whether a resolved link needs attention. */
export function needsAttention(r: DocsRefResult | null | undefined): boolean {
  return !!r && ['missing', 'in_bin', 'section_missing', 'block_missing'].includes(r.status);
}

/** Why, in a few words (G 38). */
export function brokenWhy(r: DocsRefResult): string {
  switch (r.status) {
    case 'missing':
      return 'Page not found';
    case 'in_bin':
      return 'In Recycle Bin';
    case 'section_missing':
      return 'Heading not found';
    case 'block_missing':
      return 'Block not found';
    default:
      return '';
  }
}

/** Points the links at `sites` at another page (their own text kept); `null` keeps the page and drops the heading. */
function relink(editor: Editor, sites: Site[], to: { id: string; title: string } | null) {
  const tr = editor.state.tr;
  for (const s of sites) {
    const node = tr.doc.nodeAt(s.pos);
    if (!node || node.type.name !== 'docRef') continue;
    tr.setNodeMarkup(s.pos, undefined, {
      ...node.attrs,
      ...(to ? { page: to.title, pageId: to.id } : {}),
      section: null,
      targetBlockId: null,
      targetLabel: null,
    });
  }
  editor.view.dispatch(tr);
}

/** Replaces the links at `sites` by their words. */
function unlink(editor: Editor, sites: Site[]) {
  const tr = editor.state.tr;
  for (const s of [...sites].sort((a, b) => b.pos - a.pos)) {
    const node = tr.doc.nodeAt(s.pos);
    if (!node || node.type.name !== 'docRef') continue;
    const words = s.label || (s.section ? `${s.page} › ${s.section}` : s.page);
    tr.replaceWith(s.pos, s.pos + node.nodeSize, editor.state.schema.text(words));
  }
  editor.view.dispatch(tr);
}

const btn: CSSProperties = { minHeight: 28, padding: '0 10px', fontSize: 12.5 };

/** The chip of a broken link, as the panel shows it: red dashed (page gone), struck (bin), amber dashed (block). */
function BrokenChip({ g }: { g: LinkGroup }) {
  const s = g.sites[0];
  const r = g.result!;
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 22,
    padding: '0 8px',
    borderRadius: 6,
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    maxWidth: '100%',
    overflow: 'hidden',
  };
  const look: CSSProperties =
    r.status === 'missing'
      ? { background: '#FDF1EE', color: '#C4432A', border: '1.5px dashed #C4432A' }
      : r.status === 'in_bin'
        ? { background: '#F1F3F1', color: '#5B6B60', border: '1px solid #C7D2CB', textDecoration: 'line-through' }
        : { background: '#FDF3E3', color: '#8A5A00', border: '1.5px dashed #C98A1B' };
  const target = s.section ?? s.targetLabel;
  return (
    <span style={{ ...base, ...look }} data-testid="check-chip">
      {r.title ?? s.page}
      {target && (
        <>
          <span style={{ opacity: 0.55 }}>›</span>
          {r.status === 'block_missing' && <KindGlyph kind="text" size={11} />}
          <span style={{ fontWeight: 600 }}>{target}</span>
        </>
      )}
    </span>
  );
}

/**
 * The Check links panel of the editor: 340 px at the right, #FBFCFB, one card per target that needs attention.
 * @param props.getEditor - The page's editor.
 * @param props.projectId - The project (to resolve links, create and restore pages).
 * @param props.nodes - The page tree (Relink's list).
 * @param props.onClose - Close the panel.
 */
export function LinkCheckerPanel({
  getEditor,
  projectId,
  nodes,
  onClose,
}: {
  getEditor: () => Editor | null;
  projectId: string;
  nodes: DocsTreeNode[];
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreatePage(projectId);
  const restore = useRestorePage(projectId);
  const [groups, setGroups] = useState<LinkGroup[] | null>(null);
  const [relinking, setRelinking] = useState<LinkGroup | null>(null);

  const check = useCallback(async () => {
    const ed = getEditor();
    if (!ed) return;
    const byKey = new Map<string, Site[]>();
    for (const s of linkSites(ed)) byKey.set(keyOf(s), [...(byKey.get(keyOf(s)) ?? []), s]);
    const keys = [...byKey.keys()];
    const refs: DocsRefRequest[] = keys.map((k) => {
      const s = byKey.get(k)![0];
      return {
        kind: 'page',
        title: s.page,
        anchor: s.section,
        ...(s.pageId ? { pageId: s.pageId, blockId: s.targetBlockId } : {}),
      } as DocsRefRequest;
    });
    let results: DocsRefResult[] = [];
    if (refs.length) {
      try {
        results = (await client.post<DocsRefResult[]>(`/projects/${projectId}/docs/resolve`, { refs })).data;
      } catch {
        toast.error("Couldn't check the links");
      }
    }
    setGroups(keys.map((key, i) => ({ key, sites: byKey.get(key)!, result: results[i] ?? null })));
  }, [getEditor, projectId, toast]);

  useEffect(() => {
    void check();
  }, [check]);

  const broken = useMemo(() => (groups ?? []).filter((g) => needsAttention(g.result)), [groups]);
  const fine = useMemo(() => (groups ?? []).filter((g) => !needsAttention(g.result)), [groups]);
  const total = (groups ?? []).reduce((n, g) => n + g.sites.length, 0);
  const brokenCount = broken.reduce((n, g) => n + g.sites.length, 0);

  const select = (g: LinkGroup) => {
    const ed = getEditor();
    if (!ed) return;
    ed.chain().setNodeSelection(g.sites[0].pos).scrollIntoView().run();
  };

  const act = async (fn: () => void | Promise<unknown>) => {
    try {
      await fn();
    } catch {
      toast.error("Couldn't fix the link");
    }
    await check();
  };

  return (
    <aside
      className="docs-root"
      aria-label="Check links"
      data-testid="link-checker"
      style={{
        position: 'fixed',
        right: 0,
        top: 56,
        bottom: 0,
        width: 340,
        zIndex: 40,
        borderLeft: '1px solid #E3E8E5',
        background: '#FBFCFB',
        overflowY: 'auto',
        boxSizing: 'border-box',
        boxShadow: '-12px 0 28px rgba(30,42,34,0.06)',
      }}
    >
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #E3E8E5' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Check links</span>
          <button type="button" className="dk-icobtn" aria-label="Close" onClick={onClose}>
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.9}
              strokeLinecap="round"
            >
              <path d="M6 6L18 18M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: '#5B6B60', marginTop: 2 }} data-testid="link-checker-summary">
          {groups === null
            ? 'Checking…'
            : total === 0
              ? 'This page has no links to other pages'
              : brokenCount === 0
                ? `All ${plural(total, 'link')} work`
                : `${brokenCount} of ${plural(total, 'link')} need${brokenCount === 1 ? 's' : ''} attention`}
        </div>
      </div>
      {broken.map((g) => {
        const r = g.result!;
        const s = g.sites[0];
        return (
          <div
            key={g.key}
            data-testid="link-checker-item"
            style={{ padding: '12px 16px', borderBottom: '1px solid #EEF3EF', background: '#FFFFFF' }}
          >
            <button
              type="button"
              onClick={() => select(g)}
              title="Show it in the text"
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', maxWidth: '100%' }}
            >
              <BrokenChip g={g} />
            </button>
            <div style={{ fontSize: 12.5, color: '#5B6B60', marginTop: 5 }}>
              {brokenWhy(r)}
              {g.sites.length > 1 ? ` · ${g.sites.length} links` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {r.status === 'missing' && (
                <>
                  <button type="button" className="st-btn" style={btn} onClick={() => setRelinking(g)}>
                    Link to a page…
                  </button>
                  <button
                    type="button"
                    className="st-btn"
                    style={btn}
                    onClick={() =>
                      void act(async () => {
                        const page = await create.mutateAsync({ title: s.page });
                        const ed = getEditor();
                        if (ed) relink(ed, g.sites, { id: page.id, title: page.title });
                      })
                    }
                  >
                    Create it
                  </button>
                  <button
                    type="button"
                    className="st-btn"
                    style={btn}
                    onClick={() =>
                      void act(() => {
                        const ed = getEditor();
                        if (ed) unlink(ed, g.sites);
                      })
                    }
                  >
                    Remove link
                  </button>
                </>
              )}
              {r.status === 'in_bin' && r.pageId && (
                <button
                  type="button"
                  className="st-btn"
                  style={btn}
                  onClick={() => void act(() => restore.mutateAsync(r.pageId!))}
                >
                  Restore
                </button>
              )}
              {(r.status === 'section_missing' || r.status === 'block_missing') && (
                <>
                  <button
                    type="button"
                    className="st-btn"
                    style={btn}
                    onClick={() =>
                      void act(() => {
                        const ed = getEditor();
                        if (ed) relink(ed, g.sites, null);
                      })
                    }
                  >
                    Link to the page
                  </button>
                  <button type="button" className="st-btn" style={btn} onClick={() => setRelinking(g)}>
                    Link to a page…
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {fine.length > 0 && (
        <div
          style={{ padding: '12px 16px', fontSize: 12.5, color: '#5B6B60', display: 'flex', gap: 8 }}
          data-testid="link-checker-fine"
        >
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#2E6F40"
            strokeWidth={2.6}
            strokeLinecap="round"
            style={{ flex: 'none', marginTop: 2 }}
          >
            <path d="M5 12.5L10 17.5L19 7" />
          </svg>
          <span>
            {plural(
              fine.reduce((n, g) => n + g.sites.length, 0),
              'link',
            )}{' '}
            {fine.reduce((n, g) => n + g.sites.length, 0) === 1 ? 'is' : 'are'} fine:{' '}
            {fine.map((g) => g.result?.title ?? g.sites[0].page).join(', ')}
          </span>
        </div>
      )}
      {relinking && (
        <RelinkDialog
          name={relinking.result?.title ?? relinking.sites[0].page}
          count={relinking.sites.length}
          nodes={nodes}
          onClose={() => setRelinking(null)}
          onPick={(n) => {
            const g = relinking;
            setRelinking(null);
            void act(() => {
              const ed = getEditor();
              if (ed) relink(ed, g.sites, { id: n.id, title: n.title });
            });
          }}
        />
      )}
    </aside>
  );
}

/**
 * Relink (G 39): choose the page the links should point at; they all change at once and keep their own text.
 * @param props.name - What the links pointed at.
 * @param props.count - How many links change.
 * @param props.nodes - The pages to choose from.
 * @param props.onPick - Called with the chosen page.
 * @param props.where - The subtitle ("3 links in 2 pages"); "N links in this page" by default.
 * @param props.perPage - The pages that change and how many links each ("Overview (1) · Planning (2)").
 */
export function RelinkDialog({
  name,
  count,
  nodes,
  onClose,
  onPick,
  where,
  perPage,
}: {
  name: string;
  count: number;
  nodes: DocsTreeNode[];
  onClose: () => void;
  onPick: (n: DocsTreeNode) => void;
  where?: string;
  perPage?: string;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return nodes.filter((n) => !t || n.title.toLowerCase().includes(t)).slice(0, 6);
  }, [nodes, q]);
  const chosen = list[Math.min(active, list.length - 1)];
  const parent = (n: DocsTreeNode) => nodes.find((p) => p.id === n.parentId)?.title ?? 'Top level';
  return (
    <ModalShell
      width={520}
      ariaLabel={`Relink “${name}”`}
      title={`Relink “${name}”`}
      subtitle={where ?? `${plural(count, 'link')} in this page`}
      icon="link"
      onClose={onClose}
      testId="relink-dialog"
      zIndex={1300}
      footer={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={!chosen}
            data-testid="relink-apply"
            onClick={() => chosen && onPick(chosen)}
          >
            Relink {plural(count, 'link')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <input
          autoFocus
          className="st-input"
          aria-label="Find a page"
          placeholder="Find a page…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, list.length - 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            else if (e.key === 'Enter' && chosen) onPick(chosen);
            else return;
            e.preventDefault();
          }}
          style={{ height: 38 }}
        />
        <div style={{ border: '1px solid #E3EAE5', borderRadius: 10, padding: '4px 0' }} role="listbox">
          {list.length === 0 && <div style={{ padding: '10px 14px', fontSize: 13, color: '#5B6B60' }}>No page</div>}
          {list.map((n, i) => (
            <div
              key={n.id}
              role="option"
              aria-selected={n === chosen}
              data-testid="relink-option"
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(n)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                minHeight: 44,
                padding: '5px 14px',
                borderRadius: 9,
                margin: '0 6px',
                background: n === chosen ? '#E6F2EA' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: n === chosen ? '#FFFFFF' : '#F1F6F2',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 'none',
                }}
              >
                <PageIcon icon={n.icon} kind={n.kind} size={16} />
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600 }}>{n.title}</span>
              <span style={{ fontSize: 12, color: '#5B6B60' }}>{parent(n)}</span>
            </div>
          ))}
        </div>
        {chosen && (
          <div style={{ fontSize: 12.5, color: '#5B6B60', lineHeight: 1.5 }}>
            {plural(count, 'link')} will point to “{chosen.title}”.{perPage ? ` ${perPage}.` : ''} A link with its own
            text keeps that text.
          </div>
        )}
      </div>
    </ModalShell>
  );
}
