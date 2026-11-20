/**
 * Docs health · Broken links grouped by what the links point at (RichDocsLinks G 40): one card per lost target with
 * why and how many links, the fixes that mend them all (Link to a page…, Create, Remove links, Use the closest
 * heading, Link to another block…, Link to the page, Restore), and a row per page with Go to link. Fixes that edit
 * the pages go through the server's bulk route: each changed page gets a new version.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useDocsLinkTargets, useDocsTree } from '../../../api/docs';
import type { HealthBroken } from '../../../api/docsAiCare';
import { useFixLinks, type LinkFixTo } from '../../../api/docsActions';
import { extractError } from '../../../api/extractError';
import { useToast } from '../../Toast';
import type { DocsTreeNode } from '../../../types/docs';
import { ModalShell, plural } from '../docsShared';
import { RelinkDialog } from './LinkChecker';
import { KindGlyph } from './BlockKind';

/** A fix for a whole group: relink its links, or remove them and keep their words. */
export type GroupFix = { action: 'relink'; to: LinkFixTo; label: string } | { action: 'remove' };

/** How alike two strings are (Dice coefficient of their letter pairs, 0..1). */
export function alike(a: string, b: string): number {
  const pairs = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
    const out: string[] = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  if (!pa.length || !pb.length) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  const bag = new Map<string, number>();
  for (const p of pb) bag.set(p, (bag.get(p) ?? 0) + 1);
  let hit = 0;
  for (const p of pa) {
    const n = bag.get(p) ?? 0;
    if (n > 0) {
      hit += 1;
      bag.set(p, n - 1);
    }
  }
  return (2 * hit) / (pa.length + pb.length);
}

/** The heading of a page closest to a lost one, when one is alike enough (≥ 0.5). */
export function closestHeading(lost: string, headings: { text: string }[]): string | null {
  let best: { text: string; score: number } | null = null;
  for (const h of headings) {
    const score = alike(lost, h.text);
    if (score >= 0.5 && (!best || score > best.score)) best = { text: h.text, score };
  }
  return best?.text ?? null;
}

/** A lost target and the links that point at it. */
export interface BrokenGroup {
  key: string;
  status: HealthBroken['status'];
  /** The page title the links name. */
  page: string;
  /** The heading or block, when they name one. */
  anchor: string | null;
  rows: HealthBroken[];
}

/** Splits `[[Page#Anchor]]` into its page and anchor. */
export function parseRef(ref: string): { page: string; anchor: string | null } {
  const inner = ref.replace(/^\[\[/, '').replace(/\]\]$/, '');
  const at = inner.indexOf('#');
  return at < 0 ? { page: inner, anchor: null } : { page: inner.slice(0, at), anchor: inner.slice(at + 1) || null };
}

/** Groups broken links by what they point at (and why), largest group first. */
export function groupBroken(items: HealthBroken[]): BrokenGroup[] {
  const by = new Map<string, BrokenGroup>();
  for (const it of items) {
    const key = `${it.status}|${it.ref}`;
    // a picture, video or file whose upload is gone is named by its caption, title or file name
    const named = isMedia(it.status) ? { page: it.name || it.ref, anchor: null } : parseRef(it.ref);
    const g = by.get(key) ?? { key, status: it.status, ...named, rows: [] };
    g.rows.push(it);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.rows.length - a.rows.length);
}

/** Whether a row is a picture, video or file whose upload is gone (not a link). */
export function isMedia(status: string): boolean {
  return status === 'image_missing' || status === 'video_missing' || status === 'file_missing';
}

/** What a gone upload says (Ai H 47): "The image file was deleted: “…”", "Video “…” is not in Project files any more". */
export function mediaWhy(status: string, name: string): string {
  if (status === 'video_missing') return `Video “${name}” is not in Project files any more`;
  if (status === 'file_missing') return `File “${name}” is not in Project files any more`;
  return `The image file was deleted: “${name}”`;
}

/** The IN column's word and glyph for a block's node type (Ai H 47): Paragraph, Heading, Image, Video, File, Embed… */
const BLOCK_TYPES: Record<string, { word: string; kind: string }> = {
  paragraph: { word: 'Paragraph', kind: 'heading' },
  heading: { word: 'Heading', kind: 'heading' },
  image: { word: 'Image', kind: 'image' },
  video: { word: 'Video', kind: 'video' },
  fileCard: { word: 'File', kind: 'file' },
  htmlEmbed: { word: 'Embed', kind: 'embed' },
  linkEmbed: { word: 'Embed', kind: 'embed' },
  table: { word: 'Table', kind: 'table' },
  codeBlock: { word: 'Code', kind: 'code' },
  callout: { word: 'Callout', kind: 'callout' },
  bulletList: { word: 'List', kind: 'list' },
  orderedList: { word: 'List', kind: 'list' },
  taskList: { word: 'Task list', kind: 'list' },
  blockquote: { word: 'Quote', kind: 'quote' },
  pullQuote: { word: 'Quote', kind: 'quote' },
  pageCard: { word: 'Page card', kind: 'link' },
  diagram: { word: 'Diagram', kind: 'diagram' },
};

/** The IN pill of a row: 20 px, #F1F3F1, 11 px bold, the block's glyph and type. */
export function BlockTypePill({ type }: { type: string }) {
  const t = BLOCK_TYPES[type] ?? { word: type.charAt(0).toUpperCase() + type.slice(1), kind: 'text' };
  return (
    <span
      data-testid="health-block-type"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        padding: '0 7px',
        borderRadius: 5,
        background: '#F1F3F1',
        fontSize: 11,
        fontWeight: 700,
        color: '#3A4A3E',
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
      }}
    >
      <KindGlyph kind={t.kind} size={11} />
      {t.word}
    </span>
  );
}

const WHY: Record<string, string> = {
  image_missing: 'Image not found',
  video_missing: 'Video not found',
  file_missing: 'File not found',
  missing: 'Page not found',
  in_bin: 'In Recycle Bin',
  section_missing: 'Heading not found',
  block_missing: 'Block not found',
};

const HEAD_BG: Record<string, string> = {
  missing: '#FDF1EE',
  in_bin: '#F6F7F6',
  section_missing: '#FDF6EA',
  block_missing: '#FDF6EA',
  image_missing: '#FDF1EE',
  video_missing: '#FDF1EE',
  file_missing: '#FDF1EE',
};

const CHIP: Record<string, CSSProperties> = {
  missing: { background: '#FDF1EE', color: '#C4432A', border: '1.5px dashed #C4432A' },
  in_bin: { background: '#F1F3F1', color: '#5B6B60', border: '1px solid #C7D2CB', textDecoration: 'line-through' },
  section_missing: { background: '#FDF3E3', color: '#8A5A00', border: '1.5px dashed #C98A1B' },
  block_missing: { background: '#FDF3E3', color: '#8A5A00', border: '1.5px dashed #C98A1B' },
  image_missing: { background: '#FDF1EE', color: '#C4432A', border: '1.5px dashed #C4432A' },
  video_missing: { background: '#FDF1EE', color: '#C4432A', border: '1.5px dashed #C4432A' },
  file_missing: { background: '#FDF1EE', color: '#C4432A', border: '1.5px dashed #C4432A' },
};

const primary: CSSProperties = { background: '#2E6F40', color: '#fff', borderColor: '#2E6F40' };

/** The page a group's links name, from the tree (title compared case-insensitively). */
function pageNamed(nodes: DocsTreeNode[] | undefined, title: string): DocsTreeNode | undefined {
  const t = title.trim().toLowerCase();
  return nodes?.find((n) => n.title.trim().toLowerCase() === t);
}

/**
 * The fix buttons of one group, by why its links are broken (G 40).
 */
function GroupActions({
  g,
  nodes,
  busy,
  onFix,
  onCreate,
  onRestore,
  onRelink,
  onPickBlock,
}: {
  g: BrokenGroup;
  nodes?: DocsTreeNode[];
  busy: boolean;
  onFix?: (g: BrokenGroup, fix: GroupFix) => void;
  onCreate?: (title: string) => void;
  onRestore?: (pageId: string) => void;
  onRelink: () => void;
  onPickBlock: () => void;
}) {
  const target = pageNamed(nodes, g.page);
  const needsTargets = g.status === 'section_missing' && !!target;
  const targets = useDocsLinkTargets(needsTargets ? target.id : null);
  const closest =
    g.status === 'section_missing' && g.anchor && targets.data ? closestHeading(g.anchor, targets.data.headings) : null;
  const binId = g.rows.find((r) => r.targetPageId)?.targetPageId;
  const n = g.rows.length;
  const btn = (label: string, onClick: () => void, opts: { primary?: boolean; testId?: string } = {}) => (
    <button
      type="button"
      className="st-btn st-btn-sm"
      data-testid={opts.testId}
      disabled={busy}
      style={opts.primary ? primary : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
  const toPage =
    target &&
    onFix &&
    btn('Link to the page', () => onFix(g, { action: 'relink', to: { pageId: target.id }, label: target.title }), {
      testId: 'broken-to-page',
    });
  const remove =
    onFix &&
    btn(n === 1 ? 'Remove link' : 'Remove links', () => onFix(g, { action: 'remove' }), {
      testId: 'broken-remove',
    });
  return (
    <div className="bg-acts" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {g.status === 'missing' && (
        <>
          {onFix && nodes && btn('Link to a page…', onRelink, { primary: true, testId: 'broken-relink' })}
          {onCreate && btn(`Create “${g.page}”`, () => onCreate(g.page), { testId: 'broken-create' })}
          {remove}
        </>
      )}
      {g.status === 'section_missing' && (
        <>
          {closest &&
            target &&
            onFix &&
            btn(
              n === 1 ? `Use “${closest}”` : n === 2 ? `Use “${closest}” for both` : `Use “${closest}” for all`,
              () =>
                onFix(g, {
                  action: 'relink',
                  to: { pageId: target.id, section: closest },
                  label: `${target.title} › ${closest}`,
                }),
              { primary: true, testId: 'broken-use-closest' },
            )}
          {toPage}
        </>
      )}
      {g.status === 'block_missing' && (
        <>
          {target &&
            onFix &&
            btn('Link to another block…', onPickBlock, { primary: true, testId: 'broken-pick-block' })}
          {toPage}
        </>
      )}
      {g.status === 'in_bin' && (
        <>
          {binId && onRestore && btn(`Restore “${g.page}”`, () => onRestore(binId), { primary: true })}
          {remove}
        </>
      )}
    </div>
  );
}

/**
 * Link to another block (G 40): the headings and blocks of the page the lost block was on.
 */
function BlockPickDialog({
  page,
  count,
  onClose,
  onPick,
}: {
  page: DocsTreeNode;
  count: number;
  onClose: () => void;
  onPick: (to: LinkFixTo, label: string) => void;
}) {
  const targets = useDocsLinkTargets(page.id);
  const rows = useMemo(() => {
    const d = targets.data;
    if (!d) return [];
    return [
      ...d.headings.map((h) => ({
        id: h.blockId,
        kind: 'heading',
        label: h.text,
        detail: `H${h.level}`,
        to: { pageId: page.id, section: h.text, blockId: h.blockId, blockLabel: h.text },
      })),
      ...d.blocks.map((b) => ({
        id: b.blockId,
        kind: b.kind,
        label: b.label,
        detail: b.detail,
        to: { pageId: page.id, blockId: b.blockId, blockLabel: b.label },
      })),
    ];
  }, [targets.data, page.id]);
  return (
    <ModalShell
      width={520}
      ariaLabel="Link to another block"
      title={`Link to another block of “${page.title}”`}
      subtitle={`${plural(count, 'link')} will point to the block you choose`}
      icon="link"
      onClose={onClose}
      testId="broken-block-dialog"
      zIndex={1300}
      footer={
        <button type="button" className="st-btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div style={{ border: '1px solid #E3EAE5', borderRadius: 10, padding: '4px 0' }} role="listbox">
        {targets.isLoading && <div style={{ padding: '10px 14px', fontSize: 13, color: '#5B6B60' }}>Loading…</div>}
        {!targets.isLoading && rows.length === 0 && (
          <div style={{ padding: '10px 14px', fontSize: 13, color: '#5B6B60' }}>
            This page has no headings or blocks
          </div>
        )}
        {rows.map((r) => (
          <button
            type="button"
            key={r.id}
            role="option"
            aria-selected={false}
            data-testid="broken-block-option"
            onClick={() => onPick(r.to, `${page.title} › ${r.label}`)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: 'calc(100% - 12px)',
              minHeight: 38,
              margin: '0 6px',
              padding: '5px 10px',
              border: 'none',
              borderRadius: 8,
              background: 'transparent',
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: '#E3EFFA',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
              }}
            >
              <KindGlyph kind={r.kind} size={12} />
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{r.label}</span>
            <span style={{ fontSize: 12, color: '#5B6B60' }}>{r.detail}</span>
          </button>
        ))}
      </div>
    </ModalShell>
  );
}

/**
 * The broken links of the space, one card per target.
 * @param props.items - Docs health's broken links.
 * @param props.onOpenPage - Opens a page, at the block the link sits in when known.
 * @param props.onCreate - Creates a page with this title (mends every link to a missing page by its title).
 * @param props.onRestore - Restores a page from the Recycle Bin.
 * @param props.dismiss - Each row's dismiss menu.
 * @param props.nodes - The page tree (Relink's list, and the page a group's links name).
 * @param props.onFix - Fixes a whole group in the pages that hold its links (relink or remove); without it only
 *   Create and Restore are offered.
 * @param props.busy - A fix is running: the buttons wait.
 */
export function BrokenGroups({
  items,
  onOpenPage,
  onCreate,
  onRestore,
  dismiss,
  nodes,
  onFix,
  busy = false,
}: {
  items: HealthBroken[];
  onOpenPage: (id: string, anchor?: string) => void;
  onCreate?: (title: string) => void;
  onRestore?: (pageId: string) => void;
  dismiss: (row: HealthBroken) => ReactNode;
  nodes?: DocsTreeNode[];
  onFix?: (g: BrokenGroup, fix: GroupFix) => void;
  busy?: boolean;
}) {
  const groups = groupBroken(items);
  const [relinking, setRelinking] = useState<BrokenGroup | null>(null);
  const [picking, setPicking] = useState<BrokenGroup | null>(null);
  const pickPage = picking ? pageNamed(nodes, picking.page) : undefined;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map((g) => {
        const pages = new Set(g.rows.map((r) => r.pageId)).size;
        return (
          <div
            key={g.key}
            data-testid="health-broken-group"
            className="bg-group"
            style={{ border: '1px solid #E3E8E5', borderRadius: 12, background: '#fff', overflow: 'hidden' }}
          >
            <div
              className="bg-head"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                background: HEAD_BG[g.status] ?? '#FBFCFB',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
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
                  ...CHIP[g.status],
                }}
              >
                {g.page}
                {g.anchor && (
                  <>
                    <span style={{ opacity: 0.55 }}>›</span>
                    {g.anchor}
                  </>
                )}
              </span>
              <span className="bg-why" style={{ fontSize: 12.5, color: '#3A4A3E', flex: 1, minWidth: 200 }}>
                <b>{WHY[g.status] ?? g.status}</b> ·{' '}
                {isMedia(g.status)
                  ? mediaWhy(g.status, g.page)
                  : `${plural(g.rows.length, 'link')} in ${plural(pages, 'page')}`}
              </span>
              <GroupActions
                g={g}
                nodes={nodes}
                busy={busy}
                onFix={onFix}
                onCreate={onCreate}
                onRestore={onRestore}
                onRelink={() => setRelinking(g)}
                onPickBlock={() => setPicking(g)}
              />
            </div>
            <div style={{ padding: '0 16px' }}>
              {g.rows.map((r) => (
                <div
                  key={`${r.pageId}|${r.blockId ?? ''}`}
                  data-testid="health-broken"
                  className="bg-row"
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    padding: '10px 0',
                    borderTop: '1px solid #EEF3EF',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700 }}>{r.title}</div>
                  {r.blockType && (
                    <span style={{ width: 110, flex: 'none' }}>
                      <BlockTypePill type={r.blockType} />
                    </span>
                  )}
                  <button
                    type="button"
                    className="bg-open"
                    onClick={() => onOpenPage(r.pageId, r.blockId ?? undefined)}
                    style={{
                      border: 'none',
                      background: 'none',
                      padding: 0,
                      font: 'inherit',
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: '#2E6F40',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isMedia(r.status) ? 'Review' : r.blockId ? 'Go to link' : 'Open page'}
                  </button>
                  {dismiss(r)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {relinking && nodes && onFix && (
        <RelinkDialog
          name={relinking.anchor ? `${relinking.page} › ${relinking.anchor}` : relinking.page}
          count={relinking.rows.length}
          where={`${plural(relinking.rows.length, 'link')} in ${plural(new Set(relinking.rows.map((r) => r.pageId)).size, 'page')}`}
          perPage={perPage(relinking)}
          nodes={nodes}
          onClose={() => setRelinking(null)}
          onPick={(n) => {
            const g = relinking;
            setRelinking(null);
            onFix(g, { action: 'relink', to: { pageId: n.id }, label: n.title });
          }}
        />
      )}
      {picking && pickPage && onFix && (
        <BlockPickDialog
          page={pickPage}
          count={picking.rows.length}
          onClose={() => setPicking(null)}
          onPick={(to, label) => {
            const g = picking;
            setPicking(null);
            onFix(g, { action: 'relink', to, label });
          }}
        />
      )}
    </div>
  );
}

/** "Overview (1) · 2026-10-02 Planning (2)": the pages of a group and how many of its links each holds. */
export function perPage(g: BrokenGroup): string {
  const by = new Map<string, { title: string; n: number }>();
  for (const r of g.rows) {
    const e = by.get(r.pageId) ?? { title: r.title, n: 0 };
    e.n += 1;
    by.set(r.pageId, e);
  }
  return [...by.values()].map((e) => `${e.title} (${e.n})`).join(' · ');
}

/**
 * {@link BrokenGroups} with the fixes that edit the pages (Relink, Use the closest heading, Link to another block, Link
 * to the page, Remove links), through the bulk route; a toast says what changed.
 * @param props.projectId - The project.
 * @param props.onFixed - Called after a fix (Docs health checks again).
 */
export function BrokenGroupsWithFixes({
  projectId,
  onFixed,
  ...rest
}: Omit<Parameters<typeof BrokenGroups>[0], 'nodes' | 'onFix' | 'busy'> & { projectId: string; onFixed?: () => void }) {
  const tree = useDocsTree(projectId);
  const fix = useFixLinks(projectId);
  const toast = useToast();
  const onFix = (g: BrokenGroup, f: GroupFix) => {
    const pages = [...new Set(g.rows.map((r) => r.pageId))];
    fix
      .mutateAsync({
        page: g.page,
        anchor: g.anchor,
        pages,
        action: f.action,
        to: f.action === 'relink' ? f.to : undefined,
      })
      .then((res) => {
        const where = `${plural(res.links, 'link')} in ${plural(res.pages, 'page')}`;
        toast.success(
          f.action === 'relink' ? `${where} now point to “${f.label}”` : `${where} removed, their words kept`,
          res.skipped.length ? `${plural(res.skipped.length, 'page')} could not be changed now.` : undefined,
        );
        onFixed?.();
      })
      .catch((e) => toast.error("Couldn't fix the links", extractError(e)));
  };
  return <BrokenGroups {...rest} nodes={tree.data} onFix={onFix} busy={fix.isPending} />;
}
