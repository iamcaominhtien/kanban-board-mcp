/**
 * The small drawing on a gallery card (design "Starting and shaping a page", frames 1 and 5): each template drawn
 * with the blocks it starts with. The work templates reuse the empty space's drawings; a saved or BA template is
 * drawn from the first words of its text.
 */

import type { CSSProperties, ReactNode } from 'react';
import { TemplateThumb } from '../DocsHero';
import type { GalleryItem } from './galleryRules';

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
