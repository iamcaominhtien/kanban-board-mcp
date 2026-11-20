/**
 * Video and file blocks while editing (design "Embeds", sections B and E). A video shows its poster (or first frame),
 * Play and the player's bar (it never starts by itself) and its caption; when selected, a toolbar over it (width,
 * poster, caption, Replace, More), handles to resize it and its size; the properties panel sets the poster (a frame of
 * the video or an image), loop, muted, the caption and the description. An upload shows its progress over the
 * video's place. A file card shows the
 * file's type, name and size with Download and More (Open in viewer, Show as preview / card, Rename, Replace file,
 * Copy link, Delete); its preview shows inline. Both show their upload's progress and refusals.
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { uploadUrl } from '../../../../api/tickets';
import { getFileTypeMeta } from '../../../../utils/fileIcons';
import { itemFromUpload, usePreview } from '../../../preview/PreviewContext';
import { useToast } from '../../../Toast';
import { uploadDocsFile, uploadPath } from '../../embeds/embedApi';
import { FilePreview } from '../../embeds/FileBlock';
import { ProviderPlayer, VideoCaption, VideoPlayer, formatDuration, type VideoMeta } from '../../embeds/VideoBlock';
import { VIDEO_ACCEPT, fileNameOf, videoEmbedOf, youtubePoster } from '../../embeds/videoEmbed';
import { EmbIcon, type EmbIconName } from '../../embeds/embIcons';
import { askBlockUi, blockKitOf } from './bus';
import { SNAP_STEPS } from './commands';
import {
  cancelDocUpload,
  docUploadFor,
  docUploadsVersion,
  startDocUpload,
  subscribeDocUploads,
  timeLeft,
  type DocUpload,
} from './docUpload';
import { EmbedToolbar, FileBadge, Sep, ToolBtn, UploadCard } from './embedUi';
import { uploadedSrc } from './imageUpload';
import { Panel, Row, Seg, Toggle, formatBytes, useBlockLayout } from './ui';
import '../../embeds/embeds.css';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const posOf = (getPos: NodeViewProps['getPos']) => (typeof getPos === 'function' ? (getPos() ?? null) : null);

/** The size of a file in bytes, from the server's answer to a HEAD request; null when it does not say. */
async function remoteSize(src: string): Promise<number | null> {
  try {
    // the first byte only: its Content-Range ends in the size of the whole file
    const r = await fetch(src, { headers: { Range: 'bytes=0-0' } });
    const range = /\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
    void r.body?.cancel().catch(() => undefined);
    const n = range ? Number(range[1]) : r.status === 200 ? Number(r.headers.get('content-length')) : 0;
    return r.ok && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Draws the frame of a video at `time` (seconds) as a JPEG file: the poster picked from a frame.
 * @throws When the video cannot load or its picture may not be read (another site without CORS).
 */
function captureFrame(src: string, time: number, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = /^https?:/i.test(src) && !src.startsWith(window.location.origin) ? 'anonymous' : null;
    v.src = src;
    const fail = () => reject(new Error('frame'));
    v.onerror = fail;
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(Math.max(0, time), Math.max(0, v.duration - 0.05));
    };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d')?.drawImage(v, 0, 0);
        c.toBlob((b) => (b ? resolve(new File([b], name, { type: 'image/jpeg' })) : fail()), 'image/jpeg', 0.86);
      } catch {
        fail();
      }
    };
  });
}

/** The video properties panel (frame 15): the file, the poster (a frame or an image), playback, the caption and
 * the description. */
function VideoProps({
  attrs,
  update,
  anchor,
  onClose,
  projectId,
  meta,
  focusCaption,
}: {
  attrs: Record<string, unknown>;
  update: (a: Record<string, unknown>) => void;
  anchor: DOMRect | null;
  onClose: () => void;
  projectId: string | null;
  meta: VideoMeta | null;
  /** Opened from the toolbar's Caption: the caption field takes the focus. */
  focusCaption?: boolean;
}) {
  const toast = useToast();
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const src = str(attrs.src);
  const poster = str(attrs.poster);
  const [mode, setMode] = useState<'frame' | 'image'>(poster && !/poster-frame/.test(poster) ? 'image' : 'frame');
  const [at, setAt] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void remoteSize(src).then((n) => live && setSize(n));
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
  }, [src]);
  const duration = meta?.duration && Number.isFinite(meta.duration) ? meta.duration : 0;
  const info = [
    size ? formatBytes(size) : null,
    duration ? formatDuration(duration) : null,
    meta?.width ? `${meta.width} x ${meta.height}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const savePoster = (file: File) => {
    if (!projectId) return;
    setBusy(true);
    uploadDocsFile(projectId, file, 'image')
      .then((res) => update({ poster: uploadedSrc(res.src) }))
      .catch(() => toast.error('Could not save the poster', 'PNG, JPG, GIF or WebP, up to 10 MB.'))
      .finally(() => setBusy(false));
  };
  // a frame is captured once the slider rests for a moment
  const pickFrame = (t: number) => {
    setAt(t);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const base = fileNameOf(src).replace(/\.[^.]+$/, '');
      captureFrame(src, t, `${base}-poster-frame.jpg`)
        .then(savePoster)
        .catch(() => toast.error('Could not take that frame', 'Choose an image for the poster instead.'));
    }, 450);
  };
  return (
    <Panel title="Video properties" anchor={anchor} onClose={onClose} testId="video-props">
      <div className="dk-vprops-file">
        {poster ? (
          <img className="dk-vid-poster-thumb" src={poster} alt="" />
        ) : (
          <video className="dk-vid-poster-thumb" src={`${src}#t=0.1`} preload="metadata" muted aria-hidden="true" />
        )}
        <span>
          <b>{/\.[a-z0-9]{2,4}$/i.test(str(attrs.title)) ? str(attrs.title) : fileNameOf(src)}</b>
          <br />
          <span data-testid="video-props-info">{info || provider(src)}</span>
        </span>
      </div>
      <Row label="Poster image" hint="The picture shown before play.">
        <Seg
          label="Poster image"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'frame', label: 'Frame' },
            { value: 'image', label: 'Image' },
          ]}
        />
        {mode === 'frame' ? (
          <div className="dk-vprops-frame">
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.floor(duration * 10) / 10)}
              step={0.1}
              value={Math.min(at, Math.max(1, duration))}
              disabled={!duration || busy || !projectId}
              aria-label="Poster frame"
              className="dk-vprops-range"
              style={{ '--pct': `${duration ? (Math.min(at, duration) / duration) * 100 : 0}%` } as CSSProperties}
              onChange={(e) => pickFrame(Number(e.target.value))}
            />
            <span className="dk-vprops-time">{busy ? '…' : formatDuration(Math.min(at, duration || at))}</span>
          </div>
        ) : (
          <div className="dk-bp-row-inline">
            <button
              type="button"
              className="st-btn st-btn-sm"
              disabled={busy || !projectId}
              onClick={() => pick.current?.click()}
            >
              {busy ? 'Uploading…' : poster ? 'Change image' : 'Choose image'}
            </button>
            {poster && (
              <button type="button" className="st-btn st-btn-sm" onClick={() => update({ poster: null })}>
                Remove poster
              </button>
            )}
          </div>
        )}
        <input
          ref={pick}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp"
          aria-label="Choose a poster image"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) savePoster(f);
          }}
        />
      </Row>
      <Row label="Playback" hint="Video never starts by itself, and sound is on when you press play.">
        <Toggle label="Loop" checked={!!attrs.loop} onChange={(v) => update({ loop: v })} />
        <Toggle label="Muted" checked={!!attrs.muted} onChange={(v) => update({ muted: v })} />
      </Row>
      <Row label="Caption">
        <input
          className="dk-bp-input"
          aria-label="Caption"
          autoFocus={focusCaption}
          value={str(attrs.caption)}
          onChange={(e) => update({ caption: e.target.value || null })}
        />
      </Row>
      <Row label="Description" hint="Read by screen readers.">
        <textarea
          className="dk-bp-input"
          aria-label="Description"
          rows={2}
          value={str(attrs.description)}
          onChange={(e) => update({ description: e.target.value || null })}
        />
      </Row>
      <div className="dk-emb-sz-done">
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onClose}>
          Done
        </button>
      </div>
    </Panel>
  );
}

/** "Video file · cdn.example.com" or "Video file" under the name in the properties panel, until the file is read. */
function provider(src: string): string {
  try {
    return /^https?:/i.test(src) && !src.startsWith(window.location.origin)
      ? `Video file · ${new URL(src).hostname}`
      : 'Video file';
  } catch {
    return 'Video file';
  }
}

/**
 * A video on its way to the server (frame 16): the video's dark place with a white card over its foot (the name,
 * "38 % · 24 of 63 MB", a bar, the time left and Cancel).
 */
function VideoUploading({ editor, upload }: { editor: NodeViewProps['editor']; upload: DocUpload }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const size = upload.file.size;
  const pct = size ? Math.min(100, Math.round((upload.loaded / size) * 100)) : 0;
  return (
    <div className="dk-vid-up" data-testid="video-uploading">
      <div className="dk-vid-up-card">
        <div className="dk-vid-up-head">
          <span className="dk-vid-up-name">{upload.file.name}</span>
          <span className="dk-vid-up-pct">
            {pct} % · {formatBytes(upload.loaded)} of {formatBytes(size)}
          </span>
        </div>
        <div className="dk-vid-up-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="dk-vid-up-foot">
          <span>{timeLeft(upload) ?? 'Starting…'}</span>
          <button type="button" className="st-btn st-btn-sm" onClick={() => cancelDocUpload(editor, upload.id)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The 8 handles round a selected video (frame 12): corners and the middle of each side. */
const HANDLES = [
  [0, 0],
  [50, 0],
  [100, 0],
  [0, 50],
  [100, 50],
  [0, 100],
  [50, 100],
  [100, 100],
] as const;

/**
 * The video node view.
 */
export function VideoView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  useSyncExternalStore(subscribeDocUploads, docUploadsVersion);
  const attrs = node.attrs as Record<string, unknown>;
  const src = str(attrs.src);
  const upload = docUploadFor(src);
  const provider = str(attrs.provider) || 'file';
  const storedPct = typeof attrs.widthPct === 'number' ? attrs.widthPct : 100;
  const [dragPct, setDragPct] = useState<number | null>(null);
  const widthPct = dragPct ?? storedPct;
  const editable = editor.isEditable;
  const [props, setProps] = useState<{ anchor: DOMRect | null; caption?: boolean } | false>(false);
  const [more, setMore] = useState(false);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [px, setPx] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
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
  const openProps = (caption?: boolean) => {
    setMore(false);
    setProps({ anchor: wrap.current?.getBoundingClientRect() ?? null, caption });
  };
  const showFrame = selected && editable && !upload && !!src;
  useLayoutEffect(() => {
    if (showFrame) setPx(Math.round(stage.current?.getBoundingClientRect().width ?? 0));
  }, [showFrame, widthPct]);
  // a handle drags the width (the video is centred, so the width is twice the distance from the middle), snapped to
  // 25, 50, 75 or 100 % of the column
  const startResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const host = (wrap.current?.closest('.dk-vid-block')?.parentElement ?? null) as HTMLElement | null;
    const box = stage.current?.getBoundingClientRect();
    if (!host || !box) return;
    e.preventDefault();
    e.stopPropagation();
    const col = host.getBoundingClientRect().width;
    const mid = box.left + box.width / 2;
    let last = storedPct;
    const move = (ev: PointerEvent) => {
      const pct = ((2 * Math.abs(ev.clientX - mid)) / col) * 100;
      last = SNAP_STEPS.reduce((b, s) => (Math.abs(s - pct) < Math.abs(b - pct) ? s : b), SNAP_STEPS[0]);
      setDragPct(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragPct(null);
      if (last !== storedPct) updateAttributes({ widthPct: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  let body;
  if (upload)
    body =
      upload.status === 'uploading' ? (
        <VideoUploading editor={editor} upload={upload} />
      ) : (
        <UploadCard editor={editor} upload={upload} accept={VIDEO_ACCEPT} />
      );
  else if (!src && editable)
    body = (
      <div className="dk-emb-state">
        <strong>No video yet</strong>
        <div className="dk-emb-actions">
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={replace}>
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
        description={str(attrs.description) || undefined}
        onMeta={setMeta}
        onReplace={editable ? replace : undefined}
        onAttachAsFile={editable ? asFile : undefined}
        onChooseAnother={editable ? replace : undefined}
      />
    );
  const ratio = meta?.width && meta.height ? meta.height / meta.width : 1 / 1.78;
  return (
    <NodeViewWrapper
      className={`dk-vid-block${selected ? ' dk-emb-selected' : ''}`}
      style={{ width: `${widthPct}%` }}
      contentEditable={false}
      data-testid="video-block"
    >
      <div ref={wrap} data-drag-handle="" className="dk-vid-wrap">
        {showFrame && (
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
            <ToolBtn label="Poster image" onClick={() => openProps()}>
              <EmbIcon name="image" size={15} />
            </ToolBtn>
            <ToolBtn label="Caption" on={!!str(attrs.caption)} onClick={() => openProps(true)}>
              <EmbIcon name="caption" size={15} />
            </ToolBtn>
            <ToolBtn label="Replace" onClick={replace}>
              <EmbIcon name="swap" size={15} />
            </ToolBtn>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <ToolBtn label="More" on={more} onClick={() => setMore((m) => !m)}>
                <EmbIcon name="more" size={15} />
              </ToolBtn>
              {more && (
                <div className="dk-menu dk-btb-more" role="menu" onMouseLeave={() => setMore(false)}>
                  {(
                    [
                      ['Properties', () => openProps()],
                      ['Keep as a file', asFile],
                      ['Delete', deleteNode],
                    ] as [string, () => void][]
                  ).map(([label, fn]) => (
                    <div
                      key={label}
                      role="menuitem"
                      className="dk-mi"
                      style={label === 'Delete' ? { color: '#C4432A' } : undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setMore(false);
                        fn();
                      }}
                    >
                      {label}
                    </div>
                  ))}
                </div>
              )}
            </span>
          </EmbedToolbar>
        )}
        <figure className="dk-vid-fig">
          <div ref={stage} className={`dk-vid-stage${showFrame ? ' dk-vid-stage-on' : ''}`}>
            {body}
            {showFrame && (
              <>
                <span className="dk-vid-size" data-testid="video-size">
                  {widthPct} % · {px} x {Math.round(px * ratio)}
                </span>
                {HANDLES.map(([x, y]) => (
                  <span
                    key={`${x}-${y}`}
                    className="dk-vid-handle"
                    style={{ left: `${x}%`, top: `${y}%`, cursor: x === 50 ? 'ns-resize' : 'ew-resize' }}
                    aria-hidden="true"
                    onPointerDown={x === 50 ? undefined : startResize}
                  />
                ))}
              </>
            )}
          </div>
          <VideoCaption title={str(attrs.caption) || undefined} description={str(attrs.description) || undefined} />
        </figure>
      </div>
      {props !== false && (
        <VideoProps
          attrs={attrs}
          update={updateAttributes}
          anchor={props.anchor}
          onClose={() => setProps(false)}
          projectId={kit?.projectId ?? null}
          meta={meta}
          focusCaption={props.caption}
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
  const items: [string, () => void, boolean, EmbIconName][] = [
    [
      'Open in viewer',
      () => viewer.open([itemFromUpload(path, name, typeof attrs.size === 'number' ? attrs.size : undefined)], 0),
      false,
      'eye',
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
      false,
      'download',
    ],
    ...(editable
      ? ([
          [preview ? 'Show as card' : 'Show as preview', () => updateAttributes({ preview: !preview }), false, 'eye'],
          ['Rename', () => setRenaming(name), false, 'pen'],
          ['Replace file', () => pick.current?.click(), false, 'swap'],
        ] as [string, () => void, boolean, EmbIconName][])
      : []),
    [
      'Copy link',
      () =>
        void navigator.clipboard
          ?.writeText(download)
          .then(() => toast.success('Link copied'))
          .catch(() => toast.error('Could not copy the link', download)),
      false,
      'link',
    ],
    ...(editable ? ([['Delete', deleteNode, true, 'trash']] as [string, () => void, boolean, EmbIconName][]) : []),
  ];
  const more = (
    <span className="dk-fc-more">
      <button
        type="button"
        className="dk-fc-ib"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menu}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setMenu((m) => !m)}
      >
        <EmbIcon name="more" size={16} />
      </button>
      {menu && (
        <div className="dk-fc-menu" role="menu" aria-label={name} onMouseLeave={() => setMenu(false)}>
          <div className="dk-fc-menu-head">{name}</div>
          {items.map(([label, fn, danger, icon]) => (
            <Fragment key={label}>
              {(label === 'Show as card' || label === 'Show as preview' || danger) && (
                <div className="dk-fc-menu-sep" />
              )}
              <button
                type="button"
                role="menuitem"
                className={danger ? 'dk-fc-menu-danger' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setMenu(false);
                  fn();
                }}
              >
                <span className="dk-fc-menu-ic">
                  <EmbIcon name={icon} size={15} />
                </span>
                {label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </span>
  );
  return (
    <NodeViewWrapper
      className={`dk-fc-block${selected ? ' dk-emb-selected' : ''}`}
      contentEditable={false}
      data-testid="file-block"
    >
      <div className={`dk-fc${showPreview ? ' dk-fc-open' : ''}`} data-drag-handle="">
        <div className="dk-fc-row">
          <FileBadge name={name} />
          <span className="dk-fc-text">
            {renaming != null ? (
              <input
                className="dk-fc-rename"
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
          {!showPreview && (
            <span className="dk-fc-actions">
              {preview && (
                <button type="button" className="st-btn st-btn-sm" onClick={() => setOpen(true)}>
                  Preview
                </button>
              )}
              <a className="st-btn st-btn-sm" href={download} download={name}>
                <EmbIcon name="download" size={12} sw={2.2} />
                Download
              </a>
              {more}
            </span>
          )}
          {showPreview && <span className="dk-fc-actions">{more}</span>}
        </div>
        {showPreview && src && (
          <FilePreview
            src={path}
            name={name}
            size={typeof attrs.size === 'number' ? attrs.size : undefined}
            onCollapse={() => setOpen(false)}
          />
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
