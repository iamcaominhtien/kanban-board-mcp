/**
 * The image on the page while editing (boards A–E): placed as the reader places it (block, left, centre, right, float
 * left, float right, width in %), with its crop, border, corners and shadow; when selected, the toolbar above it (a
 * scrolling strip at the bottom on a phone), corner handles that resize it and snap to 25 / 50 / 75 / 100 %, and for
 * a float the wrap distance as a green band. Also its other states: uploading (with Cancel), failed (kept in this
 * browser), too large, not found (the alt text stays) and loading (a placeholder of the right shape).
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../Icon';
import { askBlockUi, type ImageTab } from './bus';
import { SNAP_STEPS, snapWidth, type Crop, type Placement } from './commands';
import {
  cancelUpload,
  replaceUploadFile,
  retryUpload,
  shrinkAndUpload,
  subscribeUploads,
  uploadFor,
  uploadsVersion,
} from './imageUpload';
import { formatBytes, useBlockLayout } from './ui';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The class and style of the element that holds an image node, from its attributes (as RichDocView places it). */
export function imageOuterAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const placement = str(attrs.placement) || 'block';
  const widthPct = num(attrs.widthPct);
  const gap = num(attrs.wrapGap) ?? 16;
  const style: string[] = [];
  const px = num(attrs.width);
  if (widthPct) style.push(`width:${widthPct}%`);
  // a width in px from `![alt|640](src)` when no % is set, as the reader draws it
  else if (px) style.push(`width:${px}px`, 'max-width:100%');
  if (placement === 'floatLeft') style.push(`margin-right:${gap}px`);
  if (placement === 'floatRight') style.push(`margin-left:${gap}px`);
  return {
    class: `react-renderer node-image dk-img dk-img-${placement}`,
    style: style.join(';'),
    ...(typeof attrs.blockId === 'string' ? { 'data-block-id': attrs.blockId } : {}),
  };
}

/** The style a picture's border, corners and shadow give it. */
export function imageLook(attrs: Record<string, unknown>): CSSProperties {
  const radius = num(attrs.radius) ?? 0;
  const border = str(attrs.border);
  return {
    ...(radius ? { borderRadius: radius >= 999 ? '50%' : radius } : {}),
    ...(border ? { border: `${border === 'thick' ? 3 : 1}px solid #D3DBD6` } : {}),
    ...(attrs.shadow ? { boxShadow: '0 6px 18px rgba(30,42,34,0.16)' } : {}),
  };
}

/** A small drawing of a placement for the toolbar: text lines and the picture where it sits. */
export function PlacementGlyph({ p }: { p: Placement }) {
  const box =
    p === 'floatLeft'
      ? { x: 1, w: 8 }
      : p === 'floatRight'
        ? { x: 13, w: 8 }
        : p === 'center'
          ? { x: 6, w: 10 }
          : p === 'right'
            ? { x: 11, w: 10 }
            : { x: 1, w: 10 };
  const float = p === 'floatLeft' || p === 'floatRight';
  return (
    <svg
      width="22"
      height="16"
      viewBox="0 0 22 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect
        x={box.x}
        y={float ? 3 : 4}
        width={box.w}
        height={float ? 8 : 8}
        rx="1.5"
        fill="currentColor"
        fillOpacity="0.18"
      />
      {float ? (
        <>
          <path
            d={p === 'floatLeft' ? 'M11 4h10M11 7.5h10M11 11h10M1 14.5h20' : 'M1 4h10M1 7.5h10M1 11h10M1 14.5h20'}
          />
        </>
      ) : (
        <path d="M1 1h20M1 15h20" />
      )}
    </svg>
  );
}

const FAMILY_BLOCK: Placement[] = ['block', 'left', 'center', 'right'];

/** One toolbar button. */
function TbBtn({
  label,
  on,
  onClick,
  children,
  wide,
}: {
  label: string;
  on?: boolean;
  onClick: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      className={`dk-btb${on ? ' on' : ''}${wide ? ' wide' : ''}`}
      aria-label={label}
      aria-pressed={on}
      title={label}
      data-tip={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The image toolbar (board B 5): place, width, caption, alt text, crop, link, replace, more. */
function ImageToolbar({
  attrs,
  set,
  open,
  onCaption,
  onReplace,
  onDelete,
  src,
}: {
  attrs: Record<string, unknown>;
  set: (a: Record<string, unknown>) => void;
  open: (tab: ImageTab | 'crop') => void;
  onCaption: () => void;
  onReplace: () => void;
  onDelete: () => void;
  src: string;
}) {
  const placement = (str(attrs.placement) || 'block') as Placement;
  const width = num(attrs.widthPct);
  const [more, setMore] = useState(false);
  const inBlock = FAMILY_BLOCK.includes(placement);
  return (
    <div
      className="dk-btoolbar dk-img-toolbar"
      role="toolbar"
      aria-label="Image"
      data-block-ui=""
      contentEditable={false}
    >
      <TbBtn label="Block" on={inBlock} onClick={() => set({ placement: inBlock ? placement : 'block' })}>
        <PlacementGlyph p="block" />
      </TbBtn>
      <TbBtn
        label="Float left"
        on={placement === 'floatLeft'}
        onClick={() => set({ placement: 'floatLeft', widthPct: width ?? 40 })}
      >
        <PlacementGlyph p="floatLeft" />
      </TbBtn>
      <TbBtn
        label="Float right"
        on={placement === 'floatRight'}
        onClick={() => set({ placement: 'floatRight', widthPct: width ?? 40 })}
      >
        <PlacementGlyph p="floatRight" />
      </TbBtn>
      {inBlock && (
        <>
          <span className="dk-btb-sep" />
          <TbBtn
            label="Left"
            on={placement === 'left' || placement === 'block'}
            onClick={() => set({ placement: 'left' })}
          >
            <PlacementGlyph p="left" />
          </TbBtn>
          <TbBtn label="Centre" on={placement === 'center'} onClick={() => set({ placement: 'center' })}>
            <PlacementGlyph p="center" />
          </TbBtn>
          <TbBtn label="Right" on={placement === 'right'} onClick={() => set({ placement: 'right' })}>
            <PlacementGlyph p="right" />
          </TbBtn>
        </>
      )}
      <span className="dk-btb-sep" />
      {SNAP_STEPS.map((s) => (
        <TbBtn key={s} label={`Width ${s}%`} on={width === s} wide onClick={() => set({ widthPct: s, width: null })}>
          {s}%
        </TbBtn>
      ))}
      <span className="dk-btb-sep" />
      <TbBtn label="Caption" on={attrs.caption !== null && attrs.caption !== undefined} onClick={onCaption}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="11" rx="2" />
          <path d="M6 19h12" />
        </svg>
      </TbBtn>
      <TbBtn label="Alt text" on={!!str(attrs.alt)} wide onClick={() => open('text')}>
        ALT
      </TbBtn>
      <TbBtn label="Crop" onClick={() => open('crop')}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />
        </svg>
      </TbBtn>
      <TbBtn label="Link" on={!!str(attrs.href)} onClick={() => open('text')}>
        <Icon name="link" size={15} />
      </TbBtn>
      <TbBtn label="Replace" wide onClick={onReplace}>
        Replace
      </TbBtn>
      <span style={{ position: 'relative' }}>
        <TbBtn label="More" on={more} onClick={() => setMore((m) => !m)}>
          <Icon name="more" size={15} />
        </TbBtn>
        {more && (
          <div className="dk-menu dk-btb-more" role="menu" onMouseLeave={() => setMore(false)}>
            {(
              [
                ['Properties', () => open('layout')],
                ['Border and shadow', () => open('style')],
                [
                  'Copy image',
                  () =>
                    void (async () => {
                      try {
                        const blob = await (await fetch(src)).blob();
                        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
                      } catch {
                        await navigator.clipboard?.writeText(src).catch(() => undefined);
                      }
                    })(),
                ],
                [
                  'Download',
                  () => {
                    const a = document.createElement('a');
                    a.href = src;
                    a.download = '';
                    a.rel = 'noopener';
                    a.click();
                  },
                ],
                ['Delete', onDelete],
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
    </div>
  );
}

/** The phone's action strip for a selected image (board B 9): 62 × 54 px buttons that scroll. */
function ImageStrip({
  open,
  onCaption,
  onReplace,
}: {
  open: (tab: ImageTab | 'crop') => void;
  onCaption: () => void;
  onReplace: () => void;
}) {
  // the board's 20 px icons (Blocks board, frame 9)
  const items: [string, ReactNode, () => void][] = [
    [
      'Position',
      <>
        <rect height="7" rx="1" width="7" x="13" y="5" />
        <path d="M4 6h6M4 10h6M4 15h16M4 19h12" />
      </>,
      () => open('layout'),
    ],
    ['Size', <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />, () => open('layout')],
    ['Crop', <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />, () => open('crop')],
    [
      'Caption',
      <>
        <rect height="9" rx="1.5" width="16" x="4" y="3" />
        <path d="M4 16h16M4 20h10" />
      </>,
      onCaption,
    ],
    ['Alt text', <path d="M3 18l4-12 4 12M4.5 14h5M14 8h7M14 12h7M14 16h4" />, () => open('text')],
    [
      'Link',
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
      () => open('text'),
    ],
    ['Replace', <path d="M4 8h14l-3-3M20 16H6l3 3" />, onReplace],
  ];
  return createPortal(
    <div className="dk-img-strip" role="toolbar" aria-label="Image" data-block-ui="">
      <div className="dk-img-strip-row">
        {items.map(([label, icon, fn]) => (
          <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={fn}>
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {icon}
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** A state card in the place of a picture (failed, too large, not found). */
function StateCard({
  title,
  children,
  actions,
  tone,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  tone: 'warn' | 'error' | 'muted';
}) {
  return (
    <div className={`dk-imgv-card dk-imgv-card-${tone}`} contentEditable={false} role="status">
      <div className="dk-imgv-card-title">{title}</div>
      <div className="dk-imgv-card-text">{children}</div>
      <div className="dk-imgv-card-actions">{actions}</div>
    </div>
  );
}

/** The picture with its crop: a frame of the crop's shape, the picture moved and scaled inside it. */
function Cropped({
  src,
  alt,
  crop,
  look,
  onLoad,
  onError,
  loaded,
  ratio,
}: {
  src: string;
  alt: string;
  crop: Crop | null;
  look: CSSProperties;
  onLoad: (img: HTMLImageElement) => void;
  onError: () => void;
  loaded: { w: number; h: number } | null;
  ratio: string;
}) {
  if (!loaded) {
    // loading: a placeholder of the picture's shape; the image loads out of sight
    return (
      <div className="dk-imgv-ph" style={{ aspectRatio: ratio, ...look }} aria-label="Loading image">
        <img
          src={src}
          alt=""
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
          onLoad={(e) => onLoad(e.currentTarget)}
          onError={onError}
        />
      </div>
    );
  }
  if (!crop) return <img src={src} alt={alt} style={{ ...look, width: '100%' }} draggable={false} onError={onError} />;
  return (
    <div className="dk-imgv-crop" style={{ aspectRatio: `${crop.w * loaded.w} / ${crop.h * loaded.h}`, ...look }}>
      <img
        src={src}
        alt={alt}
        draggable={false}
        onError={onError}
        style={{
          position: 'absolute',
          maxWidth: 'none',
          width: `${100 / crop.w}%`,
          left: `${(-crop.x / crop.w) * 100}%`,
          top: `${(-crop.y / crop.h) * 100}%`,
          margin: 0,
          borderRadius: 0,
        }}
      />
    </div>
  );
}

/**
 * The image node view.
 */
export function ImageView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as Record<string, unknown>;
  const src = str(attrs.src);
  useSyncExternalStore(subscribeUploads, uploadsVersion);
  const pendingUp = uploadFor(src);
  const layout = useBlockLayout();
  const editable = editor.isEditable;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const [resize, setResize] = useState<{ pct: number } | null>(null);
  const [captionFocus, setCaptionFocus] = useState(false);
  const captionRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoaded(null);
    setMissing(false);
  }, [src]);

  const pos = () => (typeof getPos === 'function' ? getPos() : undefined);
  const open = (tab: ImageTab | 'crop') => {
    const p = pos();
    if (p == null) return;
    askBlockUi(editor, tab === 'crop' ? { type: 'crop', pos: p } : { type: 'imageProps', pos: p, tab });
  };
  const replace = () => {
    const p = pos();
    if (p != null) askBlockUi(editor, { type: 'insertImage', replacePos: p });
  };
  const showCaption = () => {
    if (attrs.caption === null || attrs.caption === undefined) updateAttributes({ caption: '' });
    window.setTimeout(() => captionRef.current?.focus(), 0);
  };

  const placement = (str(attrs.placement) || 'block') as Placement;
  const float = placement === 'floatLeft' || placement === 'floatRight';
  const crop = (attrs.crop as Crop | null) ?? null;
  const look = imageLook(attrs);
  const w = num(attrs.width);
  const h = num(attrs.height);
  const ratio = w && h ? `${w} / ${h}` : '16 / 9';

  // corner handles: the width follows the pointer, in % of the text column, snapping near 25 / 50 / 75 / 100
  const startResize = (corner: 'l' | 'r') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const outer = wrapRef.current?.parentElement;
    const column = editor.view.dom as HTMLElement;
    if (!outer) return;
    const startX = e.clientX;
    const startW = outer.getBoundingClientRect().width;
    const colW = column.clientWidth || startW;
    const factor = placement === 'center' ? 2 : 1;
    let pct = (startW / colW) * 100;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (corner === 'r' ? 1 : -1) * factor;
      pct = snapWidth(((startW + dx) / colW) * 100);
      outer.style.width = `${pct}%`;
      setResize({ pct });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResize(null);
      updateAttributes({ widthPct: pct, width: null });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  let body: ReactNode;
  if (pendingUp) {
    const name = pendingUp.file.name;
    if (pendingUp.status === 'tooLarge') {
      body = (
        <StateCard
          tone="warn"
          title="Too large"
          actions={
            <>
              <button
                type="button"
                className="dk-btn-primary"
                onClick={() => void shrinkAndUpload(editor, pendingUp.id)}
              >
                Shrink and insert
              </button>
              <button type="button" className="dk-btn-ghost" onClick={() => chooseRef.current?.click()}>
                Choose another
              </button>
              <input
                ref={chooseRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) replaceUploadFile(editor, pendingUp.id, f);
                }}
              />
            </>
          }
        >
          {name} is {formatBytes(pendingUp.file.size)}. An image can be {pendingUp.limitMb} MB at most.
        </StateCard>
      );
    } else if (pendingUp.status === 'waiting') {
      body = (
        <div className="dk-imgv-failed" data-testid="image-waiting">
          <img src={pendingUp.preview} alt="" style={{ ...look, width: '100%' }} />
          <StateCard
            tone="muted"
            title={`${name} waits for the connection`}
            actions={
              <button type="button" className="dk-btn-ghost" onClick={() => cancelUpload(editor, pendingUp.id)}>
                Remove
              </button>
            }
          >
            It uploads when you are back online. {formatBytes(pendingUp.file.size)}
          </StateCard>
        </div>
      );
    } else if (pendingUp.status === 'failed') {
      body = (
        <div className="dk-imgv-failed">
          <img src={pendingUp.preview} alt="" style={{ ...look, width: '100%' }} />
          <StateCard
            tone="error"
            title="Upload failed"
            actions={
              <>
                <button type="button" className="dk-btn-primary" onClick={() => retryUpload(editor, pendingUp.id)}>
                  Try again
                </button>
                <button type="button" className="dk-btn-ghost" onClick={() => cancelUpload(editor, pendingUp.id)}>
                  Remove
                </button>
              </>
            }
          >
            {name} did not reach the server. It is kept in this browser.
          </StateCard>
        </div>
      );
    } else {
      const pct = Math.round((pendingUp.loaded / Math.max(1, pendingUp.file.size)) * 100);
      body = (
        <div className="dk-imgv-uploading" role="status" aria-label={`Uploading ${name}`}>
          <img src={pendingUp.preview} alt="" style={{ ...look, width: '100%' }} />
          <div className="dk-imgv-progress" contentEditable={false}>
            <div className="dk-imgv-progress-row">
              <span className="dk-imgv-progress-name">{name}</span>
              <span>
                {pct} % · {formatBytes(pendingUp.loaded)} of {formatBytes(pendingUp.file.size)}
              </span>
              <button type="button" className="dk-btn-ghost" onClick={() => cancelUpload(editor, pendingUp.id)}>
                Cancel
              </button>
            </div>
            <div className="dk-imgv-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      );
    }
  } else if (!src || src.startsWith('uploading:') || missing) {
    // Blocks board, D 21: a 190 px dashed box, everything centred, the alt text on its own line
    body = (
      <div className="dk-imgv-missing" contentEditable={false} role="status" data-testid="image-missing">
        <svg
          aria-hidden="true"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#5B6B60"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect height="16" rx="2" width="18" x="3" y="4" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M3 17l5-4 4 3 3-2 6 4" />
        </svg>
        <div className="dk-imgv-missing-title">Image not found</div>
        <div className="dk-imgv-missing-text">
          It was deleted, or you do not have access.
          {str(attrs.alt) && (
            <>
              <br />
              <span className="dk-imgv-alttext">Alt text: “{str(attrs.alt)}”</span>
            </>
          )}
        </div>
        {editable && (
          <div className="dk-imgv-missing-actions">
            <button type="button" className="dk-btn-ghost" onClick={replace}>
              Replace
            </button>
            <button type="button" className="dk-btn-ghost" onClick={() => deleteNode()}>
              Remove
            </button>
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <Cropped
        src={src}
        alt={str(attrs.alt)}
        crop={crop}
        look={look}
        loaded={loaded}
        ratio={ratio}
        onLoad={(img) => setLoaded({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 })}
        onError={() => setMissing(true)}
      />
    );
  }

  const outerW = wrapRef.current?.getBoundingClientRect().width ?? 0;
  const pxW = Math.round(outerW);
  const pxH = loaded
    ? Math.round((pxW * (crop ? crop.h * loaded.h : loaded.h)) / (crop ? crop.w * loaded.w : loaded.w))
    : null;
  const caption = attrs.caption;
  const showTools = selected && editable && !pendingUp;

  return (
    <NodeViewWrapper
      ref={wrapRef}
      className={`dk-imgv${selected ? ' is-selected' : ''}`}
      data-testid="docs-image"
      data-placement={placement}
      onClick={() => {
        // a second tap on a selected image opens its sheet on a phone
        if (layout === 'phone' && selected && editable) open('layout');
      }}
    >
      {showTools && layout !== 'phone' && (
        <ImageToolbar
          attrs={attrs}
          set={updateAttributes}
          open={open}
          onCaption={showCaption}
          onReplace={replace}
          onDelete={() => deleteNode()}
          src={src}
        />
      )}
      {showTools && layout === 'phone' && <ImageStrip open={open} onCaption={showCaption} onReplace={replace} />}
      <div className="dk-imgv-frame" data-drag-handle="">
        {attrs.href && !selected ? <span className="dk-imgv-linked" title={str(attrs.href)} /> : null}
        {body}
        {str(attrs.alt) && !pendingUp && !missing && selected && <span className="dk-imgv-altbadge">ALT</span>}
        {showTools && float && (
          <span
            className={`dk-imgv-wrap dk-imgv-wrap-${placement === 'floatLeft' ? 'r' : 'l'}`}
            style={{ width: num(attrs.wrapGap) ?? 16 }}
            contentEditable={false}
          >
            <span>{num(attrs.wrapGap) ?? 16} px</span>
          </span>
        )}
        {showTools &&
          (['nw', 'ne', 'sw', 'se'] as const).map((c) => (
            <span
              key={c}
              className={`dk-imgv-handle dk-imgv-handle-${c}`}
              aria-label="Resize"
              role="separator"
              contentEditable={false}
              onPointerDown={startResize(c.endsWith('e') ? 'r' : 'l')}
            />
          ))}
        {showTools && (resize || selected) && (
          <span className="dk-imgv-size" contentEditable={false}>
            {Math.round(resize?.pct ?? num(attrs.widthPct) ?? 100)} %{pxH ? ` · ${pxW} × ${pxH} px` : ''}
          </span>
        )}
      </div>
      {resize && (
        <div className="dk-imgv-snaps" contentEditable={false} aria-hidden="true">
          {SNAP_STEPS.map((s) => (
            <span key={s} className={Math.round(resize.pct) === s ? 'on' : undefined}>
              {s}%
            </span>
          ))}
        </div>
      )}
      {caption !== null && caption !== undefined && (editable || str(caption)) && (
        <input
          ref={captionRef}
          className="dk-imgv-caption"
          aria-label="Caption"
          placeholder="Add a caption"
          value={str(caption)}
          readOnly={!editable}
          onFocus={() => setCaptionFocus(true)}
          onBlur={() => {
            setCaptionFocus(false);
            if (!str(attrs.caption).trim()) updateAttributes({ caption: null });
          }}
          onChange={(e) => updateAttributes({ caption: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const p = pos();
              if (p != null)
                editor
                  .chain()
                  .focus()
                  .setTextSelection(p + node.nodeSize)
                  .run();
            }
          }}
          data-focused={captionFocus || undefined}
        />
      )}
    </NodeViewWrapper>
  );
}
