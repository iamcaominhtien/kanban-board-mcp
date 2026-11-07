import type { CSSProperties } from 'react';
import type { RenderedPara, RenderedShape, RenderedSlide } from './pptxRender';

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
    textIndent: p.indentPx,
    minHeight: p.runs.length ? undefined : `${p.emptySizePx * 1.2}px`,
  };
}

function Para({ p }: { p: RenderedPara }) {
  return (
    <p style={paraStyle(p)}>
      {p.bullet && <span style={{ marginRight: '0.4em' }}>{p.bullet}</span>}
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
              textDecoration: r.underline ? 'underline' : 'none',
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

function Shape({ s }: { s: RenderedShape }) {
  const radius =
    s.geometry === 'ellipse' ? '50%' : s.geometry === 'roundRect' ? Math.min(s.w, s.h) * s.radius : undefined;
  const drawn = s.geometry !== 'none';
  const style: CSSProperties = {
    position: 'absolute',
    left: s.x,
    top: s.y,
    width: s.w,
    height: s.h,
    boxSizing: 'border-box',
    transform:
      [s.rotation ? `rotate(${s.rotation}deg)` : '', s.flipH ? 'scaleX(-1)' : '', s.flipV ? 'scaleY(-1)' : '']
        .filter(Boolean)
        .join(' ') || undefined,
    ...(drawn && s.fill ? { background: s.fill } : null),
    ...(drawn && s.line && s.geometry !== 'line'
      ? { border: `${Math.max(1, s.line.widthPx)}px solid ${s.line.color}` }
      : null),
    ...(drawn && s.geometry === 'line' && s.line
      ? { height: 0, borderTop: `${Math.max(1, s.line.widthPx)}px solid ${s.line.color}` }
      : null),
    borderRadius: radius,
  };
  const [cl, ct, cr, cb] = s.image?.crop ?? [0, 0, 0, 0];
  return (
    <div style={style}>
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
      {s.text && s.text.paras.some((p) => p.runs.length || s.text) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent:
              s.text.anchor === 'center' ? 'center' : s.text.anchor === 'bottom' ? 'flex-end' : 'flex-start',
            padding: `${s.text.insets[1]}px ${s.text.insets[2]}px ${s.text.insets[3]}px ${s.text.insets[0]}px`,
            boxSizing: 'border-box',
            whiteSpace: s.text.wrap ? 'normal' : 'nowrap',
            overflowWrap: s.text.wrap ? 'break-word' : undefined,
          }}
        >
          {s.text.paras.map((p, i) => (
            <Para key={i} p={p} />
          ))}
        </div>
      )}
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
        background: slide.background,
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
