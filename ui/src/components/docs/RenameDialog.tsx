import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { docsErrorDetail, docsKeys, patchPageSettings, useDocsPage } from '../../api/docs';
import { useRenamePreview, useRenameWithLinks } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { IconPicker } from './tree/IconPicker';
import { PageIcon } from './tree/treeParts';
import { useToast } from '../Toast';
import { Icon } from './Icon';
import { FooterNote, ModalShell, Spacer, plural } from './docsShared';
import { RenameLinkGroups, mentionKey } from './links/RenameGroups';
import type { RenameMention } from '../../types/docsActions';

interface RenameDialogProps {
  projectId: string;
  page: { id: string; title: string };
  newTitle: string;
  onClose: () => void;
  onRenamed: (page: DocsPage) => void;
  /** The tree: a title another page under the same parent has is refused, and the icon shows from it. */
  nodes?: DocsTreeNode[];
  layout?: DocsLayout;
}

const mono: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * Confirm a rename and choose whether to rewrite links.
 * @param props.page - Page being renamed.
 * @param props.newTitle - Proposed new title.
 * @param props.onClose - Called to dismiss the dialog.
 * @param props.onRenamed - Called with the renamed page.
 * @param props.nodes - The tree, to refuse a title a sibling has and to show the page icon.
 * @param props.layout - The Docs area's layout (the icon picker is a sheet on a phone).
 */
export function RenameDialog({
  projectId,
  page,
  newTitle,
  onClose,
  onRenamed,
  nodes,
  layout = 'desktop',
}: RenameDialogProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const full = useDocsPage(page.id);
  const node = nodes?.find((n) => n.id === page.id);
  const [icon, setIcon] = useState<string | null | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const shownIcon =
    icon !== undefined ? icon : ((full.data?.settings?.icon as string | undefined) ?? node?.icon ?? null);
  const rename = useRenameWithLinks(projectId);
  const [title, setTitle] = useState(newTitle);
  const [debounced, setDebounced] = useState(newTitle);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = title.trim();
  const unchanged = trimmed === page.title;
  // the field says what is wrong; Rename stays off until it is fixed
  const sibling =
    !unchanged && node
      ? nodes?.find(
          (n) => n.id !== page.id && n.parentId === node.parentId && n.title.toLowerCase() === trimmed.toLowerCase(),
        )
      : undefined;
  const problem = !trimmed
    ? 'Give the page a title.'
    : sibling
      ? `A page called “${sibling.title}” already exists here. Use another title.`
      : null;

  /** The icon is part of the name: it is saved as soon as it is picked. */
  async function saveIcon(next: string | null) {
    setPicking(false);
    setIcon(next);
    try {
      const saved = await patchPageSettings(page.id, { icon: next });
      qc.setQueryData<DocsPage>(docsKeys.page(page.id), (old) => (old ? { ...old, ...saved } : saved));
      qc.setQueryData<DocsTreeNode[]>(docsKeys.tree(projectId), (old) =>
        old?.map((n) => (n.id === page.id ? { ...n, icon: next } : n)),
      );
    } catch (e) {
      setIcon(undefined);
      toast.error("Couldn't change the page icon", docsErrorDetail(e)?.message ?? extractError(e));
    }
  }

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(title), 200);
    return () => window.clearTimeout(t);
  }, [title]);

  const preview = useRenamePreview(page.id, debounced, !!debounced.trim() && debounced.trim() !== page.title, true);
  // the plain-text mentions change only where the person ticks them (H 44)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const mentions = useMemo(() => preview.data?.mentions ?? [], [preview.data]);
  const chosenMentions = mentions.filter((m) => chosen.has(mentionKey(m)));
  const chosenCount = chosenMentions.reduce((n, m) => n + m.count, 0);
  const chosenPages = new Set(chosenMentions.map((m) => m.pageId)).size;
  const toggleMention = (m: RenameMention) =>
    setChosen((old) => {
      const next = new Set(old);
      if (next.has(mentionKey(m))) next.delete(mentionKey(m));
      else next.add(mentionKey(m));
      return next;
    });
  const affected = useMemo(
    () => (preview.data && debounced.trim() === trimmed ? preview.data.affectedPages : []),
    [preview.data, debounced, trimmed],
  );
  const links = affected.reduce((n, a) => n + a.count, 0) || preview.data?.total || 0;
  const crumbs = (full.data?.path ?? []).map((p) => p.title);
  if (!crumbs.length || crumbs[crumbs.length - 1] !== page.title) crumbs.push(page.title);
  const hasLinks = affected.length > 0 && links > 0;

  async function run(rewriteLinks: boolean) {
    if (!trimmed || unchanged || problem) return;
    setError(null);
    const oldTitle = page.title;
    try {
      const rewriteMentions = chosenMentions.map((m) => ({ pageId: m.pageId, blockId: m.blockId }));
      const res = await rename.mutateAsync({ pageId: page.id, title: trimmed, rewriteLinks, rewriteMentions });
      const updated = rewriteLinks ? (res.rewritten ?? links) : 0;
      const changed = res.mentionsChanged ?? 0;
      const lines = [
        rewriteLinks && updated ? `${plural(updated, 'link')} on ${plural(affected.length, 'page')} updated.` : '',
        changed ? `${plural(changed, 'plain-text mention')} changed.` : '',
      ].filter(Boolean);
      toast.showToast({
        variant: 'success',
        title: `Renamed to “${res.title}”`,
        message: lines.length ? lines.join(' ') : undefined,
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: () => {
            rename
              .mutateAsync({ pageId: page.id, title: oldTitle, rewriteLinks })
              .then(() => toast.success(`Renamed back to “${oldTitle}”`))
              .catch((err) =>
                toast.error("Couldn't undo the rename", docsErrorDetail(err)?.message ?? extractError(err)),
              );
          },
        },
      });
      onRenamed(res);
      onClose();
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  return (
    <ModalShell
      width={560}
      ariaLabel="Rename page"
      title={<>Rename '{page.title}'</>}
      subtitle={crumbs.join(' › ')}
      onClose={onClose}
      bodyStyle={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={
        <>
          {chosenCount > 0 ? (
            <FooterNote>
              Changes {plural(chosenCount, 'plain-text mention')} · creates a version on{' '}
              {chosenPages === 1 ? 'that page' : 'those pages'}
            </FooterNote>
          ) : hasLinks ? (
            <FooterNote>
              Updates {plural(links, 'link')} written as text · creates a version on{' '}
              {affected.length === 1 ? 'that page' : `those ${affected.length} pages`}
            </FooterNote>
          ) : (
            <FooterNote>Links to this page keep working.</FooterNote>
          )}
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            data-testid="confirm-rename"
            disabled={!trimmed || unchanged || !!problem || rename.isPending}
            onClick={() => void run(hasLinks)}
          >
            <Icon name="i10" size={14} />
            {rename.isPending ? 'Renaming…' : 'Rename'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(hasLinks);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        <label className="st-field-label" htmlFor="rename-title">
          New title
        </label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <button
            type="button"
            className="st-btn"
            aria-label={shownIcon ? 'Change the page icon' : 'Add a page icon'}
            title="Page icon"
            data-testid="rename-icon"
            style={{ padding: '0 10px', flexShrink: 0 }}
            onClick={() => setPicking(true)}
          >
            <PageIcon icon={shownIcon} size={18} />
          </button>
          <input
            id="rename-title"
            ref={inputRef}
            className="st-input"
            aria-invalid={!!problem && !unchanged}
            aria-describedby={problem ? 'rename-problem' : undefined}
            style={
              problem && title !== page.title
                ? { flex: 1, borderColor: '#C4432A', boxShadow: '0 0 0 3px rgba(196,67,42,0.15)' }
                : { flex: 1, borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' }
            }
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {problem && title !== page.title ? (
          <span id="rename-problem" role="alert" style={{ fontSize: 12, color: '#A5321E' }}>
            {problem}
          </span>
        ) : (
          <span className="st-hint" style={{ fontSize: 12, color: '#5B6B60' }}>
            Links to this page keep working: they point at the page, and show the new title. The old address keeps
            working too.
          </span>
        )}
      </form>
      {picking && (
        <IconPicker
          projectId={projectId}
          title={trimmed || page.title}
          current={shownIcon}
          layout={layout}
          onClose={() => setPicking(false)}
          onPick={(v) => void saveIcon(v)}
        />
      )}
      {/* what happens to the links (RichDocsLinks H 44): they follow; links with their own text keep it */}
      {!unchanged && trimmed && !problem && (
        <RenameLinkGroups
          pageId={page.id}
          oldTitle={page.title}
          newTitle={trimmed}
          mentions={debounced.trim() === trimmed ? mentions : []}
          chosen={chosen}
          onToggle={toggleMention}
        />
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
          {error}
        </div>
      )}
    </ModalShell>
  );
}

/**
 * Inline note shown after a heading edit is committed: old anchors keep working through an alias.
 * @param props.oldSlug - Anchor before the edit.
 * @param props.newSlug - Anchor after the edit.
 * @param props.count - Number of links to the section that keep working.
 * @param props.from - Where the links come from, shown in the note.
 */
export function HeadingRenameNote({
  oldSlug,
  newSlug,
  count,
  from,
}: {
  oldSlug: string;
  newSlug: string;
  count: number;
  from?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '11px 13px',
        borderRadius: 8,
        background: '#E8F1FB',
        border: '1px solid #B9D3EE',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>
        <span style={{ color: '#2F6FB0', display: 'flex' }}>
          <Icon name="i28" size={16} />
        </span>
        {plural(count, 'link')} to this section will keep working (redirect)
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#3A4A3E', flexWrap: 'wrap' }}>
        <span style={{ ...mono, color: '#A5321E' }}>#{oldSlug}</span>
        <Icon name="i29" size={13} strokeWidth={2} />
        <span style={{ ...mono, color: '#1F5A31' }}>#{newSlug}</span>
        <span style={{ color: '#5B6B60' }}>{from ? `from ${from}; ` : ''}the old anchor is kept as an alias</span>
      </div>
    </div>
  );
}
