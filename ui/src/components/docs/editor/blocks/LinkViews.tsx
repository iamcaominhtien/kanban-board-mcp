/**
 * Link, reference and diagram blocks while editing (design "Embeds", sections C, G and H). A link embed shows its
 * card or player with a toolbar (Link card / Embed video, Plain link, Open, Delete); a click on the card selects it
 * instead of opening the link. Page and ticket cards are live and offer "Show as chip". A draw.io diagram keeps the
 * board's own embed (Edit opens the full-screen editor) and adds, when selected, Versions (from the footer), Replace,
 * Remove and its width.
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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

/**
 * The draw.io diagram node view.
 */
export function DiagramBlockView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const { id, label } = node.attrs as { id: string; label: string };
  const widthPct = typeof node.attrs.widthPct === 'number' ? node.attrs.widthPct : null;
  const editable = editor.isEditable;
  const [versions, setVersions] = useState<DOMRect | null | false>(false);
  const box = useRef<HTMLDivElement>(null);
  return (
    <NodeViewWrapper
      className={`dk-diagram dk-dg-block${selected ? ' dk-emb-selected' : ''}`}
      contentEditable={false}
      data-diagram={id}
      style={widthPct ? { width: `${widthPct}%` } : undefined}
    >
      {selected && editable && (
        <EmbedToolbar label="Diagram">
          <ToolBtn label="Versions" wide onClick={() => setVersions(box.current?.getBoundingClientRect() ?? null)} />
          <ToolBtn
            label="Replace"
            wide
            onClick={() => {
              const p = posOf(getPos);
              if (p != null) askBlockUi(editor, { type: 'insertDiagram', replacePos: p });
            }}
          />
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
          <ToolBtn label="Remove" wide danger onClick={deleteNode} />
        </EmbedToolbar>
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
