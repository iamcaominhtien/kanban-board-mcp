import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileCategoryIcon, formatFileSize, getFileTypeMeta } from '../../utils/fileIcons';
import { ImageReader } from './ImageReader';
import { TextReader } from './TextReader';
import { JsonReader } from './JsonReader';
import { TableReader } from './TableReader';
import { HtmlReader } from './HtmlReader';
import { MediaReader } from './MediaReader';
import { StatePanel } from './StatePanel';
import { canShowInFolder, isDesktop, openInDefaultApp, showInFolder } from './desktop';
import { kindLabel, previewKind } from './kinds';
import { isTyping, useViewerKeys } from './useViewerKeys';
import { useSketch, type SketchOwner } from '../sketch/SketchContext';
import { useCanvas, type CanvasOwner } from '../canvas/CanvasContext';
import { OpenOnCanvas } from '../canvas/OpenOnCanvas';
import { SketchIcon } from '../sketch/SketchIcon';
import type { PreviewItem } from './types';
import styles from './PreviewViewer.module.css';

// Heavy readers load only when a file needs them
const MarkdownReader = lazy(() => import('./MarkdownReader'));
const PdfReader = lazy(() => import('./PdfReader'));
const ArchiveReader = lazy(() => import('./ArchiveReader'));
const OfficeReader = lazy(() => import('./OfficeReader'));

interface Props {
  items: PreviewItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Where "Draw on it" saves to; without it the button is hidden. */
  sketchOwner?: SketchOwner | null;
  /** Where "Open on a canvas" puts the file; without it the button is hidden. */
  canvasOwner?: CanvasOwner | null;
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  close: 'M18 6 6 18M6 6l12 12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  full: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  prev: 'm15 18-6-6 6-6',
  next: 'm9 18 6-6-6-6',
  page: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7zM14 3v4h4',
};

function Thumb({ item, active, onPick }: { item: PreviewItem; active: boolean; onPick: () => void }) {
  const meta = getFileTypeMeta(item.name);
  const [broken, setBroken] = useState(false);
  const isImg = previewKind(item.name) === 'image';
  return (
    <button
      type="button"
      className={styles.thumb}
      data-active={active || undefined}
      data-broken={broken || undefined}
      onClick={onPick}
      aria-label={item.name}
      aria-current={active || undefined}
      title={broken ? `${item.name} cannot be shown` : item.name}
    >
      {isImg && !broken ? (
        <img src={item.src} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : broken ? (
        <span className={styles.thumbWarn} aria-hidden="true">
          !
        </span>
      ) : (
        <span className={styles.thumbBadge} style={{ background: meta.bgColor, color: meta.color }}>
          {meta.badge}
        </span>
      )}
    </button>
  );
}

/**
 * The one viewer for every image and file: a header, a reader for the type, a thumbnail strip and a details panel.
 * @param props.items - The files around the one that was opened.
 * @param props.index - Which of them is showing.
 * @param props.onIndex - Called with the new position for next / previous.
 * @param props.onClose - Called on Esc, the close button or a click outside.
 * @param props.sketchOwner - Where "Draw on it" saves to, set by the page that opened the viewer.
 */
export default function PreviewViewer({ items, index, onIndex, onClose, sketchOwner, canvasOwner }: Props) {
  const canvasApi = useCanvas();
  const item = items[index];
  const rootRef = useRef<HTMLDivElement>(null);
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [details, setDetails] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const desktop = isDesktop();
  const meta = getFileTypeMeta(item.name);
  const kind = previewKind(item.name);
  const downloadHref = item.downloadUrl ?? item.src;
  // "Draw on it": a page that owns the file says where the marked-up copy goes
  const sketch = useSketch();
  const canDraw =
    !!sketchOwner && sketch.available && !!item.uploadPath && /\.(png|jpe?g|gif|webp|bmp)$/i.test(item.name);

  const drawingRef = useRef(false);
  async function drawOnIt() {
    if (!sketchOwner || !item.uploadPath || drawingRef.current) return;
    const stem = item.name.replace(/\.[^.]+$/, '');
    drawingRef.current = true;
    try {
      // the picture opens on its own locked layer; saving makes a new copy and the original is never changed
      const r = await sketch.openSketch({
        ownerKind: sketchOwner.ownerKind,
        ownerId: sketchOwner.ownerId,
        projectId: sketchOwner.projectId,
        ownerLabel: sketchOwner.ownerLabel,
        baseImageUrl: item.uploadPath,
        title: `${stem} (marked up)`,
      });
      if (r) sketchOwner.onSaved?.(r);
    } finally {
      drawingRef.current = false;
    }
  }

  // Facts belong to one file
  useEffect(() => {
    setFacts({});
    setStatus(null);
  }, [item.id]);
  // The size, when the place that opened the file did not say it: ask for its first byte and read the total length
  // from the answer (the uploads route takes GET only), then stop the download
  const [headSize, setHeadSize] = useState<number | null>(null);
  useEffect(() => {
    setHeadSize(null);
    if (item.size || !item.src || item.src.startsWith('blob:') || item.src.startsWith('data:')) return;
    const ctl = new AbortController();
    fetch(item.src, { headers: { Range: 'bytes=0-0' }, signal: ctl.signal })
      .then((r) => {
        const total = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1]);
        const n = r.status === 206 ? total : Number(r.headers.get('content-length'));
        if (r.ok && n > 0) setHeadSize(n);
        ctl.abort();
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [item.id, item.src, item.size]);
  const size = item.size || headSize || 0;
  const onFacts = useCallback((f: Record<string, string>) => setFacts((prev) => ({ ...prev, ...f })), []);

  // Lock page scroll and move focus into the viewer
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    rootRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const go = useCallback(
    (dir: -1 | 1) => {
      if (items.length < 2) return;
      onIndex((index + dir + items.length) % items.length);
    },
    [items.length, index, onIndex],
  );

  // A file that could run a program (.exe, .sh …) is confirmed by the desktop app itself, in a system dialog the page
  // cannot click through
  async function openInApp() {
    setStatus('Opening…');
    const res = await openInDefaultApp(item);
    setStatus(res.message);
    if (res.ok) setTimeout(() => setStatus(null), 4000);
  }

  async function reveal() {
    const res = await showInFolder(item);
    setStatus(res.message);
    setTimeout(() => setStatus(null), 4000);
  }

  function copyLink() {
    navigator.clipboard
      .writeText(item.src)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => undefined);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
  }

  useViewerKeys((e) => {
    // the sketch editor sits on top while drawing: its keys (Esc, tool letters, arrows) are not the viewer's
    if (drawingRef.current) return false;
    if (e.key === 'Escape') {
      // Esc first clears a search the reader has open, then closes
      const t = e.target as HTMLInputElement | null;
      if (t && t.tagName === 'INPUT' && t.type === 'search' && t.value) return false;
      if (document.fullscreenElement) void document.exitFullscreen();
      else onClose();
      return true;
    }
    if (e.key === 'Tab') {
      const root = rootRef.current;
      if (!root) return false;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!focusable.length) return false;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        first.focus();
        return true;
      }
      if (e.shiftKey && (active === first || active === root)) {
        last.focus();
        return true;
      }
      if (!e.shiftKey && active === last) {
        first.focus();
        return true;
      }
      return false;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return false;
    const t = e.target as HTMLElement | null;
    const onPlayer = !!t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO');
    if (e.key === 'ArrowLeft' && !onPlayer && items.length > 1) go(-1);
    else if (e.key === 'ArrowRight' && !onPlayer && items.length > 1) go(1);
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 'i' || e.key === 'I') setDetails((v) => !v);
    else if (e.key === 'd' || e.key === 'D') document.getElementById('pv-download')?.click();
    else return false;
    return true;
  });

  const actions = (
    <>
      <a className={styles.btn} href={downloadHref} download={item.name}>
        Download
      </a>
      {desktop && (
        <button type="button" className={styles.btn} onClick={() => void openInApp()}>
          Open in app
        </button>
      )}
    </>
  );

  const reader = useMemo(() => {
    const props = { item, onFacts, actions, downloadHref, onNavigate: go };
    switch (kind) {
      case 'image':
        return <ImageReader {...props} />;
      case 'text':
      case 'code':
        return <TextReader {...props} />;
      case 'json':
        return <JsonReader {...props} />;
      case 'markdown':
        return <MarkdownReader {...props} />;
      case 'html':
        return <HtmlReader {...props} />;
      case 'table':
        return <TableReader {...props} />;
      case 'pdf':
        return <PdfReader {...props} />;
      case 'archive':
        return <ArchiveReader {...props} />;
      case 'media':
        return <MediaReader {...props} />;
      case 'word':
      case 'powerpoint':
        return <OfficeReader {...props} which={kind} />;
      default:
        // design preview-types M: a neutral tile, the facts and a primary Download (not a warning)
        return (
          <div className={styles.noPreview} role="status" data-testid="no-preview">
            <span className={styles.noPreviewTile} aria-hidden="true">
              {meta.badge}
            </span>
            <div className={styles.stateTitle}>{item.name}</div>
            <span className={styles.srOnly}>No preview available.</span>
            <div className={styles.stateText}>
              This kind of file cannot be shown here. You can download it
              {desktop ? ', or open it in an app on your computer' : ''}.
            </div>
            <dl className={styles.noPreviewFacts}>
              <div>
                <dt>Type</dt>
                <dd>{kindLabel(item.name, meta.label)}</dd>
              </div>
              {size > 0 && (
                <div>
                  <dt>Size</dt>
                  <dd>{formatFileSize(size)}</dd>
                </div>
              )}
              {item.uploadedBy && (
                <div>
                  <dt>Uploaded by</dt>
                  <dd>{item.uploadedBy}</dd>
                </div>
              )}
            </dl>
            <div className={styles.stateActions}>
              {desktop && (
                <button type="button" className={styles.btn} onClick={() => void openInApp()}>
                  <Icon d={ICONS.external} size={14} /> Open in app
                </button>
              )}
              <a className={`${styles.btn} ${styles.btnPrimary}`} href={downloadHref} download={item.name}>
                <Icon d={ICONS.download} size={14} /> Download
              </a>
            </div>
          </div>
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, kind, desktop, go, onFacts, size]);

  const detailRows: [string, string][] = [
    ['Type', kindLabel(item.name, meta.label)],
    ...(size ? ([['Size', formatFileSize(size)]] as [string, string][]) : []),
    ...Object.entries(facts),
    ...(item.uploadedBy ? ([['Uploaded by', item.uploadedBy]] as [string, string][]) : []),
    ...(item.uploadedAt ? ([['Uploaded', item.uploadedAt]] as [string, string][]) : []),
  ];

  return createPortal(
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={rootRef}
        className={styles.viewer}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${item.name}`}
        tabIndex={-1}
        data-testid="preview-viewer"
      >
        <header className={styles.header}>
          <span className={styles.fileIcon} style={{ background: meta.bgColor, borderColor: meta.borderColor }}>
            <FileCategoryIcon category={meta.category} size={18} color={meta.color} />
          </span>
          <div className={styles.titleBlock}>
            <div className={styles.titleRow}>
              <span className={styles.fileName} title={item.name}>
                {item.name}
              </span>
              <span
                className={styles.badge}
                style={{ background: meta.bgColor, color: meta.color, borderColor: meta.borderColor }}
              >
                {meta.badge}
              </span>
            </div>
            <div className={styles.subtitle} aria-live="polite">
              {kindLabel(item.name, meta.label)}
              {size ? ` · ${formatFileSize(size)}` : ''}
              {facts.Dimensions ? ` · ${facts.Dimensions}` : ''}
              {item.uploadedBy ? ` · ${item.uploadedBy}` : ''}
              {item.uploadedAt ? ` · ${item.uploadedAt}` : ''}
              {status ? ` · ${status}` : ''}
            </div>
          </div>
          {/* design preview-viewer B: ‹ 1 of 7 ›, a rule, then icon buttons with tooltips */}
          {items.length > 1 && (
            <div className={styles.counterGroup}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => go(-1)}
                aria-label="Previous"
                title="Previous (←)"
              >
                <Icon d={ICONS.prev} />
              </button>
              <span className={styles.counter} aria-label={`File ${index + 1} of ${items.length}`}>
                {index + 1} of {items.length}
              </span>
              <button type="button" className={styles.iconBtn} onClick={() => go(1)} aria-label="Next" title="Next (→)">
                <Icon d={ICONS.next} />
              </button>
            </div>
          )}
          <span className={styles.headRule} aria-hidden="true" />
          <div className={styles.actions}>
            {canDraw && kind === 'image' && (
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.iconBtnDraw}`}
                onClick={() => void drawOnIt()}
                aria-label="Draw on it"
                title="Draw on it: open the picture in the sketch editor. Your marks go on a layer above it; the original is never changed."
                data-testid="draw-on-it"
              >
                <SketchIcon name="sketch" size={15} />
              </button>
            )}
            {!!canvasOwner &&
              canvasApi.available &&
              !!item.uploadPath &&
              /\.(html?|png|jpe?g|gif|webp|svg)$/i.test(item.name) && (
                <OpenOnCanvas
                  owner={canvasOwner}
                  name={item.name}
                  src={item.src}
                  buttonClass={`${styles.iconBtn} ${styles.iconBtnDraw}`}
                  labelClass={styles.srOnly}
                />
              )}
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => setDetails((v) => !v)}
              aria-pressed={details}
              aria-label="Details"
              title="Details (I)"
            >
              <Icon d={ICONS.info} />
            </button>
            <a
              id="pv-download"
              className={styles.iconBtn}
              href={downloadHref}
              download={item.name}
              aria-label={desktop ? 'Download' : 'Download and open'}
              title={
                desktop
                  ? 'Download (D)'
                  : 'Download and open: the browser saves the file; open it from your downloads (D)'
              }
            >
              <Icon d={ICONS.download} />
            </a>
            {/* Open in app and Show in folder exist only in the desktop app (design E: the web build hides them) */}
            {desktop && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => void openInApp()}
                aria-label="Open in app"
                title="Open in app: the default app on this computer"
              >
                <Icon d={ICONS.external} />
              </button>
            )}
            {desktop && canShowInFolder() && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => void reveal()}
                aria-label="Show in folder"
                title="Show in Finder or Explorer"
              >
                <Icon d={ICONS.folder} />
              </button>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              onClick={copyLink}
              aria-label={copied ? 'Copied' : 'Copy link'}
              title={copied ? 'Copied' : 'Copy link'}
              data-copied={copied || undefined}
            >
              <Icon d={copied ? 'M5 12.5l4.5 4.5L19 7.5' : ICONS.link} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={toggleFullscreen}
              aria-label="Full screen"
              title="Full screen (F)"
            >
              <Icon d={ICONS.full} />
            </button>
            <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close" title="Close (Esc)">
              <Icon d={ICONS.close} />
            </button>
          </div>
        </header>

        <div className={styles.main}>
          <div className={styles.stage} data-kind={kind}>
            {items.length > 1 && (
              <>
                <button
                  type="button"
                  className={`${styles.nav} ${styles.navPrev}`}
                  onClick={() => go(-1)}
                  aria-label="Previous file"
                  title="Previous (←)"
                >
                  <Icon d={ICONS.prev} size={22} />
                </button>
                <button
                  type="button"
                  className={`${styles.nav} ${styles.navNext}`}
                  onClick={() => go(1)}
                  aria-label="Next file"
                  title="Next (→)"
                >
                  <Icon d={ICONS.next} size={22} />
                </button>
              </>
            )}
            <div className={styles.reader} key={item.id}>
              <Suspense fallback={<StatePanel tone="loading" title={`Opening ${item.name}…`} />}>{reader}</Suspense>
            </div>
          </div>

          {details && (
            <aside className={styles.details} aria-label="Details">
              <div className={styles.detailsHead}>
                <h2>Details</h2>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => setDetails(false)}
                  aria-label="Close details"
                  title="Close details (I)"
                >
                  <Icon d={ICONS.close} size={14} />
                </button>
              </div>
              <dl>
                {detailRows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {item.usedIn && item.usedIn.length > 0 && (
                <>
                  <h3>Used in</h3>
                  <ul className={styles.usedIn}>
                    {item.usedIn.map((u) => (
                      <li key={u}>
                        <Icon d={ICONS.page} size={14} /> {u}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className={styles.quick}>
                <div className={styles.quickRow}>
                  <button type="button" className={styles.btn} onClick={copyLink}>
                    <Icon d={ICONS.link} size={14} /> {copied ? 'Copied' : 'Copy link'}
                  </button>
                  {desktop && (
                    <button type="button" className={styles.btn} onClick={() => void openInApp()}>
                      <Icon d={ICONS.external} size={14} /> Open in app
                    </button>
                  )}
                  {desktop && canShowInFolder() && (
                    <button type="button" className={styles.btn} onClick={() => void reveal()}>
                      <Icon d={ICONS.folder} size={14} /> Show in folder
                    </button>
                  )}
                </div>
                <a
                  className={`${styles.btn} ${styles.btnPrimary} ${styles.btnWide}`}
                  href={downloadHref}
                  download={item.name}
                >
                  <Icon d={ICONS.download} size={14} /> Download
                </a>
              </div>
            </aside>
          )}
        </div>

        {items.length > 1 && (
          <nav className={styles.strip} aria-label="Files in this place">
            {items.map((it, i) => (
              <Thumb key={it.id + i} item={it} active={i === index} onPick={() => onIndex(i)} />
            ))}
          </nav>
        )}
      </div>
    </div>,
    document.body,
  );
}
