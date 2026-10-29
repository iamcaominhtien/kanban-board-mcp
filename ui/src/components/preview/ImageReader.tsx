import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatePanel } from './StatePanel';
import { isTyping, useViewerKeys } from './useViewerKeys';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

type Background = 'dark' | 'light' | 'checker';
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const STEP = 1.25;

interface View {
  /** Zoom factor; ignored while `fit` is true. */
  scale: number;
  fit: boolean;
  tx: number;
  ty: number;
  rot: number;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Convert an image blob to PNG, which is what the clipboard accepts. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the image'))), 'image/png'),
  );
}

/** Image reader: fit, zoom to the pointer, pan, rotate, copy, a map when zoomed, and a background choice. */
export function ImageReader({ item, onFacts, actions, onNavigate }: ReaderProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, fit: true, tx: 0, ty: 0, rot: 0 });
  const [bg, setBg] = useState<Background>('dark');
  const [bgOpen, setBgOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; start: { x: number; y: number } } | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setNatural(null);
    setFailed(false);
    setView({ scale: 1, fit: true, tx: 0, ty: 0, rot: 0 });
  }, [item.src]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rotated = view.rot % 180 !== 0;
  const effW = natural ? (rotated ? natural.h : natural.w) : 0;
  const effH = natural ? (rotated ? natural.w : natural.h) : 0;
  const fitScale = useMemo(() => {
    if (!natural || !box.w || !box.h) return 1;
    return Math.min(1, (box.w - 32) / effW, (box.h - 32) / effH);
  }, [natural, box, effW, effH]);
  const scale = view.fit ? fitScale : view.scale;

  const limit = useCallback(
    (tx: number, ty: number, s: number) => {
      const maxX = Math.max(0, (effW * s - box.w) / 2);
      const maxY = Math.max(0, (effH * s - box.h) / 2);
      return { tx: clamp(tx, -maxX, maxX), ty: clamp(ty, -maxY, maxY) };
    },
    [effW, effH, box],
  );

  const zoomTo = useCallback(
    (next: number, around?: { x: number; y: number }) => {
      setView((v) => {
        const cur = v.fit ? fitScale : v.scale;
        const s = clamp(next, MIN_SCALE, MAX_SCALE);
        const p = around ?? { x: 0, y: 0 };
        const ratio = s / cur;
        const t = limit(p.x - (p.x - v.tx) * ratio, p.y - (p.y - v.ty) * ratio, s);
        return { ...v, fit: false, scale: s, ...t };
      });
    },
    [fitScale, limit],
  );

  const resetFit = useCallback(() => setView((v) => ({ ...v, fit: true, tx: 0, ty: 0 })), []);
  const rotate = useCallback(() => setView((v) => ({ ...v, rot: (v.rot + 90) % 360, fit: true, tx: 0, ty: 0 })), []);

  useViewerKeys((e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return false;
    if (e.key === '+' || e.key === '=') zoomTo(scale * STEP);
    else if (e.key === '-' || e.key === '_') zoomTo(scale / STEP);
    else if (e.key === '0') resetFit();
    else if (e.key === 'r' || e.key === 'R') rotate();
    else return false;
    return true;
  });

  function pointerOffset(e: { clientX: number; clientY: number }) {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 } : { x: 0, y: 0 };
  }

  // Wheel zoom needs a listener that may cancel the scroll, which React's own wheel handler cannot do
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e) => {
    e.preventDefault();
    zoomTo(scale * Math.exp(-e.deltaY * 0.0015), pointerOffset(e));
  };
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        start: pointerOffset({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }),
      };
      swipe.current = null;
    } else if (pointers.current.size === 1) {
      swipe.current = { x: e.clientX, y: e.clientY };
      setDragging(true);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomTo((gesture.current.scale * dist) / gesture.current.dist, gesture.current.start);
    } else if (pointers.current.size === 1 && !view.fit) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setView((v) => ({ ...v, ...limit(v.tx + dx, v.ty + dy, v.scale) }));
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
    setDragging(false);
    const start = swipe.current;
    swipe.current = null;
    if (start && view.fit && e.pointerType === 'touch') {
      const dx = e.clientX - start.x;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - start.y) * 1.5) onNavigate?.(dx < 0 ? 1 : -1);
    }
  }

  function toggleActualSize(e: React.MouseEvent) {
    if (view.fit && fitScale < 1) zoomTo(1, pointerOffset(e));
    else if (view.fit) zoomTo(2, pointerOffset(e));
    else resetFit();
  }

  async function copyImage() {
    try {
      const blob = await (await fetch(item.src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(blob) })]);
      setCopied('Copied');
    } catch {
      setCopied('Copy failed');
    }
    setTimeout(() => setCopied(null), 2000);
  }

  if (failed) {
    return (
      <StatePanel tone="error" title="Could not make a preview" actions={actions}>
        The file may be damaged or in a format we cannot read. Nothing was changed.
      </StatePanel>
    );
  }

  const zoomed = natural !== null && effW * scale > box.w + 1 + 0 && !view.fit;
  const percent = Math.round(scale * 100);
  const mapW = 132;
  const mapK = natural ? mapW / effW : 1;
  const visW = natural ? Math.min(1, box.w / (effW * scale)) : 1;
  const visH = natural ? Math.min(1, box.h / (effH * scale)) : 1;
  const visL = natural ? 0.5 - view.tx / (effW * scale) - visW / 2 : 0;
  const visT = natural ? 0.5 - view.ty / (effH * scale) - visH / 2 : 0;

  return (
    <div className={styles.imageReader}>
      <div
        ref={stageRef}
        className={`${styles.imageStage} ${styles[`bg_${bg}`]}`}
        data-dragging={dragging || undefined}
        data-pannable={!view.fit || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={toggleActualSize}
      >
        {!natural && <div className={styles.imageLoading} aria-hidden="true" />}
        <img
          src={item.src}
          alt={item.alt ?? item.name}
          draggable={false}
          className={styles.imageEl}
          style={{
            width: natural?.w,
            height: natural?.h,
            opacity: natural ? 1 : 0,
            transform: `translate(-50%, -50%) translate(${view.tx}px, ${view.ty}px) scale(${scale}) rotate(${view.rot}deg)`,
          }}
          onLoad={(e) => {
            const img = e.currentTarget;
            const w = img.naturalWidth || 300;
            const h = img.naturalHeight || 300;
            setNatural({ w, h });
            onFacts({ Dimensions: `${img.naturalWidth || '?'} × ${img.naturalHeight || '?'}` });
          }}
          onError={() => setFailed(true)}
        />
        {zoomed && natural && (
          <div className={styles.minimap} style={{ width: mapW, height: effH * mapK }} aria-hidden="true">
            <img
              src={item.src}
              alt=""
              style={{
                width: natural.w * mapK,
                height: natural.h * mapK,
                transform: `translate(-50%, -50%) rotate(${view.rot}deg)`,
              }}
            />
            <span
              className={styles.minimapView}
              style={{
                left: `${visL * 100}%`,
                top: `${visT * 100}%`,
                width: `${visW * 100}%`,
                height: `${visH * 100}%`,
              }}
            />
          </div>
        )}
      </div>

      <div className={styles.imageToolbar} role="toolbar" aria-label="Image controls">
        <button type="button" onClick={() => zoomTo(scale / STEP)} aria-label="Zoom out" title="Zoom out (−)">
          −
        </button>
        <span className={styles.zoomLabel} aria-live="polite">
          {view.fit ? 'Fit' : `${percent}%`}
        </span>
        <button type="button" onClick={() => zoomTo(scale * STEP)} aria-label="Zoom in" title="Zoom in (+)">
          +
        </button>
        <span className={styles.toolbarSep} />
        <button type="button" onClick={resetFit} data-active={view.fit || undefined} title="Fit to screen (0)">
          Fit
        </button>
        <button type="button" onClick={() => zoomTo(1)} title="Actual size">
          100%
        </button>
        <button type="button" onClick={rotate} aria-label="Rotate" title="Rotate (R)">
          ⟳
        </button>
        <button type="button" onClick={copyImage} title="Copy image">
          {copied ?? 'Copy'}
        </button>
        <span className={styles.toolbarSep} />
        <span className={styles.bgWrap}>
          <button
            type="button"
            onClick={() => setBgOpen((o) => !o)}
            aria-expanded={bgOpen}
            aria-haspopup="true"
            title="Background"
          >
            Background
          </button>
          {bgOpen && (
            <span className={styles.bgMenu} role="menu">
              {(['dark', 'light', 'checker'] as Background[]).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="menuitemradio"
                  aria-checked={bg === b}
                  onClick={() => {
                    setBg(b);
                    setBgOpen(false);
                  }}
                >
                  {b === 'checker' ? 'Checkerboard' : b === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
