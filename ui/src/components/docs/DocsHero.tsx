import { useRef, type CSSProperties } from 'react';
import { useDocsGallery } from '../../api/docsGallery';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import { Icon } from './Icon';
import { GalleryThumb } from './start/GalleryThumb';
import { IMPORT_SOURCES } from './start/ImportSources';
import type { ImportSource } from './start/importConvert';
import './start/start.css';

export { TemplateThumb } from './start/GalleryThumb';

/** The five templates of the empty space's row (design frame 1): five of the gallery; "All N templates" opens it. */
export const HERO_TEMPLATES = [
  { id: 'blank', name: 'Blank', text: 'Start from an empty page', icon: 'i00' },
  { id: 'blog-post', name: 'Blog post', text: 'Cover, centred title, pull quote', icon: 'page' },
  { id: 'book-chapter', name: 'Book chapter', text: 'Drop cap, justified text', icon: 'page' },
  { id: 'short-story', name: 'Short story', text: 'Serif, indented, scene breaks', icon: 'page' },
  { id: 'technical-design', name: 'Technical design', text: 'Overview, diagram, API, rollout', icon: 'i33' },
] as const;

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  background: '#F6FAF7',
  padding: '1px 5px',
  borderRadius: 3,
  color: '#2E6F40',
};

/** The files the empty space's pickers and drop take: Markdown, Word and HTML. */
const IMPORTABLE = /\.(md|markdown|docx|html?)$/i;

interface Props {
  projectName: string;
  /** The project, for the number of templates in "All N templates". */
  projectId?: string;
  /** The project's ticket key prefix, for the example key ("tickets like MOB-12"). */
  ticketPrefix?: string;
  /** Desktop: a row of five templates; tablet: they scroll sideways; phone: full-width buttons, import as a list. */
  layout?: DocsLayout;
  onCreate: (template?: string) => void;
  /** Opens the New page gallery ("All N templates"); falls back to `onCreate('blank')`. */
  onBrowseTemplates?: () => void;
  /** Opens the import dialog on a source (Markdown when not given). */
  onImport?: (source?: ImportSource) => void;
  onDropFiles?: (files: File[]) => void;
}

/** A grey bar standing for a line of text in a page drawing; `indent` in px. */
function Line({ w = '100%', indent = 0 }: { w?: string; indent?: number }) {
  return <div className="dk-hp-line" style={{ width: w, marginLeft: indent }} />;
}

/**
 * The three page drawings beside the empty space's headline (frame 1): a short story, a technical design and a blog
 * post, tilted and stacked in a 280 × 322 box. Decorative.
 */
function HeroPages() {
  return (
    <div className="dk-hp" aria-hidden="true">
      <div className="dk-hp-sheet" style={{ left: 8, top: 56, transform: 'rotate(-7deg)', zIndex: 1 }}>
        <div className="dk-hp-clip" style={{ width: 180, height: 243 }}>
          <div className="dk-hp-page" style={{ transform: 'scale(0.9)' }}>
            <div className="dk-hp-serif" style={{ fontSize: 13, fontWeight: 600 }}>
              The Night Clerk
            </div>
            <div className="dk-hp-rule" />
            <Line />
            <Line indent={8} />
            <Line indent={8} />
            <Line w="55%" indent={8} />
            <div className="dk-hp-break">* * *</div>
            <Line />
            <Line indent={8} />
            <Line w="70%" indent={8} />
          </div>
        </div>
      </div>
      <div className="dk-hp-sheet" style={{ left: 118, top: 10, transform: 'rotate(5deg)', zIndex: 2 }}>
        <div className="dk-hp-clip" style={{ width: 190, height: 256 }}>
          <div className="dk-hp-page" style={{ transform: 'scale(0.95)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.15, marginBottom: 3 }}>Rate limiting</div>
            <div style={{ marginBottom: 5 }}>
              <span className="dk-hp-badge">Published</span>
            </div>
            <Line />
            <Line w="60%" />
            <div className="dk-hp-note">
              <div className="dk-hp-line" style={{ width: '80%', height: 3, background: '#E0BE7A', margin: 0 }} />
            </div>
            <div className="dk-hp-code">
              <div className="dk-hp-line" style={{ width: '60%', height: 2.5, background: '#8FD3A2' }} />
              <div className="dk-hp-line" style={{ width: '80%', height: 2.5, background: '#A9C7E8' }} />
              <div className="dk-hp-line" style={{ width: '45%', height: 2.5, background: '#F2C98A', margin: 0 }} />
            </div>
            <div style={{ height: 34, borderRadius: 3, border: '1px solid #DCE6DF', background: '#F6FAF7' }} />
          </div>
        </div>
      </div>
      <div className="dk-hp-sheet" style={{ left: 66, top: 44, transform: 'rotate(-1deg)', zIndex: 3 }}>
        <div className="dk-hp-clip" style={{ width: 200, height: 270 }}>
          <div className="dk-hp-page">
            <div
              style={{ margin: '-14px -14px 8px', height: 56, background: 'linear-gradient(120deg,#B7D9C0,#E9C79B)' }}
            />
            <div className="dk-hp-serif" style={{ fontSize: 8.5, fontWeight: 700, textAlign: 'center' }}>
              What a shared board taught us about passing work on
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 7 }}>
              <div className="dk-hp-line" style={{ width: 30, height: 3, background: '#C7D2CB', margin: 0 }} />
            </div>
            <Line />
            <Line w="60%" />
            <div className="dk-hp-quote">A ticket is a promise written for a stranger.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}>
                <Line />
                <Line />
                <Line />
                <Line w="70%" />
              </div>
              <div style={{ width: 52, height: 38, borderRadius: 3, background: '#DCEBDF' }} />
            </div>
            <Line />
            <Line />
            <Line w="60%" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Empty space (design "Starting and shaping a page", frames 1-4): eyebrow, headline, calls to action, a row of
 * templates from the gallery and the import strip (Markdown, Word, HTML, Paste).
 * @param props.projectName - Space name used in the headline.
 * @param props.projectId - The project (the gallery's size).
 * @param props.ticketPrefix - Ticket key prefix of the project, used in the example key.
 * @param props.layout - The Docs layout.
 * @param props.onCreate - Called to create a page, with a template id when one was chosen.
 * @param props.onBrowseTemplates - Opens the whole gallery.
 * @param props.onImport - Called to open the import dialog, with the source chosen.
 * @param props.onDropFiles - Called with files picked with "Choose files…" or "Choose folder…".
 */
export function DocsHero({
  projectName,
  projectId,
  ticketPrefix,
  layout = 'desktop',
  onCreate,
  onBrowseTemplates,
  onImport,
  onDropFiles,
}: Props) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const gallery = useDocsGallery(projectId ?? '');
  const count = gallery.data
    ? gallery.data.builtin.filter((b) => !gallery.data!.hidden.includes(b.id)).length +
      gallery.data.yours.length +
      gallery.data.project.length
    : null;
  const phone = layout === 'phone';
  const tablet = layout === 'tablet';
  const desktop = !phone && !tablet;
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []).filter((f) => IMPORTABLE.test(f.name));
    e.target.value = '';
    if (list.length) onDropFiles?.(list);
  };
  const browse = () => (onBrowseTemplates ? onBrowseTemplates() : onCreate('blank'));
  const shown = phone ? HERO_TEMPLATES.slice(0, 4) : HERO_TEMPLATES;

  return (
    <div
      data-testid="docs-empty"
      style={{
        flex: 1,
        minWidth: 0,
        overflowY: 'auto',
        padding: phone ? '24px 16px 0' : tablet ? '32px 28px 0' : '22px 40px 0',
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      <div
        style={{
          maxWidth: desktop ? 880 : 808,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          paddingBottom: 40,
        }}
      >
        {/* desktop (frame 1): the words on the left, three page drawings on the right (280 × 322) */}
        <div className={desktop ? 'dk-hero-top' : undefined}>
          <div className={desktop ? 'dk-hero-text' : undefined}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="page" size={15} strokeWidth={1.9} style={{ color: '#2E6F40' }} />
              <span
                style={{
                  fontSize: desktop ? 11.5 : 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: desktop ? '0.08em' : '0.06em',
                  color: '#5B6B60',
                }}
              >
                Docs space · {projectName}
              </span>
            </div>
            <h1
              style={{
                margin: desktop ? '14px 0 0' : '10px 0 0',
                fontSize: phone ? 26 : 34,
                fontWeight: 800,
                lineHeight: desktop ? 1.12 : 1.15,
                letterSpacing: desktop ? '-0.02em' : '-0.01em',
                color: '#1E2A22',
                maxWidth: 640,
              }}
            >
              Write down how {projectName} works
            </h1>
            <p
              style={{
                margin: desktop ? '14px 0 0' : '12px 0 0',
                fontSize: 15,
                lineHeight: desktop ? 1.6 : 1.65,
                color: desktop ? '#4A5A4F' : '#5B6B60',
                maxWidth: desktop ? undefined : 600,
              }}
            >
              One shared space for specs, notes and decisions, and for posts, chapters and stories too.
              {!phone && (
                <>
                  {' '}
                  Add colour, pictures that text wraps around, tables and embeds. Link pages to each other with{' '}
                  <code style={codeStyle}>[[Page#Section]]</code> and to tickets like{' '}
                  <code style={codeStyle}>{`${ticketPrefix || 'KAN'}-12`}</code>.
                </>
              )}
            </p>
            <div
              style={{
                display: 'flex',
                flexDirection: phone ? 'column' : 'row',
                alignItems: phone ? 'stretch' : 'center',
                gap: 10,
                marginTop: desktop ? 18 : 22,
              }}
            >
              <button
                type="button"
                className="st-btn st-btn-primary"
                style={{ padding: '11px 18px', fontSize: 14, borderRadius: 10, minHeight: phone ? 48 : undefined }}
                onClick={() => onCreate('blank')}
                data-testid="create-first-page"
              >
                <Icon name="i23" size={17} strokeWidth={1.9} />
                Create the first page
              </button>
              <button
                type="button"
                className="st-btn"
                style={{ padding: '11px 16px', fontSize: 14, borderRadius: 10, minHeight: phone ? 48 : undefined }}
                onClick={() => onImport?.()}
                data-testid="docs-import"
              >
                <Icon name="i26" size={16} strokeWidth={1.9} />
                Import…
              </button>
            </div>
            {!phone && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: desktop ? 18 : 12,
                  fontSize: 12.5,
                  lineHeight: desktop ? 1.9 : undefined,
                  color: '#5B6B60',
                }}
              >
                <Icon name="i26" size={14} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
                <span>
                  Or drag <span className="st-code">.md</span> <span className="st-code">.docx</span>{' '}
                  <span className="st-code">.html</span> files, or a whole folder, anywhere on this page.
                </span>
              </div>
            )}
          </div>
          {desktop && <HeroPages />}
        </div>
        {desktop ? (
          <div style={{ height: 1, background: '#E3E8E5', margin: '20px 0 18px' }} />
        ) : (
          <div style={{ height: 1, background: '#E3E8E5', margin: phone ? '24px 0 18px' : '30px 0 22px' }} />
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: desktop ? 15 : 14, fontWeight: 700, color: '#1E2A22' }}>Start from a template</span>
          {!phone && (
            <span style={{ fontSize: 12.5, color: '#5B6B60', flex: desktop ? 1 : undefined }}>
              You can edit everything after creating the page.
            </span>
          )}
          <button
            type="button"
            onClick={browse}
            data-testid="hero-all-templates"
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'none',
              padding: 4,
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: 600,
              color: '#2E6F40',
              cursor: 'pointer',
            }}
          >
            {count != null ? `All ${count}${phone || tablet ? '' : ' templates'}` : 'All templates'}
          </button>
        </div>
        <div
          className={`dk-hero-tpls${phone || tablet ? ' dk-hero-tpls-scroll' : ''}`}
          style={phone ? { gap: 10 } : undefined}
        >
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              className="dk-hero-card"
              onClick={() => onCreate(t.id)}
              data-testid={`hero-template-${t.id}`}
              style={{
                width: phone ? 150 : 148,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: phone ? 9 : 7,
                padding: phone ? '9px 9px 12px' : '7px 7px 9px',
                borderRadius: phone ? 12 : 11,
                border: '1px solid #E3E8E5',
                background: '#FFFFFF',
                boxSizing: 'border-box',
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              <GalleryThumb
                item={{
                  id: t.id,
                  name: t.name,
                  description: t.text,
                  category: null,
                  source: 'builtin',
                  preview: '',
                  settings: {},
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: phone ? 3 : 1, padding: '0 3px' }}>
                <div style={{ fontSize: phone ? 13 : 12.5, fontWeight: 700, color: '#1E2A22' }}>{t.name}</div>
                {!phone && <div style={{ fontSize: 11.5, lineHeight: 1.4, color: '#5B6B60' }}>{t.text}</div>}
              </div>
            </button>
          ))}
        </div>
        {phone ? (
          <div className="dk-hero-rows" style={{ marginTop: 20 }} data-testid="hero-import-rows">
            {IMPORT_SOURCES.map((s) => (
              <button key={s.id} type="button" onClick={() => onImport?.(s.id)}>
                <Icon
                  name={s.id === 'paste' ? 'i24' : 'i26'}
                  size={16}
                  strokeWidth={1.9}
                  style={{ color: '#2E6F40' }}
                />
                {s.title}
              </button>
            ))}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: tablet ? 'column' : 'row',
              alignItems: tablet ? 'stretch' : 'center',
              gap: tablet ? 10 : 14,
              marginTop: 20,
              padding: tablet ? '12px 14px' : '14px 16px',
              borderRadius: tablet ? 10 : 12,
              background: '#F6FAF7',
              border: tablet ? '1px dashed #C7D2CB' : '1px dashed #BFD2C5',
              fontSize: tablet ? 12.5 : 13,
              color: '#5B6B60',
              lineHeight: 1.5,
            }}
            data-testid="hero-import-strip"
          >
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tablet ? 8 : 9 }}>
              <span>
                <b style={{ color: '#1E2A22', fontWeight: 700 }}>Already have docs somewhere else?</b> Import files or a
                folder: folders become a page tree and <span className="st-code">[[links]]</span> are resolved by title.
              </span>
              <span className="dk-hero-sources" role="group" aria-label="Import from">
                {IMPORT_SOURCES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="dks-chip"
                    aria-label={s.title}
                    data-testid={`hero-import-${s.id}`}
                    onClick={() => onImport?.(s.id)}
                  >
                    {!tablet && <Icon name={s.id === 'paste' ? 'i24' : 'i26'} size={13} strokeWidth={1.9} />}
                    {s.label}
                  </button>
                ))}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8, flex: 'none' }}>
              <button
                type="button"
                className={tablet ? 'st-btn st-btn-sm' : 'st-btn'}
                onClick={() => filesRef.current?.click()}
                data-testid="docs-choose-files"
              >
                Choose files…
              </button>
              <button
                type="button"
                className={tablet ? 'st-btn st-btn-sm' : 'st-btn'}
                onClick={() => folderRef.current?.click()}
                data-testid="docs-choose-folder"
              >
                Choose folder…
              </button>
            </span>
            <input
              ref={filesRef}
              type="file"
              multiple
              accept=".md,.markdown,.docx,.html,.htm"
              hidden
              onChange={picked}
            />
            <input
              ref={folderRef}
              type="file"
              hidden
              onChange={picked}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
