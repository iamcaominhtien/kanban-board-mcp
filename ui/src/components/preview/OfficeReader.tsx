import { useEffect, useMemo, useRef, useState } from 'react';
import { Notice, StatePanel } from './StatePanel';
import { AsyncBody } from './TextReader';
import { useFileData } from './useFileData';
import { OfficeError, parseDocx, parsePptx, type Slide, type WordBlock } from './office';
import { renderPptx, type RenderedSlide } from './pptxRender';
import { SlideCanvas } from './SlideCanvas';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

const OFFICE_LIMIT = 40 * 1024 * 1024;

function Problem({ reason, name, actions }: { reason: OfficeError['reason']; name: string; actions: React.ReactNode }) {
  if (reason === 'protected')
    return (
      <StatePanel tone="warn" title="This file needs a password" actions={actions}>
        Previews cannot open protected files. Download it and open it in an app.
      </StatePanel>
    );
  if (reason === 'too-large')
    return (
      <StatePanel tone="warn" title="Too large to preview" actions={actions}>
        {name} is too large to read here. Download it to see everything.
      </StatePanel>
    );
  return (
    <StatePanel tone="error" title="Could not make a preview" actions={actions}>
      The file may be damaged or in a format we cannot read. Nothing was changed.
    </StatePanel>
  );
}

function renderBlocks(blocks: WordBlock[], query: string) {
  const q = query.trim().toLowerCase();
  const mark = (text: string) => {
    if (!q) return text;
    const low = text.toLowerCase();
    const out: React.ReactNode[] = [];
    let from = 0;
    for (let at = low.indexOf(q); at !== -1; at = low.indexOf(q, from)) {
      if (at > from) out.push(text.slice(from, at));
      out.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>);
      from = at + q.length;
    }
    out.push(text.slice(from));
    return out;
  };
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    out.push(
      <Tag key={`l${out.length}`}>
        {list.items.map((t, i) => (
          <li key={i}>{mark(t)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  blocks.forEach((b, i) => {
    if (b.type === 'list') {
      if (list && list.ordered !== b.ordered) flush();
      list = list ?? { ordered: b.ordered, items: [] };
      list.items.push(b.text);
      return;
    }
    flush();
    if (b.type === 'heading') {
      const H = `h${Math.min(6, b.level + 1)}` as 'h2';
      out.push(<H key={i}>{mark(b.text)}</H>);
    } else if (b.type === 'paragraph') out.push(<p key={i}>{mark(b.text)}</p>);
    else
      out.push(
        <table key={i}>
          <tbody>
            {b.rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (ri === 0 ? <th key={ci}>{mark(c)}</th> : <td key={ci}>{mark(c)}</td>))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
  });
  flush();
  return out;
}

function WordView({
  item,
  bytes,
  actions,
  onFacts,
}: {
  item: ReaderProps['item'];
  bytes: Uint8Array;
  actions: React.ReactNode;
  onFacts: ReaderProps['onFacts'];
}) {
  const [query, setQuery] = useState('');
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, blocks: parseDocx(bytes) };
    } catch (err) {
      return { ok: false as const, error: err instanceof OfficeError ? err.reason : ('damaged' as const) };
    }
  }, [bytes]);
  useEffect(() => {
    if (parsed.ok) onFacts({ Blocks: String(parsed.blocks.length) });
  }, [parsed, onFacts]);
  if (!parsed.ok) return <Problem reason={parsed.error} name={item.name} actions={actions} />;
  return (
    <div className={styles.wordReader}>
      <div className={styles.readerBar}>
        <span className={styles.readerLabel}>{item.name}</span>
        <span className={styles.readerBarSpacer} />
        <label className={styles.searchBox}>
          <span className={styles.srOnly}>Search</span>
          <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <Notice actions={actions}>
        <strong>Simplified preview.</strong> Text, headings, lists and tables are shown. Fonts, page layout, pictures,
        comments and tracked changes are not. Open the original for the exact look.
      </Notice>
      <div className={styles.wordPage}>{renderBlocks(parsed.blocks, query)}</div>
    </div>
  );
}

/** The width of an element, followed as it is resized. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function SlidesView({
  item,
  bytes,
  actions,
  onFacts,
}: {
  item: ReaderProps['item'];
  bytes: Uint8Array;
  actions: React.ReactNode;
  onFacts: ReaderProps['onFacts'];
}) {
  const [at, setAt] = useState(0);
  const [mode, setMode] = useState<'slides' | 'outline'>('slides');
  const [stageRef, stageWidth] = useWidth();
  // The slides drawn from the file; their pictures are object URLs that are given back when the file is closed.
  const [drawn, setDrawn] = useState<RenderedSlide[] | null>(null);
  useEffect(() => {
    const urls: string[] = [];
    try {
      setDrawn(
        renderPptx(bytes, (data, mime) => {
          const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
          urls.push(url);
          return url;
        }),
      );
    } catch {
      setDrawn(null);
    }
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [bytes]);
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, slides: parsePptx(bytes) as Slide[] };
    } catch (err) {
      return { ok: false as const, error: err instanceof OfficeError ? err.reason : ('damaged' as const) };
    }
  }, [bytes]);
  useEffect(() => {
    if (parsed.ok) onFacts({ Slides: String(parsed.slides.length) });
  }, [parsed, onFacts]);
  if (!parsed.ok) return <Problem reason={parsed.error} name={item.name} actions={actions} />;
  const { slides } = parsed;
  const slide = slides[Math.min(at, slides.length - 1)];
  const drawing = drawn && drawn.length === slides.length ? drawn : null;
  const showSlides = mode === 'slides' && !!drawing;
  const canvasWidth = Math.max(0, Math.min(stageWidth - 40, 1100));
  const toggle = drawing ? (
    <button
      type="button"
      className={styles.btn}
      data-testid="slides-mode"
      onClick={() => setMode(showSlides ? 'outline' : 'slides')}
    >
      {showSlides ? 'Show the outline' : 'Show the slides'}
    </button>
  ) : null;
  return (
    <div className={styles.slidesReader}>
      <Notice
        actions={
          <>
            {toggle}
            {actions}
          </>
        }
      >
        {showSlides ? (
          <>
            <strong>Showing the slides.</strong> Drawn from the file: text, shapes, pictures, tables and charts. 3-D,
            animation and special effects are not drawn, and fonts follow this computer. Open the original for the exact
            look.
          </>
        ) : (
          <>
            <strong>Showing the outline.</strong> Text and speaker notes are shown instead of the slides.
          </>
        )}
      </Notice>
      <div className={styles.slidesBody}>
        <div className={styles.slideRail} aria-label="Slides">
          {slides.map((s, i) => (
            <button
              key={i}
              type="button"
              data-active={i === at || undefined}
              onClick={() => setAt(i)}
              aria-label={`Slide ${i + 1}: ${s.title || s.lines[0] || ''}`}
              title={s.title || s.lines[0]}
            >
              <span>{i + 1}</span>
              {showSlides && drawing ? (
                <span className={styles.slideThumb}>
                  <SlideCanvas slide={drawing[i]} width={104} />
                </span>
              ) : (
                <span className={styles.slideThumbTitle}>{s.title || s.lines[0] || 'Slide'}</span>
              )}
            </button>
          ))}
        </div>
        <div className={styles.slideMain} ref={stageRef}>
          {showSlides && drawing ? (
            <div className={styles.slideStage}>
              <SlideCanvas slide={drawing[Math.min(at, drawing.length - 1)]} width={canvasWidth || 640} />
            </div>
          ) : (
            <div className={styles.slideCard}>
              {slide.kicker && <div className={styles.slideKicker}>{slide.kicker}</div>}
              <h2>{slide.title || `Slide ${at + 1}`}</h2>
              <ul>
                {slide.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          <div className={styles.slideNotes} style={showSlides && canvasWidth ? { width: canvasWidth } : undefined}>
            <strong>Speaker notes</strong>
            <p>{slide.notes || 'No notes on this slide.'}</p>
          </div>
          <div className={styles.slideNav}>
            <button type="button" disabled={at === 0} onClick={() => setAt(at - 1)}>
              Previous
            </button>
            <span>
              Slide {at + 1} of {slides.length}
            </span>
            <button type="button" disabled={at >= slides.length - 1} onClick={() => setAt(at + 1)}>
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Word (simplified reading view) and PowerPoint (the slides drawn from the file, or their outline, with notes). Read only; nothing in the file runs. */
export default function OfficeReader(props: ReaderProps & { which: 'word' | 'powerpoint' }) {
  const [state, retry] = useFileData(props.item.src, OFFICE_LIMIT);
  return (
    <AsyncBody state={state} retry={retry} actions={props.actions} name={props.item.name}>
      {state.status === 'ready' &&
        (state.truncated ? (
          <Problem reason="too-large" name={props.item.name} actions={props.actions} />
        ) : props.which === 'word' ? (
          <WordView item={props.item} bytes={state.bytes} actions={props.actions} onFacts={props.onFacts} />
        ) : (
          <SlidesView item={props.item} bytes={state.bytes} actions={props.actions} onFacts={props.onFacts} />
        ))}
    </AsyncBody>
  );
}
