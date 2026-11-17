/**
 * Video and file blocks while editing (design "Embeds", sections B and E). A video shows its poster and Play (it never
 * starts by itself), its caption and description, and when selected a toolbar (width, Properties, Replace, Delete);
 * the properties panel sets the poster, loop, muted, width, caption, description and title. A file card shows the
 * file's type, name and size with Download and More (Open in viewer, Show as preview / card, Rename, Replace file,
 * Copy link, Delete); its preview shows inline. Both show their upload's progress and refusals.
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useRef, useState, useSyncExternalStore } from 'react';
import { uploadUrl } from '../../../../api/tickets';
import { getFileTypeMeta } from '../../../../utils/fileIcons';
import { itemFromUpload, usePreview } from '../../../preview/PreviewContext';
import { useToast } from '../../../Toast';
import { uploadDocsFile, uploadPath } from '../../embeds/embedApi';
import { FilePreview } from '../../embeds/FileBlock';
import { ProviderPlayer, VideoCaption, VideoPlayer } from '../../embeds/VideoBlock';
import { VIDEO_ACCEPT, fileNameOf, videoEmbedOf, youtubePoster } from '../../embeds/videoEmbed';
import { Icon } from '../../Icon';
import { askBlockUi, blockKitOf } from './bus';
import { SNAP_STEPS } from './commands';
import { docUploadFor, docUploadsVersion, startDocUpload, subscribeDocUploads } from './docUpload';
import { EmbedToolbar, FileBadge, Sep, ToolBtn, UploadCard } from './embedUi';
import { uploadedSrc } from './imageUpload';
import { Panel, Row, Seg, Toggle, formatBytes, useBlockLayout } from './ui';
import '../../embeds/embeds.css';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const posOf = (getPos: NodeViewProps['getPos']) => (typeof getPos === 'function' ? (getPos() ?? null) : null);

/** The video properties panel (frame 15). */
function VideoProps({
  attrs,
  update,
  anchor,
  onClose,
  projectId,
}: {
  attrs: Record<string, unknown>;
  update: (a: Record<string, unknown>) => void;
  anchor: DOMRect | null;
  onClose: () => void;
  projectId: string | null;
}) {
  const toast = useToast();
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const src = str(attrs.src);
  return (
    <Panel
      title="Video properties"
      anchor={anchor}
      onClose={onClose}
      testId="video-props"
      footer={
        <button type="button" className="dk-btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="dk-bp-muted">{fileNameOf(src)}</div>
      <Row label="Poster image" hint="The picture shown before play.">
        {str(attrs.poster) && <img className="dk-vid-poster-thumb" src={str(attrs.poster)} alt="" />}
        <div className="dk-bp-row-inline">
          <button
            type="button"
            className="dk-btn-ghost"
            disabled={busy || !projectId}
            onClick={() => pick.current?.click()}
          >
            {busy ? 'Uploading…' : 'Choose image'}
          </button>
          {str(attrs.poster) && (
            <button type="button" className="dk-btn-ghost" onClick={() => update({ poster: null })}>
              Remove poster
            </button>
          )}
        </div>
        <input
          ref={pick}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp"
          aria-label="Choose a poster image"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f || !projectId) return;
            setBusy(true);
            uploadDocsFile(projectId, f, 'image')
              .then((res) => update({ poster: uploadedSrc(res.src) }))
              .catch(() => toast.error('Could not upload the poster', 'PNG, JPG, GIF or WebP, up to 10 MB.'))
              .finally(() => setBusy(false));
          }}
        />
      </Row>
      <Row label="Playback" hint="Video never starts by itself, and sound is on when you press play.">
        <Toggle label="Loop" checked={!!attrs.loop} onChange={(v) => update({ loop: v })} />
        <Toggle label="Muted" checked={!!attrs.muted} onChange={(v) => update({ muted: v })} />
      </Row>
      <Row label="Width">
        <Seg
          label="Width"
          value={typeof attrs.widthPct === 'number' ? attrs.widthPct : 100}
          onChange={(v) => update({ widthPct: v })}
          options={SNAP_STEPS.map((s) => ({ value: s, label: `${s}%` }))}
        />
      </Row>
      <Row label="Title">
        <input
          className="dk-bp-input"
          aria-label="Video title"
          value={str(attrs.title)}
          onChange={(e) => update({ title: e.target.value || null })}
        />
      </Row>
      <Row label="Caption">
        <input
          className="dk-bp-input"
          aria-label="Caption"
          value={str(attrs.caption)}
          onChange={(e) => update({ caption: e.target.value || null })}
        />
      </Row>
      <Row label="Description" hint="Read by screen readers.">
        <textarea
          className="dk-bp-input"
          aria-label="Description"
          rows={3}
          value={str(attrs.description)}
          onChange={(e) => update({ description: e.target.value || null })}
        />
      </Row>
    </Panel>
  );
}

/**
 * The video node view.
 */
export function VideoView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  useSyncExternalStore(subscribeDocUploads, docUploadsVersion);
  const attrs = node.attrs as Record<string, unknown>;
  const src = str(attrs.src);
  const upload = docUploadFor(src);
  const provider = str(attrs.provider) || 'file';
  const widthPct = typeof attrs.widthPct === 'number' ? attrs.widthPct : 100;
  const editable = editor.isEditable;
  const [props, setProps] = useState<DOMRect | null | false>(false);
  const wrap = useRef<HTMLDivElement>(null);
  const kit = blockKitOf(editor);
  const replace = () => {
    const p = posOf(getPos);
    if (p != null) askBlockUi(editor, { type: 'insertVideo', replacePos: p });
  };
  const asFile = () => {
    const p = posOf(getPos);
    if (p == null) return;
    const path = uploadPath(src) ?? src;
    const card = editor.schema.nodes.fileCard.create({ src: path, name: fileNameOf(src) });
    editor.view.dispatch(editor.state.tr.replaceWith(p, p + node.nodeSize, card));
  };
  let body;
  if (upload) body = <UploadCard editor={editor} upload={upload} accept={VIDEO_ACCEPT} />;
  else if (!src && editable)
    body = (
      <div className="dk-emb-state">
        <strong>No video yet</strong>
        <div className="dk-emb-actions">
          <button type="button" className="dk-btn-primary" onClick={replace}>
            Choose a video
          </button>
        </div>
      </div>
    );
  else if (provider !== 'file') {
    const embed = videoEmbedOf(src);
    body = embed ? (
      <ProviderPlayer
        embed={embed}
        poster={str(attrs.poster) || (embed.provider === 'youtube' ? youtubePoster(embed.id) : undefined)}
        title={str(attrs.title)}
      />
    ) : (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {src}
      </a>
    );
  } else
    body = (
      <VideoPlayer
        src={src}
        poster={str(attrs.poster) || undefined}
        title={str(attrs.title) || str(attrs.caption)}
        loop={!!attrs.loop}
        muted={!!attrs.muted}
        onReplace={editable ? replace : undefined}
        onAttachAsFile={editable ? asFile : undefined}
        onChooseAnother={editable ? replace : undefined}
      />
    );
  return (
    <NodeViewWrapper
      className={`dk-vid-block${selected ? ' dk-emb-selected' : ''}`}
      style={{ width: `${widthPct}%` }}
      contentEditable={false}
      data-testid="video-block"
    >
      <div ref={wrap} data-drag-handle="">
        {selected && editable && !upload && (
          <EmbedToolbar label="Video">
            {SNAP_STEPS.map((s) => (
              <ToolBtn
                key={s}
                label={`Width ${s}%`}
                wide
                on={widthPct === s}
                onClick={() => updateAttributes({ widthPct: s })}
              >
                {s}%
              </ToolBtn>
            ))}
            <Sep />
            <ToolBtn label="Properties" wide onClick={() => setProps(wrap.current?.getBoundingClientRect() ?? null)} />
            <ToolBtn label="Replace" wide onClick={replace} />
            <ToolBtn label="Delete" wide danger onClick={deleteNode} />
          </EmbedToolbar>
        )}
        <figure className="dk-vid-fig">
          {body}
          <VideoCaption title={str(attrs.caption) || undefined} description={str(attrs.description) || undefined} />
        </figure>
      </div>
      {props !== false && (
        <VideoProps
          attrs={attrs}
          update={updateAttributes}
          anchor={props}
          onClose={() => setProps(false)}
          projectId={kit?.projectId ?? null}
        />
      )}
    </NodeViewWrapper>
  );
}

/** "PDF · 1.2 MB". */
function fileMeta(name: string, size: unknown): string {
  const label = getFileTypeMeta(name).label;
  return typeof size === 'number' ? `${label} · ${formatBytes(size)}` : label;
}

/**
 * The file card node view.
 */
export function FileCardView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  useSyncExternalStore(subscribeDocUploads, docUploadsVersion);
  const toast = useToast();
  const viewer = usePreview();
  const layout = useBlockLayout();
  const attrs = node.attrs as Record<string, unknown>;
  const src = str(attrs.src);
  const name = str(attrs.name) || fileNameOf(src);
  const upload = docUploadFor(src);
  const editable = editor.isEditable;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  if (upload)
    return (
      <NodeViewWrapper className="dk-fc-block" contentEditable={false} data-testid="file-block">
        <UploadCard editor={editor} upload={upload} />
      </NodeViewWrapper>
    );
  const path = uploadPath(src) ?? src;
  const download = path.startsWith('/uploads/') ? uploadUrl(path, name, true) : src;
  const preview = !!attrs.preview;
  const showPreview = preview && (open ?? layout !== 'phone');
  const commitRename = () => {
    if (renaming == null) return;
    const v = renaming.trim();
    if (v && v !== name) updateAttributes({ name: v });
    setRenaming(null);
  };
  const items: [string, () => void, boolean?][] = [
    [
      'Open in viewer',
      () => viewer.open([itemFromUpload(path, name, typeof attrs.size === 'number' ? attrs.size : undefined)], 0),
    ],
    [
      'Download',
      () => {
        const a = document.createElement('a');
        a.href = download;
        a.download = name;
        a.rel = 'noopener';
        a.click();
      },
    ],
    ...(editable
      ? ([
          [preview ? 'Show as card' : 'Show as preview', () => updateAttributes({ preview: !preview })],
          ['Rename', () => setRenaming(name)],
          ['Replace file', () => pick.current?.click()],
        ] as [string, () => void][])
      : []),
    [
      'Copy link',
      () =>
        void navigator.clipboard
          ?.writeText(download)
          .then(() => toast.success('Link copied'))
          .catch(() => toast.error('Could not copy the link', download)),
    ],
    ...(editable ? ([['Delete', deleteNode, true]] as [string, () => void, boolean][]) : []),
  ];
  return (
    <NodeViewWrapper
      className={`dk-fc-block${selected ? ' dk-emb-selected' : ''}`}
      contentEditable={false}
      data-testid="file-block"
    >
      <div className="dk-fc" data-drag-handle="">
        <div className="dk-fc-row">
          <FileBadge name={name} />
          <span className="dk-fc-text">
            {renaming != null ? (
              <input
                className="dk-bp-input dk-fc-rename"
                aria-label="File name"
                autoFocus
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <strong className="dk-fc-name">{name}</strong>
            )}
            <span className="dk-fc-meta">{fileMeta(name, attrs.size)}</span>
          </span>
          <span className="dk-fc-actions">
            {preview && (
              <button type="button" className="dk-btn-ghost" onClick={() => setOpen(!showPreview)}>
                {showPreview ? 'Collapse preview' : 'Preview'}
              </button>
            )}
            <a className="dk-btn-ghost" href={download} download={name}>
              Download
            </a>
            <span className="dk-fc-more">
              <button
                type="button"
                className="dk-btb"
                aria-label="More"
                aria-haspopup="menu"
                aria-expanded={menu}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setMenu((m) => !m)}
              >
                <Icon name="more" size={15} />
              </button>
              {menu && (
                <div className="dk-menu dk-btb-more" role="menu" aria-label={name} onMouseLeave={() => setMenu(false)}>
                  {items.map(([label, fn, danger]) => (
                    <button
                      key={label}
                      type="button"
                      role="menuitem"
                      className="dk-mi"
                      style={danger ? { color: '#C4432A' } : undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setMenu(false);
                        fn();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </span>
          </span>
        </div>
        {showPreview && src && (
          <FilePreview src={path} name={name} size={typeof attrs.size === 'number' ? attrs.size : undefined} />
        )}
        <input
          ref={pick}
          type="file"
          hidden
          aria-label="Replace the file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            const p = posOf(getPos);
            if (f && p != null) startDocUpload(editor, f, { kind: 'file', replacePos: p });
          }}
        />
      </div>
    </NodeViewWrapper>
  );
}
