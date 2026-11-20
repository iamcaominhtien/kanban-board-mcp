/**
 * Links that become embeds (design "Embeds", section H): pasting a bare address on an empty line opens a small menu
 * (Embed video when the site may be embedded, Link card, Plain link; Esc keeps the plain link), and the catalog's
 * "Embed from link" asks for an address and offers the same choices. Both read the link with `/docs/link-preview`.
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { useLinkPreview, type LinkPreview } from '../../embeds/embedApi';
import { EmbIcon } from '../../embeds/embIcons';
import { hostOf } from '../../embeds/LinkEmbedBlock';
import { ProviderMark } from '../../embeds/VideoBlock';
import { providerName } from '../../embeds/videoEmbed';
import { Dialog } from './ui';

/** What a pasted link can become. */
export type LinkChoice = 'video' | 'card' | 'plain';

/** The attributes of a `linkEmbed` from a link's preview. */
export function linkEmbedAttrs(p: LinkPreview, kind: 'card' | 'video'): Record<string, unknown> {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    url: p.url,
    title: s(p.title),
    description: s(p.description),
    image: s(p.image),
    site: s(p.site),
    kind,
  };
}

/**
 * Puts a link on the page as a card or a player.
 * @param preview - The link and what was read of it (only `url` is needed).
 * @param kind - `card` or `video`.
 * @param where.replacePos - Replace the block at this position (the pasted line, a video).
 */
export function insertLinkEmbed(
  editor: Editor,
  preview: LinkPreview,
  kind: 'card' | 'video',
  where: { replacePos?: number } = {},
): boolean {
  const node = editor.schema.nodes.linkEmbed.create(linkEmbedAttrs(preview, kind));
  if (where.replacePos != null) {
    const old = editor.state.doc.nodeAt(where.replacePos);
    if (!old) return false;
    editor.view.dispatch(editor.state.tr.replaceWith(where.replacePos, where.replacePos + old.nodeSize, node));
    return true;
  }
  return editor.chain().focus().insertContent(node.toJSON()).run();
}

/** True when a preview is a player the project lets the page show. */
export const canEmbedVideo = (p: LinkPreview | undefined) => !!p && p.kind === 'video' && !!p.embeddable && !p.error;

/** The line that says what the link is: its site mark, title and site. */
function LinkSummary({ url, preview, loading }: { url: string; preview?: LinkPreview; loading: boolean }) {
  const site = preview?.site || hostOf(url);
  if (loading) return <div className="dk-plm-sum dk-bp-muted">Reading the link…</div>;
  return (
    <div className="dk-plm-sum">
      <ProviderMark
        provider={preview?.provider ?? undefined}
        name={preview?.provider ? providerName(preview.provider) : site}
        size={30}
      />
      <span className="dk-plm-text">
        <strong>
          {preview?.kind === 'video' && preview.provider ? `${providerName(preview.provider)} video` : site}
        </strong>
        <span>{preview?.title || (preview?.error ? 'Could not read this link' : url)}</span>
      </span>
    </div>
  );
}

/**
 * The menu under a pasted link.
 * @param props.pos - The pasted line's position.
 * @param props.url - The address pasted.
 */
export function PasteLinkMenu({
  editor,
  projectId,
  pos,
  url,
  onClose,
}: {
  editor: Editor;
  projectId: string;
  pos: number;
  url: string;
  onClose: () => void;
}) {
  const q = useLinkPreview(url, projectId);
  const video = canEmbedVideo(q.data);
  const choices: { id: LinkChoice; label: string }[] = [
    ...(video ? [{ id: 'video' as const, label: 'Embed video' }] : []),
    { id: 'card', label: 'Link card' },
    { id: 'plain', label: 'Plain link' },
  ];
  const [active, setActive] = useState(0);
  const live = useRef({ choices, active });
  live.current = { choices, active };
  useEffect(() => setActive(0), [video]);

  const choose = (c: LinkChoice) => {
    onClose();
    if (c === 'plain') return;
    // the line must still be the pasted link alone
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'paragraph' || node.textContent.trim() !== url) return;
    insertLinkEmbed(editor, { ...(q.data ?? {}), url }, c === 'video' ? 'video' : 'card', { replacePos: pos });
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = live.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const n = L.choices.length;
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        chooseRef.current(L.choices[L.active].id);
      }
    };
    // typing anywhere else, or a click away, keeps the plain link
    const onEdit = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    editor.on('transaction', onEdit);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      editor.off('transaction', onEdit);
    };
  }, [editor, onClose]);

  let top = 120;
  let left = 120;
  try {
    const c = editor.view.coordsAtPos(Math.min(pos + 1, editor.state.doc.content.size));
    top = c.bottom + 6;
    left = c.left;
  } catch {
    /* no layout (tests) */
  }
  return (
    <div
      className="dk-menu dk-plm"
      role="menu"
      aria-label="Paste link as"
      data-testid="paste-link-menu"
      data-block-ui=""
      style={{ position: 'fixed', top, left: Math.max(8, Math.min(left, window.innerWidth - 338)), width: 330 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <LinkSummary url={url} preview={q.data} loading={q.isLoading} />
      {choices.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          className={`dk-mi dk-plm-item${i === active ? ' dk-mi-on' : ''}`}
          onMouseEnter={() => setActive(i)}
          onClick={() => choose(c.id)}
        >
          <span className="dk-plm-ic">
            <EmbIcon name={c.id === 'video' ? 'video' : c.id === 'card' ? 'card' : 'link'} size={15} />
          </span>
          <span>{c.label}</span>
          {i === 0 && <span className="dk-plm-key">Enter</span>}
        </button>
      ))}
      <div className="dk-plm-foot">
        <kbd>Esc</kbd> keeps the plain link
      </div>
    </div>
  );
}

/**
 * Embed from link: an address, what it is, and the choice of a card or a player.
 */
export function EmbedLinkDialog({
  editor,
  projectId,
  onClose,
}: {
  editor: Editor;
  projectId: string;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [url, setUrl] = useState('');
  // read the link once typing stops
  useEffect(() => {
    const clean = typed.trim();
    const t = window.setTimeout(() => setUrl(/^https?:\/\/\S+$/i.test(clean) ? clean : ''), 350);
    return () => window.clearTimeout(t);
  }, [typed]);
  const q = useLinkPreview(url || null, projectId);
  const video = canEmbedVideo(q.data);
  const put = (kind: 'card' | 'video') => {
    insertLinkEmbed(editor, { ...(q.data ?? {}), url }, kind);
    onClose();
  };
  return (
    <Dialog
      title="Embed from link"
      onClose={onClose}
      testId="embed-link"
      footer={
        <>
          <button type="button" className="dk-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="dk-btn-ghost" disabled={!url} onClick={() => put('card')}>
            Link card
          </button>
          {video && (
            <button type="button" className="dk-btn-primary" onClick={() => put('video')}>
              Embed video
            </button>
          )}
        </>
      }
    >
      <div className="dk-bp-col">
        <label className="dk-bp-label" htmlFor="dk-embed-url">
          Address
        </label>
        <input
          id="dk-embed-url"
          className="dk-bp-input"
          type="url"
          placeholder="https://www.youtube.com/watch?v=…"
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
        />
        {url && <LinkSummary url={url} preview={q.data} loading={q.isLoading} />}
        <p className="dk-bp-muted">
          A short list of sites can be embedded (YouTube, Vimeo, Loom and a few more); every other link becomes a link
          card, so nothing unknown runs inside a page.
        </p>
      </div>
    </Dialog>
  );
}
