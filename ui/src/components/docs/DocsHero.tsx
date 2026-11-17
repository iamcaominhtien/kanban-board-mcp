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
        padding: phone ? '24px 16px 0' : tablet ? '32px 28px 0' : '44px 48px 0',
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      <div
        style={{ maxWidth: 808, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 0, paddingBottom: 40 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="page" size={15} strokeWidth={1.9} style={{ color: '#2E6F40' }} />
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#5B6B60',
            }}
          >
            Docs space · {projectName}
          </span>
        </div>
        <h1
          style={{
            margin: '10px 0 0',
            fontSize: phone ? 26 : 34,
            fontWeight: 800,
            lineHeight: 1.15,
            letterSpacing: '-0.01em',
            color: '#1E2A22',
            maxWidth: 640,
          }}
        >
          Write down how {projectName} works
        </h1>
        <p style={{ margin: '12px 0 0', fontSize: 15, lineHeight: 1.65, color: '#5B6B60', maxWidth: 600 }}>
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
            marginTop: 22,
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
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12.5, color: '#5B6B60' }}
          >
            <Icon name="i26" size={14} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
            <span>
              Or drag <span className="st-code">.md</span> <span className="st-code">.docx</span>{' '}
              <span className="st-code">.html</span> files, or a whole folder, anywhere on this page.
            </span>
          </div>
        )}
        <div style={{ height: 1, background: '#E3E8E5', margin: phone ? '24px 0 18px' : '30px 0 22px' }} />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>Start from a template</span>
          {!phone && (
            <span style={{ fontSize: 12.5, color: '#5B6B60' }}>You can edit everything after creating the page.</span>
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
                width: phone ? 150 : 147,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
                padding: '9px 9px 12px',
                borderRadius: 12,
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '0 3px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>{t.name}</div>
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
              gap: 10,
              marginTop: 20,
              padding: '12px 14px',
              borderRadius: 10,
              background: '#F6FAF7',
              border: '1px dashed #C7D2CB',
              fontSize: 12.5,
              color: '#5B6B60',
              lineHeight: 1.5,
            }}
          >
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                    {s.label}
                  </button>
                ))}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={() => filesRef.current?.click()}
                data-testid="docs-choose-files"
              >
                Choose files…
              </button>
              <button
                type="button"
                className="st-btn st-btn-sm"
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
