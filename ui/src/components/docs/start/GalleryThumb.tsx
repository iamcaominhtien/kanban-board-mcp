/**
 * The small drawing on a gallery card (design "Starting and shaping a page", frames 1 and 5): each template drawn
 * with the blocks it starts with. The work templates reuse the empty space's drawings; a saved or BA template is
 * drawn from the first words of its text.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { GalleryItem } from './galleryRules';

const wbar = (w: string | number, h: number, bg: string, extra?: CSSProperties): CSSProperties => ({
  width: w,
  height: h,
  borderRadius: 3,
  background: bg,
  flexShrink: 0,
  ...extra,
});
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const box = (done: boolean): CSSProperties =>
  done
    ? { width: 9, height: 9, borderRadius: 2.5, background: '#2E6F40', flexShrink: 0 }
    : { width: 9, height: 9, borderRadius: 2.5, border: '1.5px solid #B7C4BC', boxSizing: 'border-box', flexShrink: 0 };

/** The 104px mini preview of a work template (Blank, Requirements, Meeting notes, Decision log, Technical design). */
export function TemplateThumb({ id }: { id: string }) {
  let inner: React.ReactNode = null;
  if (id === 'blank') {
    inner = (
      <>
        <div style={wbar('46%', 8, '#C7D2CB')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 6, fontSize: 11, color: '#9AA8A0' }}>
          <span className="dk-caret" style={{ height: 12 }} />
          Type / to start
        </div>
      </>
    );
  } else if (id === 'requirements') {
    inner = (
      <>
        <div style={wbar('52%', 8, '#C7D2CB')} />
        <div style={wbar('90%', 6, '#DCE6DF')} />
        {(
          [
            [true, '64%'],
            [true, '72%'],
            [false, '58%'],
            [false, '68%'],
          ] as [boolean, string][]
        ).map(([d, w], i) => (
          <div key={i} style={row}>
            <div style={box(d)} />
            <div style={wbar(w, 6, '#DCE6DF')} />
          </div>
        ))}
      </>
    );
  } else if (id === 'meeting-notes') {
    inner = (
      <>
        <div style={wbar('58%', 8, '#C7D2CB')} />
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 1 }}>
          {['#9BC9A8', '#B7BEE8', '#E9C79B'].map((c) => (
            <div
              key={c}
              style={{
                width: 11,
                height: 11,
                borderRadius: '50%',
                background: c,
                marginRight: -3,
                border: '1.5px solid #FFFFFF',
                boxSizing: 'border-box',
              }}
            />
          ))}
          <div style={wbar(30, 5, '#DCE6DF', { marginLeft: 9 })} />
        </div>
        {(['74%', '60%'] as string[]).map((w) => (
          <div key={w} style={row}>
            <div style={{ width: 4, height: 4, borderRadius: 2, background: '#9AA8A0', flexShrink: 0 }} />
            <div style={wbar(w, 6, '#DCE6DF')} />
          </div>
        ))}
        {(['52%', '66%'] as string[]).map((w) => (
          <div key={w} style={row}>
            <div style={box(false)} />
            <div style={wbar(w, 6, '#DCE6DF')} />
          </div>
        ))}
      </>
    );
  } else if (id === 'decision-log') {
    inner = (
      <>
        <div style={wbar('50%', 8, '#C7D2CB')} />
        {(
          [
            [46, '#B7D9C0'],
            [58, '#B7D9C0'],
            [40, '#F0DBA8'],
            [52, '#F0DBA8'],
          ] as [number, string][]
        ).map(([w, c], i) => (
          <div key={i} style={{ ...row, padding: '3px 0', borderTop: '1px solid #EEF3EF' }}>
            <div style={wbar(w, 6, '#DCE6DF')} />
            <div style={{ flex: 1 }} />
            <div style={{ width: 22, height: 8, borderRadius: 999, background: c }} />
          </div>
        ))}
      </>
    );
  } else {
    const node: CSSProperties = {
      width: 30,
      height: 14,
      borderRadius: 3,
      border: '1.5px solid #9AA8A0',
      boxSizing: 'border-box',
    };
    inner = (
      <>
        <div style={wbar('56%', 8, '#C7D2CB')} />
        <div style={wbar('88%', 6, '#DCE6DF')} />
        <div style={wbar('70%', 6, '#DCE6DF')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0' }}>
          <div style={node} />
          <div style={{ width: 14, height: 1.5, background: '#9AA8A0' }} />
          <div style={node} />
          <div style={{ width: 14, height: 1.5, background: '#9AA8A0' }} />
          <div style={node} />
        </div>
        <div
          style={{
            height: 20,
            borderRadius: 4,
            background: '#1E2A22',
            padding: '5px 7px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          <div style={wbar('64%', 3, '#68BA7F')} />
          <div style={wbar('40%', 3, '#8FA396')} />
        </div>
      </>
    );
  }
  return (
    <div
      style={{
        height: 104,
        borderRadius: 8,
        background: '#F1F5F2',
        padding: '9px 12px 0',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          background: '#FFFFFF',
          borderRadius: 6,
          border: '1px solid #E3E8E5',
          padding: '10px 11px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          overflow: 'hidden',
        }}
      >
        {inner}
      </div>
    </div>
  );
}

const WORK = new Set(['blank', 'requirements', 'meeting-notes', 'decision-log', 'technical-design']);

const bar = (w: string | number, h: number, bg = '#DCE6DF', extra?: CSSProperties): CSSProperties => ({
  width: w,
  height: h,
  borderRadius: 3,
  background: bg,
  flexShrink: 0,
  ...extra,
});

const serif = "'Source Serif 4', Georgia, serif";

function Paper({ children, bg = '#FFFFFF', pad = '10px 11px' }: { children: ReactNode; bg?: string; pad?: string }) {
  return (
    <div className="dk-gthumb" aria-hidden="true">
      <div className="dk-gthumb-page" style={{ background: bg, padding: pad }}>
        {children}
      </div>
    </div>
  );
}

/** The first line of a preview, without Markdown marks. */
function firstLine(preview: string): string {
  const line = preview.split('\n').find((l) => l.trim()) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`>[\]]/g, '')
    .trim();
}

/**
 * The drawing of one gallery card.
 * @param props.item - The card.
 */
export function GalleryThumb({ item }: { item: GalleryItem }) {
  if (item.source === 'builtin' && WORK.has(item.id)) return <TemplateThumb id={item.id} />;
  switch (item.source === 'builtin' || item.source === 'canvas' ? item.id : '') {
    case 'canvas':
      return (
        <Paper bg="#F6FAF7" pad="8px">
          <div style={{ position: 'relative', flex: 1 }}>
            {[
              [4, 6, 34, 22],
              [48, 2, 30, 18],
              [26, 34, 40, 20],
            ].map(([l, t, w, h], i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${l}%`,
                  top: t,
                  width: `${w}%`,
                  height: h,
                  borderRadius: 3,
                  background: '#FFFFFF',
                  border: '1px solid #C7D2CB',
                }}
              />
            ))}
          </div>
        </Paper>
      );
    case 'blog-post':
      return (
        <Paper pad="0">
          <div style={{ height: 26, background: 'linear-gradient(120deg,#B7D9C0,#E9C79B)' }} />
          <div style={{ padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
            <div style={{ fontFamily: serif, fontSize: 9.5, fontWeight: 700, color: '#1E2A22', textAlign: 'center' }}>
              What a shared board taught us
            </div>
            <div style={{ fontFamily: serif, fontSize: 8.5, fontStyle: 'italic', color: '#5B6B60' }}>
              A ticket is a promise…
            </div>
            <div style={bar('80%', 4)} />
          </div>
        </Paper>
      );
    case 'book-chapter':
      return (
        <Paper>
          <div style={{ fontSize: 7, letterSpacing: '0.12em', color: '#9AA8A0', textAlign: 'center' }}>CHAPTER ONE</div>
          <div style={{ fontFamily: serif, fontSize: 11, fontWeight: 700, color: '#1E2A22', textAlign: 'center' }}>
            The Long Tide
          </div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'flex-start' }}>
            <div style={{ fontFamily: serif, fontSize: 22, lineHeight: 0.9, fontWeight: 700, color: '#2E6F40' }}>B</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={bar('100%', 4)} />
              <div style={bar('100%', 4)} />
              <div style={bar('92%', 4)} />
            </div>
          </div>
        </Paper>
      );
    case 'short-story':
      return (
        <Paper bg="#FBF8F1">
          <div style={{ fontFamily: serif, fontSize: 11, fontWeight: 700, color: '#1E2A22' }}>The Night Clerk</div>
          <div style={bar('92%', 4, '#E6DECB', { marginLeft: 8 })} />
          <div style={bar('100%', 4, '#E6DECB')} />
          <div style={{ textAlign: 'center', fontSize: 9, color: '#9AA8A0', letterSpacing: '0.3em' }}>* * *</div>
          <div style={bar('88%', 4, '#E6DECB', { marginLeft: 8 })} />
        </Paper>
      );
    case 'newsletter':
      return (
        <Paper pad="0">
          <div style={{ background: '#2E6F40', color: '#FFFFFF', padding: '5px 9px' }}>
            <div style={{ fontSize: 9, fontWeight: 700 }}>The Board Post</div>
            <div style={{ fontSize: 7.5, opacity: 0.8 }}>Issue 14: what shipped</div>
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '7px 9px' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={bar('80%', 4)} />
              <div style={bar('100%', 4)} />
              <div style={bar('70%', 4)} />
            </div>
            <div style={{ width: 30, height: 26, borderRadius: 3, background: '#E9C79B' }} />
          </div>
        </Paper>
      );
    case 'readme':
      return (
        <Paper>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: '#1E2A22' }}>
            kanban-cli
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <div style={{ width: 34, height: 8, borderRadius: 2, background: '#68BA7F' }} />
            <div style={{ width: 20, height: 8, borderRadius: 2, background: '#B7BEE8' }} />
          </div>
          <div style={bar('40%', 5, '#C7D2CB')} />
          <div
            style={{ height: 14, borderRadius: 3, background: '#1E2A22', padding: '4px 6px', boxSizing: 'border-box' }}
          >
            <div style={bar('60%', 3, '#68BA7F')} />
          </div>
        </Paper>
      );
    default: {
      const head = firstLine(item.preview) || item.name;
      return (
        <Paper>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#1E2A22',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {head}
          </div>
          <div style={bar('90%', 5)} />
          <div style={bar('72%', 5)} />
          <div style={bar('48%', 6, '#C7D2CB', { marginTop: 3 })} />
          <div style={bar('84%', 5)} />
        </Paper>
      );
    }
  }
}
