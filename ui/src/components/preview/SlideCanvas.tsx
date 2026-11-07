import { useId, type CSSProperties, type ReactNode } from 'react';
import { ChartCanvas } from './ChartCanvas';
import type {
  Fill,
  RenderedLine,
  RenderedPara,
  RenderedShape,
  RenderedSlide,
  RenderedTable,
  RenderedText,
} from './pptxRender';

function cssFill(fill: Fill | null | undefined): string | undefined {
  if (!fill) return undefined;
  if (fill.gradient)
    return `linear-gradient(${fill.gradient.angle + 90}deg, ${fill.gradient.stops.map((s) => `${s.color} ${s.pos}%`).join(', ')})`;
  return fill.color;
}

function paraStyle(p: RenderedPara): CSSProperties {
  const size = Math.max(0, ...p.runs.map((r) => r.sizePx)) || p.emptySizePx;
  return {
    margin: 0,
    marginTop: p.beforePx,
    marginBottom: p.afterPx,
    textAlign: p.align,
    lineHeight: p.lineHeightPx != null ? `${p.lineHeightPx}px` : p.lineHeightPct != null ? p.lineHeightPct : 1.2,
    fontSize: size,
    paddingLeft: Math.max(0, p.marginLeftPx),
    textIndent: p.bullet ? 0 : p.indentPx,
    minHeight: p.runs.length ? undefined : `${p.emptySizePx * 1.2}px`,
  };
}

function Para({ p }: { p: RenderedPara }) {
  const hanging = p.bullet && p.indentPx < 0 ? -p.indentPx : 0;
  return (
    <p style={{ ...paraStyle(p), paddingLeft: Math.max(0, p.marginLeftPx + (hanging ? p.indentPx : 0)) }}>
      {p.bullet && (
        <span
          style={{
            display: 'inline-block',
            width: hanging || undefined,
            marginRight: hanging ? undefined : '0.4em',
            textIndent: 0,
            color: p.runs[0]?.color,
            fontSize: p.runs[0]?.sizePx,
          }}
        >
          {p.bullet}
        </span>
      )}
      {p.runs.map((r, i) =>
        r.text === '\n' ? (
          <br key={i} />
        ) : (
          <span
            key={i}
            style={{
              fontSize: r.sizePx,
              fontWeight: r.bold ? 700 : 400,
              fontStyle: r.italic ? 'italic' : 'normal',
              textDecoration:
                [r.underline ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
              color: r.color,
              fontFamily: `"${r.font}", "Calibri", "Carlito", system-ui, sans-serif`,
              letterSpacing: r.spacingPx ? `${r.spacingPx}px` : undefined,
              verticalAlign: r.baseline ? (r.baseline > 0 ? 'super' : 'sub') : undefined,
            }}
          >
            {r.text}
          </span>
        ),
      )}
      {!p.runs.length && ' '}
    </p>
  );
}

function TextBox({ text }: { text: RenderedText }) {
  const [l, t, r, b] = text.insets;
  const justify = text.anchor === 'center' ? 'center' : text.anchor === 'bottom' ? 'flex-end' : 'flex-start';
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: justify,
        padding: `${t}px ${r}px ${b}px ${l}px`,
        boxSizing: 'border-box',
        whiteSpace: text.wrap ? 'normal' : 'nowrap',
        overflowWrap: text.wrap ? 'break-word' : undefined,
        writingMode: text.vertical ? 'vertical-rl' : undefined,
        transform: text.vertical === 'vert270' ? 'rotate(180deg)' : undefined,
      }}
    >
      {text.paras.map((p, i) => (
        <Para key={i} p={p} />
      ))}
    </div>
  );
}

function borderCss(line: RenderedLine | null | undefined): string | undefined {
  return line ? `${Math.max(1, line.widthPx)}px ${line.dash} ${line.color}` : undefined;
}

function Table({ table }: { table: RenderedTable }) {
  return (
    <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: table.cols.reduce((a, b) => a + b, 0) }}>
      <colgroup>
        {table.cols.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      <tbody>
        {table.rows.map((row, ri) => (
          <tr key={ri} style={{ height: row.h }}>
            {row.cells.map((c, ci) => (
              <td
                key={ci}
                colSpan={c.colSpan}
                rowSpan={c.rowSpan}
                style={{
                  position: 'relative',
                  padding: 0,
                  background: cssFill(c.fill),
                  borderLeft: borderCss(c.borders[0]),
                  borderTop: borderCss(c.borders[1]),
                  borderRight: borderCss(c.borders[2]),
                  borderBottom: borderCss(c.borders[3]),
                  verticalAlign: c.text.anchor === 'center' ? 'middle' : c.text.anchor === 'bottom' ? 'bottom' : 'top',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: `${c.text.insets[1]}px ${c.text.insets[2]}px ${c.text.insets[3]}px ${c.text.insets[0]}px`,
                  }}
                >
                  {c.text.paras.map((p, i) => (
                    <Para key={i} p={p} />
                  ))}
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The SVG of a shape drawn from paths: its fill (colour or gradient), its line and arrowheads. */
function PathShape({ s }: { s: RenderedShape }) {
  const raw = useId().replace(/[^a-zA-Z0-9]/g, '');
  const color = s.line?.color ?? '#000';
  const dash =
    s.line?.dash === 'dashed'
      ? `${s.line.widthPx * 4} ${s.line.widthPx * 3}`
      : s.line?.dash === 'dotted'
        ? `${s.line.widthPx} ${s.line.widthPx * 2}`
        : undefined;
  const g = s.fill?.gradient;
  const rad = g ? (g.angle * Math.PI) / 180 : 0;
  const fillRef = g ? `url(#g${raw})` : (s.fill?.color ?? 'none');
  const marker = (id: string, start: boolean): ReactNode => (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX={start ? 2 : 8}
      refY={5}
      markerWidth={6}
      markerHeight={6}
      orient="auto-start-reverse"
    >
      <path d="M0 0 L10 5 L0 10 Z" fill={color} />
    </marker>
  );
  return (
    <svg
      width={s.w}
      height={s.h}
      viewBox={`0 0 ${s.w} ${s.h}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
      aria-hidden="true"
    >
      <defs>
        {g && (
          <linearGradient
            id={`g${raw}`}
            x1={0.5 - Math.cos(rad) / 2}
            y1={0.5 - Math.sin(rad) / 2}
            x2={0.5 + Math.cos(rad) / 2}
            y2={0.5 + Math.sin(rad) / 2}
          >
            {g.stops.map((st, i) => (
              <stop key={i} offset={`${st.pos}%`} stopColor={st.color} />
            ))}
          </linearGradient>
        )}
        {s.line?.head && marker(`h${raw}`, true)}
        {s.line?.tail && marker(`t${raw}`, false)}
      </defs>
      {(s.paths ?? []).map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ? fillRef : 'none'}
          fillRule="evenodd"
          stroke={p.stroke && s.line ? color : 'none'}
          strokeWidth={s.line?.widthPx}
          strokeDasharray={dash}
          strokeLinejoin="round"
          markerStart={s.line?.head ? `url(#h${raw})` : undefined}
          markerEnd={s.line?.tail ? `url(#t${raw})` : undefined}
        />
      ))}
    </svg>
  );
}

function transformOf(s: RenderedShape): string | undefined {
  return (
    [s.rotation ? `rotate(${s.rotation}deg)` : '', s.flipH ? 'scaleX(-1)' : '', s.flipV ? 'scaleY(-1)' : '']
      .filter(Boolean)
      .join(' ') || undefined
  );
}

function Shape({ s }: { s: RenderedShape }) {
  const radius =
    s.geometry === 'ellipse' ? '50%' : s.geometry === 'roundRect' ? Math.min(s.w, s.h) * s.radius : undefined;
  const css = s.geometry === 'rect' || s.geometry === 'roundRect' || s.geometry === 'ellipse';
  const style: CSSProperties = {
    position: 'absolute',
    left: s.x,
    top: s.y,
    width: s.w,
    height: s.h,
    boxSizing: 'border-box',
    transform: transformOf(s),
    opacity: s.opacity === 1 ? undefined : s.opacity,
    filter: s.shadow && (s.fill || s.image || s.line || s.paths) ? s.shadow : undefined,
    ...(css && s.fill ? { background: cssFill(s.fill) } : null),
    ...(css && s.line ? { border: `${Math.max(1, s.line.widthPx)}px ${s.line.dash} ${s.line.color}` } : null),
    borderRadius: radius,
  };
  if (s.children && s.box) {
    const sx = s.w / (s.box.w || 1);
    const sy = s.h / (s.box.h || 1);
    return (
      <div style={style}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: s.box.w,
            height: s.box.h,
            transformOrigin: 'top left',
            transform: `scale(${sx}, ${sy}) translate(${-s.box.x}px, ${-s.box.y}px)`,
          }}
        >
          {s.children.map((c, i) => (
            <Shape key={i} s={c} />
          ))}
        </div>
      </div>
    );
  }
  const [cl, ct, cr, cb] = s.image?.crop ?? [0, 0, 0, 0];
  return (
    <div style={style}>
      {s.table && <Table table={s.table} />}
      {s.chart && <ChartCanvas chart={s.chart} width={s.w} height={s.h} />}
      {s.geometry === 'path' && <PathShape s={s} />}
      {s.image && (
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: radius }}>
          <img
            src={s.image.src}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: `${(-cl / (1 - cl - cr)) * 100}%`,
              top: `${(-ct / (1 - ct - cb)) * 100}%`,
              width: `${100 / (1 - cl - cr)}%`,
              height: `${100 / (1 - ct - cb)}%`,
              maxWidth: 'none',
            }}
          />
        </div>
      )}
      {s.text && <TextBox text={s.text} />}
    </div>
  );
}

/**
 * One slide drawn at `width` px: the slide's own size is laid out as is and scaled down, so text keeps its place.
 * @param props.slide - The slide read by `renderPptx`.
 * @param props.width - Width in CSS px to draw it at.
 */
export function SlideCanvas({ slide, width }: { slide: RenderedSlide; width: number }) {
  const scale = width / slide.width;
  return (
    <div
      style={{
        position: 'relative',
        width,
        height: slide.height * scale,
        overflow: 'hidden',
        background: cssFill(slide.background) ?? '#ffffff',
        backgroundImage: slide.backgroundImage ? `url(${slide.backgroundImage})` : undefined,
        backgroundSize: 'cover',
        flexShrink: 0,
      }}
      role="img"
      aria-label="Slide"
      data-testid="slide-canvas"
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: slide.width,
          height: slide.height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {slide.shapes.map((s, i) => (
          <Shape key={i} s={s} />
        ))}
      </div>
    </div>
  );
}
