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
import { isRunnableFile, previewKind } from './kinds';
import { isTyping, useViewerKeys } from './useViewerKeys';
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
}

const WEB_OPEN_HINT = 'Only in the desktop app. In the browser, download the file and open it from your downloads.';

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
 */
export default function PreviewViewer({ items, index, onIndex, onClose }: Props) {
  const item = items[index];
  const rootRef = useRef<HTMLDivElement>(null);
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [details, setDetails] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmRun, setConfirmRun] = useState<null | 'open'>(null);
  const [copied, setCopied] = useState(false);
  const desktop = isDesktop();
  const meta = getFileTypeMeta(item.name);
  const kind = previewKind(item.name);
  const downloadHref = item.downloadUrl ?? item.src;

  // Facts belong to one file
  useEffect(() => {
    setFacts({});
    setStatus(null);
    setConfirmRun(null);
  }, [item.id]);
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

  async function doOpen() {
    setConfirmRun(null);
    setStatus('Opening…');
    const res = await openInDefaultApp(item);
    setStatus(res.message);
    if (res.ok) setTimeout(() => setStatus(null), 4000);
  }

  function openInApp() {
    if (isRunnableFile(item.name)) setConfirmRun('open');
    else void doOpen();
  }

  async function reveal() {
    const res = await showInFolder(item);
    setStatus(res.message);
    setTimeout(() => setStatus(null), 4000);
  }

  function copyLink() {
    navigator.clipboard.writeText(item.src).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
  }

  useViewerKeys((e) => {
    if (e.key === 'Escape') {
      // Esc first clears a search the reader has open, then closes
      const t = e.target as HTMLInputElement | null;
      if (t && t.tagName === 'INPUT' && t.type === 'search' && t.value) return false;
      if (confirmRun) setConfirmRun(null);
      else if (document.fullscreenElement) void document.exitFullscreen();
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
        <button type="button" className={styles.btn} onClick={openInApp}>
          Open in app
        </button>
      )}
    </>
  );

  const reader = useMemo(() => {
    const props = { item, onFacts, actions, onNavigate: go };
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
        return (
          <StatePanel tone="warn" title="No preview available" actions={actions}>
            This kind of file cannot be shown here. You can download it
            {desktop ? ', or open it in an app on your computer' : ''}.
          </StatePanel>
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, kind, desktop, go, onFacts]);

  const detailRows: [string, string][] = [
    ['Type', meta.label],
    ...(item.size ? ([['Size', formatFileSize(item.size)]] as [string, string][]) : []),
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
              {meta.label}
              {item.size ? ` · ${formatFileSize(item.size)}` : ''}
              {facts.Dimensions ? ` · ${facts.Dimensions}` : ''}
              {item.uploadedBy ? ` · ${item.uploadedBy}` : ''}
              {item.uploadedAt ? ` · ${item.uploadedAt}` : ''}
              {status ? ` · ${status}` : ''}
            </div>
          </div>
          {items.length > 1 && (
            <span className={styles.counter} aria-label={`File ${index + 1} of ${items.length}`}>
              {index + 1} of {items.length}
            </span>
          )}
          <div className={styles.actions}>
            {desktop ? (
              <>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={openInApp}
                  title="Open with the default app on this computer"
                >
                  <Icon d={ICONS.external} size={14} /> <span className={styles.btnLabel}>Open in app</span>
                </button>
                {canShowInFolder() && (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void reveal()}
                    title="Show in Finder or Explorer"
                  >
                    <Icon d={ICONS.folder} size={14} /> <span className={styles.btnLabel}>Show in folder</span>
                  </button>
                )}
                <a
                  id="pv-download"
                  className={styles.btn}
                  href={downloadHref}
                  download={item.name}
                  title="Download (D)"
                >
                  <Icon d={ICONS.download} size={14} /> <span className={styles.btnLabel}>Download</span>
                </a>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.btn}
                  disabled
                  title={WEB_OPEN_HINT}
                  aria-label={`Open in app. ${WEB_OPEN_HINT}`}
                >
                  <Icon d={ICONS.external} size={14} /> <span className={styles.btnLabel}>Open in app</span>
                </button>
                <a
                  id="pv-download"
                  className={styles.btn}
                  href={downloadHref}
                  download={item.name}
                  title="The browser saves the file; open it from your downloads (D)"
                >
                  <Icon d={ICONS.download} size={14} /> <span className={styles.btnLabel}>Download and open</span>
                </a>
                <button type="button" className={styles.btn} onClick={copyLink}>
                  <Icon d={ICONS.link} size={14} />{' '}
                  <span className={styles.btnLabel}>{copied ? 'Copied' : 'Copy link'}</span>
                </button>
              </>
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
          <div className={styles.stage}>
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
              <h2>Details</h2>
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
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className={styles.quick}>
                <a className={styles.btn} href={downloadHref} download={item.name}>
                  Download
                </a>
                <button type="button" className={styles.btn} onClick={copyLink}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                {desktop ? (
                  <button type="button" className={styles.btn} onClick={openInApp}>
                    Open in app
                  </button>
                ) : (
                  <button type="button" className={styles.btn} disabled title={WEB_OPEN_HINT}>
                    Open in app
                  </button>
                )}
                {desktop && canShowInFolder() && (
                  <button type="button" className={styles.btn} onClick={() => void reveal()}>
                    Show in folder
                  </button>
                )}
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

        {confirmRun && (
          <div className={styles.confirmBackdrop}>
            <div
              className={styles.confirm}
              role="alertdialog"
              aria-labelledby="pv-run-title"
              aria-describedby="pv-run-text"
            >
              <h2 id="pv-run-title">Open {item.name}?</h2>
              <p id="pv-run-text">
                This kind of file can run programs on your computer. Open it only if you trust the person who added it.
              </p>
              <div className={styles.confirmActions}>
                <button type="button" className={styles.btn} onClick={() => setConfirmRun(null)} autoFocus>
                  Cancel
                </button>
                <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={() => void doOpen()}>
                  Open anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
