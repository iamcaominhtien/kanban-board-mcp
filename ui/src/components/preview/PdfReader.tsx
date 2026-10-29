import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { StatePanel } from './StatePanel';
import { AsyncBody } from './TextReader';
import { useFileData } from './useFileData';
import { isTyping, useViewerKeys } from './useViewerKeys';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const PDF_LIMIT = 60 * 1024 * 1024;

type Zoom = 'fit' | number;

function Page({ pdf, n, scale, root }: { pdf: PDFDocumentProxy; n: number; scale: number; root: HTMLElement | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [near, setNear] = useState(n <= 2);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      root,
      rootMargin: '600px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    pdf.getPage(n).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      setSize({ w: viewport.width, h: viewport.height });
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, n, scale, near]);

  return (
    <div
      ref={boxRef}
      className={styles.pdfPage}
      data-page={n}
      style={size ? { width: size.w, height: size.h } : { width: 600 * scale, height: 780 * scale }}
    >
      <canvas ref={canvasRef} style={size ? { width: size.w, height: size.h } : undefined} aria-label={`Page ${n}`} />
    </div>
  );
}

function Thumb({ pdf, n, active, onGo }: { pdf: PDFDocumentProxy; n: number; active: boolean; onGo: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    pdf.getPage(n).then((page) => {
      if (cancelled || !ref.current) return;
      const viewport = page.getViewport({ scale: 96 / page.getViewport({ scale: 1 }).width });
      const canvas = ref.current;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (ctx) page.render({ canvas, canvasContext: ctx, viewport }).promise.catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, n]);
  return (
    <button
      type="button"
      className={styles.pdfThumb}
      data-active={active || undefined}
      onClick={onGo}
      aria-label={`Page ${n}`}
    >
      <canvas ref={ref} />
      <span>{n}</span>
    </button>
  );
}

/** PDF reader: page thumbnails, zoom, page jump and search, in the app instead of the browser's own frame. */
export default function PdfReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, PDF_LIMIT);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [problem, setProblem] = useState<'protected' | 'damaged' | 'large' | null>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState('1');
  const [baseWidth, setBaseWidth] = useState(612);
  const [paneWidth, setPaneWidth] = useState(0);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<number[]>([]);
  const [hitIdx, setHitIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textCache = useRef(new Map<number, string>());

  useEffect(() => {
    if (state.status !== 'ready') return;
    if (state.truncated) {
      setProblem('large');
      return;
    }
    let cancelled = false;
    setProblem(null);
    setPdf(null);
    textCache.current.clear();
    const task = pdfjs.getDocument({ data: state.bytes.slice() });
    task.promise
      .then(async (d) => {
        if (cancelled) return;
        const first = await d.getPage(1);
        setBaseWidth(first.getViewport({ scale: 1 }).width);
        setPdf(d);
        onFacts({ Pages: String(d.numPages) });
      })
      .catch((err: { name?: string }) => {
        if (!cancelled) setProblem(err?.name === 'PasswordException' ? 'protected' : 'damaged');
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [state, onFacts]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setPaneWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);

  const scale = zoom === 'fit' ? Math.max(0.2, (paneWidth - 48) / baseWidth) : zoom;

  const goTo = useCallback((n: number) => {
    const el = scrollRef.current?.querySelector(`[data-page="${n}"]`);
    el?.scrollIntoView({ block: 'start' });
    setPage(n);
    setJump(String(n));
  }, []);

  function onScroll() {
    const root = scrollRef.current;
    if (!root) return;
    const mid = root.getBoundingClientRect().top + root.clientHeight / 3;
    let current = 1;
    root.querySelectorAll<HTMLElement>('[data-page]').forEach((el) => {
      if (el.getBoundingClientRect().top <= mid) current = Number(el.dataset.page);
    });
    setPage(current);
    setJump(String(current));
  }

  useViewerKeys((e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return false;
    const cur = zoom === 'fit' ? scale : zoom;
    if (e.key === '+' || e.key === '=') setZoom(Math.min(4, cur * 1.25));
    else if (e.key === '-' || e.key === '_') setZoom(Math.max(0.25, cur / 1.25));
    else if (e.key === '0') setZoom('fit');
    else return false;
    return true;
  });

  async function search(q: string) {
    setQuery(q);
    if (!pdf || !q.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    const needle = q.trim().toLowerCase();
    const found: number[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      let text = textCache.current.get(n);
      if (text === undefined) {
        const content = await (await pdf.getPage(n)).getTextContent();
        text = content.items
          .map((i) => ('str' in i ? i.str : ''))
          .join(' ')
          .toLowerCase();
        textCache.current.set(n, text);
      }
      if (text.includes(needle)) found.push(n);
    }
    setSearching(false);
    setHits(found);
    setHitIdx(0);
    if (found.length) goTo(found[0]);
  }

  function stepHit(dir: 1 | -1) {
    if (!hits.length) return;
    const next = (hitIdx + dir + hits.length) % hits.length;
    setHitIdx(next);
    goTo(hits[next]);
  }

  if (problem === 'protected')
    return (
      <StatePanel tone="warn" title="This file needs a password" actions={actions}>
        Previews cannot open protected files. Download it and open it in an app.
      </StatePanel>
    );
  if (problem === 'large')
    return (
      <StatePanel tone="warn" title="Too large to preview" actions={actions}>
        {item.name} is too large to read here. Download it to see everything.
      </StatePanel>
    );
  if (problem === 'damaged')
    return (
      <StatePanel tone="error" title="Could not make a preview" actions={actions}>
        The file may be damaged or in a format we cannot read. Nothing was changed.
      </StatePanel>
    );

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {!pdf ? (
        <StatePanel tone="loading" title={`Opening ${item.name}…`} />
      ) : (
        <div className={styles.pdfReader}>
          <div className={styles.readerBar}>
            <span className={styles.pageJump}>
              <label>
                <span className={styles.srOnly}>Page</span>
                <input
                  type="number"
                  min={1}
                  max={pdf.numPages}
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') goTo(Math.min(pdf.numPages, Math.max(1, Number(jump) || 1)));
                  }}
                />
              </label>
              / {pdf.numPages}
            </span>
            <button type="button" onClick={() => setZoom(Math.max(0.25, scale / 1.25))} aria-label="Zoom out">
              −
            </button>
            <span className={styles.zoomLabel}>{zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}</span>
            <button type="button" onClick={() => setZoom(Math.min(4, scale * 1.25))} aria-label="Zoom in">
              +
            </button>
            <button type="button" onClick={() => setZoom('fit')} data-active={zoom === 'fit' || undefined}>
              Fit
            </button>
            <span className={styles.readerBarSpacer} />
            <label className={styles.searchBox}>
              <span className={styles.srOnly}>Search in PDF</span>
              <input
                type="search"
                placeholder="Search"
                value={query}
                onChange={(e) => void search(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    stepHit(e.shiftKey ? -1 : 1);
                  }
                }}
              />
              {query && (
                <span className={styles.matchCount}>
                  {searching
                    ? 'Searching…'
                    : hits.length
                      ? `page ${hits[hitIdx]} · ${hitIdx + 1} of ${hits.length}`
                      : 'No matches'}
                </span>
              )}
            </label>
          </div>
          <div className={styles.pdfBody}>
            <div className={styles.pdfRail} aria-label="Pages">
              {Array.from({ length: Math.min(pdf.numPages, 200) }, (_, i) => (
                <Thumb key={i} pdf={pdf} n={i + 1} active={page === i + 1} onGo={() => goTo(i + 1)} />
              ))}
            </div>
            <div ref={scrollRef} className={styles.pdfScroll} onScroll={onScroll} tabIndex={0} aria-label="PDF pages">
              {Array.from({ length: pdf.numPages }, (_, i) => (
                <Page key={i} pdf={pdf} n={i + 1} scale={scale} root={scrollRef.current} />
              ))}
            </div>
          </div>
        </div>
      )}
    </AsyncBody>
  );
}
