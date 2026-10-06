import { useRef, type CSSProperties } from 'react';
import { Icon } from './Icon';

export const HERO_TEMPLATES = [
  { id: 'blank', name: 'Blank', text: 'Start from an empty page', icon: 'i00' },
  { id: 'requirements', name: 'Requirements', text: 'Goals, scope and criteria', icon: 'i13' },
  { id: 'meeting-notes', name: 'Meeting notes', text: 'Attendees, notes, action items', icon: 'i32' },
  { id: 'decision-log', name: 'Decision log', text: 'Context, options, outcome', icon: 'i17' },
  { id: 'technical-design', name: 'Technical design', text: 'Overview, diagram, API, rollout', icon: 'i33' },
] as const;

const bar = (w: string | number, h: number, bg: string, extra?: CSSProperties): CSSProperties => ({ width: w, height: h, borderRadius: 3, background: bg, flexShrink: 0, ...extra });
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const box = (done: boolean): CSSProperties =>
  done
    ? { width: 9, height: 9, borderRadius: 2.5, background: '#2E6F40', flexShrink: 0 }
    : { width: 9, height: 9, borderRadius: 2.5, border: '1.5px solid #B7C4BC', boxSizing: 'border-box', flexShrink: 0 };

/** The 104px mini preview of a template, as drawn on the board. */
export function TemplateThumb({ id }: { id: string }) {
  let inner: React.ReactNode = null;
  if (id === 'blank') {
    inner = (
      <>
        <div style={bar('46%', 8, '#C7D2CB')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 6, fontSize: 11, color: '#9AA8A0' }}>
          <span className="dk-caret" style={{ height: 12 }} />
          Type / to start
        </div>
      </>
    );
  } else if (id === 'requirements') {
    inner = (
      <>
        <div style={bar('52%', 8, '#C7D2CB')} />
        <div style={bar('90%', 6, '#DCE6DF')} />
        {([[true, '64%'], [true, '72%'], [false, '58%'], [false, '68%']] as [boolean, string][]).map(([d, w], i) => (
          <div key={i} style={row}>
            <div style={box(d)} />
            <div style={bar(w, 6, '#DCE6DF')} />
          </div>
        ))}
      </>
    );
  } else if (id === 'meeting-notes') {
    inner = (
      <>
        <div style={bar('58%', 8, '#C7D2CB')} />
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 1 }}>
          {['#9BC9A8', '#B7BEE8', '#E9C79B'].map((c) => (
            <div key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c, marginRight: -3, border: '1.5px solid #FFFFFF', boxSizing: 'border-box' }} />
          ))}
          <div style={bar(30, 5, '#DCE6DF', { marginLeft: 9 })} />
        </div>
        {(['74%', '60%'] as string[]).map((w) => (
          <div key={w} style={row}>
            <div style={{ width: 4, height: 4, borderRadius: 2, background: '#9AA8A0', flexShrink: 0 }} />
            <div style={bar(w, 6, '#DCE6DF')} />
          </div>
        ))}
        {(['52%', '66%'] as string[]).map((w) => (
          <div key={w} style={row}>
            <div style={box(false)} />
            <div style={bar(w, 6, '#DCE6DF')} />
          </div>
        ))}
      </>
    );
  } else if (id === 'decision-log') {
    inner = (
      <>
        <div style={bar('50%', 8, '#C7D2CB')} />
        {([[46, '#B7D9C0'], [58, '#B7D9C0'], [40, '#F0DBA8'], [52, '#F0DBA8']] as [number, string][]).map(([w, c], i) => (
          <div key={i} style={{ ...row, padding: '3px 0', borderTop: '1px solid #EEF3EF' }}>
            <div style={bar(w, 6, '#DCE6DF')} />
            <div style={{ flex: 1 }} />
            <div style={{ width: 22, height: 8, borderRadius: 999, background: c }} />
          </div>
        ))}
      </>
    );
  } else {
    const node: CSSProperties = { width: 30, height: 14, borderRadius: 3, border: '1.5px solid #9AA8A0', boxSizing: 'border-box' };
    inner = (
      <>
        <div style={bar('56%', 8, '#C7D2CB')} />
        <div style={bar('88%', 6, '#DCE6DF')} />
        <div style={bar('70%', 6, '#DCE6DF')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0' }}>
          <div style={node} />
          <div style={{ width: 14, height: 1.5, background: '#9AA8A0' }} />
          <div style={node} />
          <div style={{ width: 14, height: 1.5, background: '#9AA8A0' }} />
          <div style={node} />
        </div>
        <div style={{ height: 20, borderRadius: 4, background: '#1E2A22', padding: '5px 7px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={bar('64%', 3, '#68BA7F')} />
          <div style={bar('40%', 3, '#8FA396')} />
        </div>
      </>
    );
  }
  return (
    <div style={{ height: 104, borderRadius: 8, background: '#F1F5F2', padding: '9px 12px 0', boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: '#FFFFFF', borderRadius: 6, border: '1px solid #E3E8E5', padding: '10px 11px', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
        {inner}
      </div>
    </div>
  );
}

const codeStyle: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12.5, background: '#F6FAF7', padding: '1px 5px', borderRadius: 3, color: '#2E6F40' };

interface Props {
  projectName: string;
  onCreate: (template?: string) => void;
  onImport?: () => void;
  onDropFiles?: (files: File[]) => void;
}

/** Empty space (A): eyebrow, headline, calls to action, template gallery and the import strip. */
export function DocsHero({ projectName, onCreate, onImport, onDropFiles }: Props) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []).filter((f) => /\.(md|markdown)$/i.test(f.name));
    e.target.value = '';
    if (list.length) onDropFiles?.(list);
  };
  return (
    <div data-testid="docs-empty" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '44px 48px 0', boxSizing: 'border-box', position: 'relative' }}>
      <div style={{ maxWidth: 808, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 0, paddingBottom: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="page" size={15} strokeWidth={1.9} style={{ color: '#2E6F40' }} />
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#5B6B60' }}>Docs space · {projectName}</span>
        </div>
        <h1 style={{ margin: '10px 0 0', fontSize: 34, fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.01em', color: '#1E2A22', maxWidth: 640 }}>Write down how {projectName} works</h1>
        <p style={{ margin: '12px 0 0', fontSize: 15, lineHeight: 1.65, color: '#5B6B60', maxWidth: 600 }}>
          One shared space for requirements, designs and decisions. Link pages to each other with <code style={codeStyle}>[[Page#Section]]</code> and to tickets like <code style={codeStyle}>KAN-12</code>, and they stay connected as the project changes.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22 }}>
          <button type="button" className="st-btn st-btn-primary" style={{ padding: '11px 18px', fontSize: 14, borderRadius: 10 }} onClick={() => onCreate('blank')} data-testid="create-first-page">
            <Icon name="i23" size={17} strokeWidth={1.9} />
            Create the first page
          </button>
          <button type="button" className="st-btn" style={{ padding: '11px 16px', fontSize: 14, borderRadius: 10 }} onClick={onImport} data-testid="docs-import">
            <Icon name="i26" size={16} strokeWidth={1.9} />
            Import Markdown
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12.5, color: '#5B6B60' }}>
          <Icon name="i26" size={14} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
          Or drag <span className="st-code">.md</span> files, or a whole folder, anywhere on this page.
        </div>
        <div style={{ height: 1, background: '#E3E8E5', margin: '30px 0 22px' }} />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>Start from a template</span>
          <span style={{ fontSize: 12.5, color: '#5B6B60' }}>You can edit everything after creating the page.</span>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {HERO_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="dk-hero-card"
              onClick={() => onCreate(t.id)}
              data-testid={`hero-template-${t.id}`}
              style={{ width: 147, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 9, padding: '9px 9px 12px', borderRadius: 12, border: '1px solid #E3E8E5', background: '#FFFFFF', boxSizing: 'border-box', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
            >
              <TemplateThumb id={t.id} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '0 3px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>{t.name}</div>
                <div style={{ fontSize: 11.5, lineHeight: 1.4, color: '#5B6B60' }}>{t.text}</div>
              </div>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, padding: '12px 14px', borderRadius: 10, background: '#F6FAF7', border: '1px dashed #C7D2CB', fontSize: 12.5, color: '#5B6B60', lineHeight: 1.5 }}>
          <span style={{ color: '#2E6F40', display: 'flex' }}><Icon name="i18" size={18} strokeWidth={1.8} /></span>
          <span style={{ flex: 1 }}>
            <b style={{ color: '#1E2A22', fontWeight: 700 }}>Already have docs in Markdown?</b> Import files or a folder: folders become a page tree and <span className="st-code">[[links]]</span> are resolved by title.
          </span>
          <button type="button" className="st-btn st-btn-sm" onClick={() => filesRef.current?.click()} data-testid="docs-choose-files">Choose files…</button>
          <button type="button" className="st-btn st-btn-sm" onClick={() => folderRef.current?.click()} data-testid="docs-choose-folder">Choose folder…</button>
          <input ref={filesRef} type="file" multiple accept=".md,.markdown" hidden onChange={picked} />
          <input ref={folderRef} type="file" hidden onChange={picked} {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} />
        </div>
      </div>
    </div>
  );
}
