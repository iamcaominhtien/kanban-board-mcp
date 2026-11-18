/**
 * Link, reference and diagram blocks while editing (design "Embeds", sections C, G and H). A link embed shows its
 * card or player with a toolbar (Link card / Embed video, Plain link, Open, Delete); a click on the card selects it
 * instead of opening the link. Page and ticket cards are live and offer "Show as chip". A draw.io diagram keeps the
 * board's own embed (Edit opens the full-screen editor) and adds, when selected, Versions (from the footer), Replace,
 * Remove and its width.
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { client } from '../../../../api/client';
import {
  diagramKeys,
  diagramSvgUrl,
  fetchDiagramWithSource,
  updateDiagram,
  useDiagram,
} from '../../../../api/diagrams';
import { actorName, relativeTime } from '../../../../utils/relativeTime';
import { DiagramEmbed } from '../../../diagrams/DiagramEmbed';
import { useToast } from '../../../Toast';
import { LinkEmbedBlock } from '../../embeds/LinkEmbedBlock';
import { PageCardView, TicketCardView } from '../../embeds/RefCards';
import { videoEmbedOf } from '../../embeds/videoEmbed';
import { useEditorEnv } from '../context';
import { useResolved } from '../useResolved';
import { askBlockUi } from './bus';
import { EmbedToolbar, Sep, ToolBtn } from './embedUi';
import { EmbIcon } from '../../embeds/embIcons';
import { cardToChip } from './refCards';
import { Panel } from './ui';
import '../../embeds/embeds.css';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const posOf = (getPos: NodeViewProps['getPos']) => (typeof getPos === 'function' ? (getPos() ?? null) : null);

/**
 * The link embed node view.
 */
export function LinkEmbedView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const env = useEditorEnv();
  const attrs = node.attrs as Record<string, unknown>;
  const url = str(attrs.url);
  const video = str(attrs.kind) === 'video';
  const editable = editor.isEditable;
  const plain = () => {
    const p = posOf(getPos);
    if (p == null) return;
    const { schema } = editor;
    const text = schema.text(url, [schema.marks.link.create({ href: url })]);
    editor.view.dispatch(editor.state.tr.replaceWith(p, p + node.nodeSize, schema.nodes.paragraph.create(null, text)));
  };
  return (
    <NodeViewWrapper
      className={`dk-link-block${selected ? ' dk-emb-selected' : ''}`}
      contentEditable={false}
      data-testid="link-embed"
      onClickCapture={(e: React.MouseEvent) => {
        // in the editor a click selects the block; Ctrl or Cmd + click still opens the link
        const a = (e.target as HTMLElement).closest('a');
        if (a && editable && !(e.ctrlKey || e.metaKey)) e.preventDefault();
      }}
    >
      {selected && editable && (
        <EmbedToolbar label="Link">
          {videoEmbedOf(url) && (
            <ToolBtn
              label={video ? 'Show as link card' : 'Embed video'}
              wide
              onClick={() => updateAttributes({ kind: video ? 'card' : 'video' })}
            />
          )}
          <ToolBtn label="Plain link" wide onClick={plain} />
          <ToolBtn label="Open" wide onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} />
          <Sep />
          <ToolBtn label="Delete" wide danger onClick={deleteNode} />
        </EmbedToolbar>
      )}
      <div data-drag-handle="">
        <LinkEmbedBlock
          attrs={attrs}
          projectId={env?.projectId}
          onShowAsCard={editable ? () => updateAttributes({ kind: 'card' }) : undefined}
        />
      </div>
    </NodeViewWrapper>
  );
}

/** The "Show as chip" button of a card. */
function ShowAsChip({ editor, getPos }: Pick<NodeViewProps, 'editor' | 'getPos'>) {
  if (!editor.isEditable) return null;
  return (
    <button
      type="button"
      className="st-btn st-btn-sm"
      onClick={() => {
        const p = posOf(getPos);
        if (p != null) cardToChip(editor, p);
      }}
    >
      Show as chip
    </button>
  );
}

/**
 * The page card node view.
 */
export function PageCardNodeView({ node, selected, editor, getPos }: NodeViewProps) {
  const env = useEditorEnv();
  const page = str(node.attrs.page);
  const res = useResolved({ kind: 'page', title: page, anchor: null });
  return (
    <NodeViewWrapper className={`dk-ref-block${selected ? ' dk-emb-selected' : ''}`} contentEditable={false}>
      <div data-drag-handle="">
        <PageCardView
          page={page}
          result={res}
          onOpen={env?.onOpenPage}
          extra={<ShowAsChip editor={editor} getPos={getPos} />}
        />
      </div>
    </NodeViewWrapper>
  );
}

/**
 * The ticket card node view.
 */
export function TicketCardNodeView({ node, selected, editor, getPos }: NodeViewProps) {
  const env = useEditorEnv();
  const key = str(node.attrs.key);
  const res = useResolved({ kind: 'ticket', key });
  return (
    <NodeViewWrapper className={`dk-ref-block${selected ? ' dk-emb-selected' : ''}`} contentEditable={false}>
      <div data-drag-handle="">
        <TicketCardView
          ticketKey={key}
          result={res}
          onOpen={env?.onOpenTicket}
          extra={<ShowAsChip editor={editor} getPos={getPos} />}
        />
      </div>
    </NodeViewWrapper>
  );
}

/** One saved version of a diagram (`GET /diagrams/{id}/versions`). */
interface DiagramVersion {
  version: number;
  author: string;
  note: string | null;
  createdAt: string;
}

/** A diagram's versions, newest first, with Restore on the older ones (frame 25). */
function DiagramVersions({
  id,
  label,
  anchor,
  onClose,
}: {
  id: string;
  label: string;
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const current = useDiagram(id);
  const list = useQuery({
    queryKey: ['diagrams', 'versions', id],
    queryFn: async () => (await client.get<DiagramVersion[]>(`/diagrams/${id}/versions`)).data,
  });
  const [busy, setBusy] = useState<number | null>(null);
  const restore = async (n: number) => {
    const base = current.data?.version;
    if (base == null) return;
    setBusy(n);
    try {
      const old = await fetchDiagramWithSource(id, n);
      const svg = await (await fetch(diagramSvgUrl(id, n))).text();
      await updateDiagram(id, { baseVersion: base, source: old.source ?? '', svg, note: `Restored from v${n}` });
      void qc.invalidateQueries({ queryKey: diagramKeys.one(id).slice(0, 2) });
      void list.refetch();
      toast.success(`Restored v${n}`, 'It is saved as a new version. Nothing is lost.');
    } catch {
      toast.error('Could not restore that version', 'Someone may have changed the diagram. Try again.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title={`${label}: versions`} anchor={anchor} onClose={onClose} testId="diagram-versions">
      {list.isLoading && <p className="dk-bp-muted">Loading the versions…</p>}
      <div className="dk-dg-versions">
        {(list.data ?? []).map((v, i) => (
          <div key={v.version} className="dk-dg-version">
            <span className="dk-dg-ver">v{v.version}</span>
            <span className="dk-dg-vtext">
              <strong>{v.note || (i === (list.data?.length ?? 0) - 1 ? 'First draft' : 'No note')}</strong>
              <span>
                {actorName(v.author)} · {relativeTime(v.createdAt)}
              </span>
            </span>
            {i === 0 ? (
              <span className="dk-dg-current">Current</span>
            ) : (
              <button
                type="button"
                className="dk-emb-link"
                disabled={busy != null}
                onClick={() => void restore(v.version)}
              >
                {busy === v.version ? 'Restoring…' : 'Restore'}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="dk-bp-note">Restoring makes a new version. Nothing is lost.</p>
    </Panel>
  );
}

/** The shared diagram card's own actions, which the Docs toolbar of a selected diagram stands in for. */
type SharedAction = 'Edit' | 'Download' | 'View full size' | 'Copy link';

/** Finds one of the shared diagram card's toolbar buttons (Edit has no aria-label: it is the text button). */
function sharedButton(root: HTMLElement | null, action: SharedAction): HTMLButtonElement | null {
  const bar = root?.querySelector('[role="toolbar"][aria-label="Diagram actions"]');
  if (!bar) return null;
  if (action === 'Edit') return bar.querySelector('button:not([aria-label])');
  return bar.querySelector(`button[aria-label="${action}"]`);
}

/**
 * The draw.io diagram node view. Selected in the editor, one toolbar sits on the card's top right (Embeds board,
 * frame 21): Edit, Download, View full size, Copy link | 50 / 75 / 100 % | Versions, More (Replace, Remove). The
 * first four press the shared card's own buttons, so the diagram behaves as it does everywhere else.
 */
export function DiagramBlockView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const { id, label } = node.attrs as { id: string; label: string };
  const widthPct = typeof node.attrs.widthPct === 'number' ? node.attrs.widthPct : null;
  const editable = editor.isEditable;
  const [versions, setVersions] = useState<DOMRect | null | false>(false);
  const [more, setMore] = useState(false);
  const [shared, setShared] = useState<SharedAction[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const showBar = selected && editable;

  // which of the shared card's actions exist (Edit only when the diagram can be edited); the card fills in once its
  // diagram loads, so it is read again whenever its DOM changes while the toolbar shows
  useEffect(() => {
    const el = box.current;
    if (!showBar || !el) return undefined;
    const read = () => {
      const have = (['Edit', 'Download', 'View full size', 'Copy link'] as SharedAction[]).filter(
        (a) => sharedButton(el, a) != null,
      );
      setShared((cur) => (cur.join() === have.join() ? cur : have));
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(el, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [showBar]);

  useEffect(() => {
    if (!more) return undefined;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.dk-dg-toolbar')) setMore(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMore(false);
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [more]);

  const press = (a: SharedAction) => sharedButton(box.current, a)?.click();
  return (
    <NodeViewWrapper
      className={`dk-diagram dk-dg-block${selected ? ' dk-emb-selected' : ''}`}
      contentEditable={false}
      data-diagram={id}
      style={widthPct ? { width: `${widthPct}%` } : undefined}
    >
      {showBar && (
        <div className="dk-btoolbar dk-dg-toolbar" role="toolbar" aria-label="Diagram" data-block-ui="">
          {shared.includes('Edit') && (
            <ToolBtn label="Edit" wide onClick={() => press('Edit')}>
              <EmbIcon name="pen" /> Edit
            </ToolBtn>
          )}
          {shared.includes('Download') && (
            <ToolBtn label="Download" onClick={() => press('Download')}>
              <EmbIcon name="download" />
            </ToolBtn>
          )}
          {shared.includes('View full size') && (
            <ToolBtn label="View full size" onClick={() => press('View full size')}>
              <EmbIcon name="size" />
            </ToolBtn>
          )}
          {shared.includes('Copy link') && (
            <ToolBtn label="Copy link" onClick={() => press('Copy link')}>
              <EmbIcon name="link" />
            </ToolBtn>
          )}
          <Sep />
          {[50, 75, 100].map((w) => (
            <ToolBtn
              key={w}
              label={`Width ${w}%`}
              wide
              on={(widthPct ?? 100) === w}
              onClick={() => updateAttributes({ widthPct: w === 100 ? null : w })}
            >
              {w}%
            </ToolBtn>
          ))}
          <Sep />
          <ToolBtn label="Versions" onClick={() => setVersions(box.current?.getBoundingClientRect() ?? null)}>
            <EmbIcon name="history" />
          </ToolBtn>
          <span className="dk-dg-more">
            <button
              type="button"
              className={`dk-btb${more ? ' on' : ''}`}
              aria-label="More"
              title="More"
              aria-haspopup="menu"
              aria-expanded={more}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMore((v) => !v)}
            >
              <EmbIcon name="more" />
            </button>
            {more && (
              <div className="dk-emb-menu" role="menu" aria-label="Diagram">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMore(false);
                    const p = posOf(getPos);
                    if (p != null) askBlockUi(editor, { type: 'insertDiagram', replacePos: p });
                  }}
                >
                  <EmbIcon name="swap" /> Replace
                </button>
                <button type="button" role="menuitem" className="dk-emb-del" onClick={deleteNode}>
                  <EmbIcon name="trash" /> Remove
                </button>
              </div>
            )}
          </span>
        </div>
      )}
      <div ref={box}>
        <DiagramEmbed
          id={id}
          label={label}
          readOnly={!editable}
          onReplace={(newId, newLabel) => updateAttributes({ id: newId, label: newLabel })}
          onChanged={(d) => d.label !== label && updateAttributes({ label: d.label })}
        />
      </div>
      {versions !== false && (
        <DiagramVersions id={id} label={label} anchor={versions} onClose={() => setVersions(false)} />
      )}
    </NodeViewWrapper>
  );
}
