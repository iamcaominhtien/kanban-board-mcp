import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../../api/client';
import { docsErrorDetail, useCreatePage } from '../../api/docs';
import { createFromTemplate, useAfterCreate, useDocsGallery, useLegacyTemplates } from '../../api/docsGallery';
import { docsAiError, useCancelDocsAiJob, useDocsAiJob, useDocsAiState } from '../../api/docsAi';
import { useStartWrite, type WritePreview } from '../../api/docsAiWrite';
import { extractError } from '../../api/extractError';
import { aiGate } from '../../utils/docsAiRules';
import { canWrite, initialWriteForm, writeRequest, type WriteForm, type WriteSourceKind } from '../../utils/writeRules';
import { AiSpark } from './ai/AiSpark';
import { WriteWithAi } from './ai/WriteWithAi';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import type { DocsGallery } from '../../types/docsGallery';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import { Icon } from './Icon';
import { createCanvasPage } from '../../api/canvases';
import { LineIcon } from '../ui/LineIcon';
import { GalleryCard } from './start/GalleryCard';
import {
  GALLERY_CHIPS,
  checkTitle,
  chipCounts,
  filterGallery,
  galleryItems,
  rememberTemplate,
  type GalleryChip,
  type GalleryItem,
} from './start/galleryRules';
import { ParentPicker } from './start/ParentPicker';
import './start/start.css';

interface Props {
  projectId: string;
  nodes: DocsTreeNode[];
  initialParentId: string | null;
  initialTemplate?: string;
  initialTitle?: string;
  /** Opens with Write with AI preselected (e.g. Docs health "Write a page"). */
  aiFrom?: { kind: WriteSourceKind; ticketId?: string; text?: string };
  /** The chip the gallery opens on (`yours` after "Save as template… › Open the gallery"). */
  initialChip?: GalleryChip;
  /** Desktop: grid beside a preview; tablet: the preview folds under the grid; phone: a full-screen sheet in two steps. */
  layout?: DocsLayout;
  onClose: () => void;
  onCreated: (page: DocsPage) => void;
}

const previewHead = { fontSize: 13, fontWeight: 700, color: '#1E2A22', margin: '10px 0 3px' } as const;
const previewText = { fontSize: 12, color: '#9AA8A0', lineHeight: 1.5 } as const;

function TemplatePreview({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <div style={previewHead}>{children}</div>,
        h2: ({ children }) => <div style={previewHead}>{children}</div>,
        h3: ({ children }) => <div style={previewHead}>{children}</div>,
        p: ({ children }) => <div style={previewText}>{children}</div>,
        ul: ({ children }) => <div style={previewText}>{children}</div>,
        ol: ({ children }) => <div style={previewText}>{children}</div>,
        li: ({ children, className }) => (
          <div>
            {className?.includes('task-list-item') ? null : '• '}
            {children}
          </div>
        ),
        input: () => (
          <span>
            <LineIcon name="square" size={12} />{' '}
          </span>
        ),
        code: ({ children }) => <span style={{ fontFamily: 'var(--font-mono)' }}>{children}</span>,
        pre: ({ children }) => <div style={{ ...previewText, fontFamily: 'var(--font-mono)' }}>{children}</div>,
        table: ({ children }) => (
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #E3E8E5' }}>{children}</table>
        ),
        th: ({ children }) => (
          <th style={{ textAlign: 'left', padding: '4px 8px', fontSize: 11, background: '#F6FAF7', color: '#5B6B60' }}>
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td style={{ padding: '4px 8px', borderBottom: '1px solid #EEF3EF', fontSize: 12, color: '#9AA8A0' }}>
            {children}
          </td>
        ),
        blockquote: ({ children }) => <div style={previewText}>{children}</div>,
        a: ({ children }) => <span>{children}</span>,
        strong: ({ children }) => <b>{children}</b>,
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

const WIDTH: Record<string, string> = { narrow: 'Narrow', normal: 'Normal', wide: 'Wide', full: 'Full' };

/** "Serif · Narrow · Paper": the page settings a template starts with, in a few words. */
export function settingsLine(settings: Record<string, unknown>): string {
  const parts: string[] = [];
  const font = typeof settings.bodyFont === 'string' ? settings.bodyFont : '';
  if (/serif|lora|merriweather|playfair/.test(font) || settings.titleStyle === 'serif') parts.push('Serif');
  if (typeof settings.width === 'string' && WIDTH[settings.width]) parts.push(WIDTH[settings.width]);
  if (typeof settings.background === 'string' && settings.background !== 'white')
    parts.push(settings.background.charAt(0).toUpperCase() + settings.background.slice(1));
  if (settings.cover) parts.push('Cover on');
  return parts.join(' · ');
}

/** The gallery from the older template list (a server from before the gallery). */
function legacyGallery(list: { id: string; name: string; description: string; markdown: string }[]): DocsGallery {
  return {
    builtin: list
      .filter((t) => t.id !== 'canvas')
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: 'work' as const,
        settings: {},
        preview: t.markdown,
      })),
    yours: [],
    project: [],
    defaultTemplate: 'blank',
    hidden: [],
  };
}

/**
 * Dialog to create a page from the template gallery (design "Starting and shaping a page", B and G): category chips
 * and a search over a card per template, a preview, the title and the parent; Write with AI is a chip of its own. On a
 * phone it is a full-screen sheet in two steps (pick, then name).
 * @param props.nodes - Page tree, used to pick the parent and to check the title.
 * @param props.initialParentId - Preselected parent, or `null` for top level.
 * @param props.initialTemplate - Preselected template id.
 * @param props.initialTitle - Prefilled title.
 * @param props.aiFrom - Opens on Write with AI with this source.
 * @param props.initialChip - The chip the gallery opens on.
 * @param props.layout - The Docs layout (desktop when not given).
 * @param props.onClose - Called to dismiss the dialog.
 * @param props.onCreated - Called with the new page.
 */
export function NewPageDialog({
  projectId,
  nodes,
  initialParentId,
  initialTemplate = 'blank',
  initialTitle,
  aiFrom,
  initialChip = 'all',
  layout = 'desktop',
  onClose,
  onCreated,
}: Props) {
  const gallery = useDocsGallery(projectId);
  const legacy = useLegacyTemplates(gallery.isError);
  const items = useMemo<GalleryItem[]>(() => {
    if (gallery.data) return galleryItems(gallery.data);
    if (legacy.data) return galleryItems(legacyGallery(legacy.data));
    return [];
  }, [gallery.data, legacy.data]);
  const loading = !gallery.data && !legacy.data && (gallery.isLoading || legacy.isLoading);
  const create = useCreatePage(projectId);
  const afterCreate = useAfterCreate(projectId);
  const [creating, setCreating] = useState(false);
  const [chip, setChip] = useState<GalleryChip | 'ai'>(aiFrom ? 'ai' : initialChip);
  const [query, setQuery] = useState('');
  const [template, setTemplate] = useState(initialTemplate);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [titleTouched, setTitleTouched] = useState(!!initialTitle);
  const [titleFocus, setTitleFocus] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [pickOpen, setPickOpen] = useState(false);
  const [step, setStep] = useState<'pick' | 'name'>('pick');
  const [error, setError] = useState<string | null>(null);
  const phone = layout === 'phone';
  const tpl = items.find((t) => t.id === template);
  const aiState = useDocsAiState(projectId);
  const gate = aiGate(aiState.data);
  const aiReady = gate.show && gate.reason === null;
  const [aiKind, setAiKind] = useState<WriteSourceKind | null>(aiFrom?.kind ?? null);
  const [form, setForm] = useState<WriteForm>(() => initialWriteForm(aiFrom?.kind ?? 'ticket', aiFrom));
  const startWrite = useStartWrite(projectId);
  const cancelJob = useCancelDocsAiJob();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useDocsAiJob(jobId);
  const writing = !!jobId && (!job.data || job.data.state === 'queued' || job.data.state === 'running');
  const aiOn = aiReady && chip === 'ai' && aiKind !== null;
  const counts = useMemo(() => chipCounts(items), [items]);
  const shown = useMemo(() => (chip === 'ai' ? [] : filterGallery(items, chip, query)), [items, chip, query]);

  function pickAi(kind: WriteSourceKind) {
    setAiKind(kind);
    setForm((f) =>
      f.kind === kind ? f : initialWriteForm(kind, { text: f.kind === 'notes' || f.kind === 'prompt' ? f.text : '' }),
    );
  }
  function pickChip(c: GalleryChip | 'ai') {
    setChip(c);
    if (c === 'ai' && aiKind === null) pickAi(form.kind);
  }
  function onPreview(p: WritePreview | undefined) {
    if (p?.suggestedTitle && !titleTouched) setTitle(p.suggestedTitle);
  }

  // the job finished: open the draft it made
  useEffect(() => {
    const j = job.data;
    if (!j) return;
    if (j.state === 'failed' || j.state === 'cancelled') {
      setError(j.error.message ?? 'The AI could not write the draft.');
      setJobId(null);
      return;
    }
    const pageId = typeof j.result.pageId === 'string' ? j.result.pageId : null;
    if (j.state !== 'finished' || !pageId) return;
    setJobId(null);
    void client
      .get<DocsPage>(`/docs/pages/${pageId}`)
      .then((r) => onCreated(r.data))
      .catch((err: unknown) => setError(extractError(err)));
  }, [job.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // a template the gallery does not list (hidden in this project, or deleted) starts on Blank
  useEffect(() => {
    if (items.length && !items.some((t) => t.id === template)) setTemplate('blank');
  }, [items, template]);

  // the title defaults to the template name until the user types their own
  useEffect(() => {
    if (!titleTouched && tpl) setTitle(tpl.id === 'blank' ? '' : tpl.name);
  }, [tpl, titleTouched]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pickOpen) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pickOpen]);

  const check = checkTitle(nodes, parentId, title, titleTouched || submitted);
  const { trimmed, empty, clash, nextAddress } = check;
  const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null;

  async function submit() {
    if (!trimmed) {
      setSubmitted(true);
      if (phone) setStep('name');
      return;
    }
    setError(null);
    if (aiOn) {
      if (!canWrite(form, trimmed)) return;
      try {
        const j = await startWrite.mutateAsync(writeRequest(form, trimmed, parentId));
        setJobId(j.id);
      } catch (err) {
        setError(docsAiError(err)?.detail ?? docsErrorDetail(err)?.message ?? extractError(err));
      }
      return;
    }
    setCreating(true);
    try {
      if (template === 'canvas') {
        const made = await createCanvasPage({ projectId, title: trimmed, parentId });
        onCreated((await client.get<DocsPage>(`/docs/pages/${made.page.id}`)).data);
        return;
      }
      // Blank, and every template while the gallery cannot be read, go the way they always went
      if (template === 'blank' || !gallery.data) {
        onCreated(await create.mutateAsync({ title: trimmed, parentId, template }));
        return;
      }
      const page = await createFromTemplate(projectId, { title: trimmed, parentId, template });
      afterCreate();
      if (tpl) rememberTemplate({ id: tpl.id, name: tpl.name });
      onCreated(page);
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    } finally {
      setCreating(false);
    }
  }

  const titleBorder = empty
    ? { borderColor: '#C4432A', boxShadow: '0 0 0 3px rgba(196,67,42,0.14)' }
    : titleFocus
      ? { borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' }
      : clash
        ? { borderColor: '#E3C27A' }
        : null;

  const aiChip = aiReady ? (
    <button
      type="button"
      className="dk-chip dk-chip-ai"
      aria-pressed={chip === 'ai'}
      data-testid="chip-ai"
      onClick={() => pickChip('ai')}
    >
      <AiSpark size={13} />
      Write with AI
    </button>
  ) : null;

  const chips = (
    <div className="dk-chips" role="group" aria-label="Template categories">
      {!phone && aiChip}
      {GALLERY_CHIPS.map((c) => (
        <button
          key={c.id}
          type="button"
          className="dk-chip"
          aria-pressed={chip === c.id}
          data-testid={`chip-${c.id}`}
          onClick={() => pickChip(c.id)}
        >
          {c.label}
          {!phone && <span className="dk-chip-n">{counts[c.id]}</span>}
        </button>
      ))}
      {phone && aiChip}
      {!phone && chip !== 'ai' && (
        <div className="dk-np-search" style={{ marginLeft: 'auto' }}>
          <Icon name="search" size={13} strokeWidth={2} style={{ color: '#9AA8A0' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a template…"
            aria-label="Find a template"
          />
        </div>
      )}
    </div>
  );

  const emptyState =
    chip === 'yours' && !query.trim() && counts.yours === 0 ? (
      <div className="dk-gal-empty" data-testid="gallery-none-yours">
        <Icon name="i24" size={22} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
        <b>You have no templates yet</b>
        <span>
          Open the menu of any page and choose Save as template. It will show up here for you, or for everyone in this
          project.
        </span>
        <button type="button" className="st-btn st-btn-sm" onClick={() => setChip('all')}>
          Browse all templates
        </button>
      </div>
    ) : (
      <div className="dk-gal-empty" data-testid="gallery-no-match">
        <Icon name="search" size={22} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
        <b>{query.trim() ? `No templates match “${query.trim()}”` : 'No templates here yet'}</b>
        <span>Try another word, or start from a blank page.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {query.trim() && (
            <button type="button" className="st-btn st-btn-sm" onClick={() => setQuery('')}>
              Clear search
            </button>
          )}
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            onClick={() => {
              setQuery('');
              setChip('all');
              setTemplate('blank');
            }}
          >
            Start with Blank
          </button>
        </div>
      </div>
    );

  const grid = (
    <div role="radiogroup" aria-label="Template" data-testid="template-list" className="dk-np-grid">
      {loading && <div className="dk-gal-empty">Loading templates…</div>}
      {!loading && shown.length === 0 && emptyState}
      {shown.map((t) => (
        <GalleryCard
          key={t.id}
          projectId={projectId}
          item={t}
          selected={template === t.id}
          onSelect={() => setTemplate(t.id)}
          onOpen={() => (phone ? setStep('name') : undefined)}
        />
      ))}
    </div>
  );

  const preview = (
    <div className="dk-np-preview" data-testid="template-preview">
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#5B6B60',
          marginBottom: 6,
        }}
      >
        Preview · {tpl?.name ?? ''}
      </div>
      {tpl?.description && (
        <div style={{ fontSize: 12.5, color: '#3A4A3E', lineHeight: 1.45, marginBottom: 6 }}>{tpl.description}</div>
      )}
      {tpl && settingsLine(tpl.settings) && (
        <div style={{ fontSize: 11.5, fontWeight: 600, color: '#2E6F40', marginBottom: 4 }}>
          {settingsLine(tpl.settings)}
        </div>
      )}
      {tpl && tpl.preview ? (
        tpl.source === 'builtin' ? (
          <TemplatePreview markdown={tpl.preview} />
        ) : (
          <div style={{ ...previewText, whiteSpace: 'pre-wrap' }}>{tpl.preview}</div>
        )
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10, fontSize: 12, color: '#9AA8A0' }}>
          <span className="dk-caret" style={{ height: 13, background: '#9AA8A0' }} />
          {tpl?.id === 'canvas' ? 'Boards on one large plane' : 'Type / to start'}
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 46,
          background: 'linear-gradient(rgba(255,255,255,0),#FFFFFF)',
        }}
      />
    </div>
  );

  const aiPane = (
    <>
      <div
        role="group"
        aria-label="Write with AI"
        style={{ width: phone ? '100%' : 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {(
          [
            ['ticket', 'From a ticket', 'i00'],
            ['idea', 'From an idea', 'i17'],
            ['notes', 'From pasted notes', 'i32'],
            ['prompt', 'From a prompt', 'spark'],
          ] as const
        ).map(([kind, text, icon]) => {
          const sel = aiKind === kind;
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={sel}
              data-testid={`write-ai-${kind}`}
              onClick={() => pickAi(kind)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '8px 10px',
                minHeight: phone ? 44 : undefined,
                borderRadius: 8,
                border: '1px solid',
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
                fontSize: 13,
                fontWeight: sel ? 600 : 500,
                color: '#1E2A22',
                background: sel ? '#F1EAFF' : 'transparent',
                borderColor: sel ? '#C9B6FF' : 'transparent',
              }}
            >
              <span style={{ display: 'flex', color: sel ? '#5B3AA6' : '#5B6B60' }}>
                {icon === 'spark' ? <AiSpark size={16} /> : <Icon name={icon} size={16} strokeWidth={1.8} />}
              </span>
              {text}
            </button>
          );
        })}
      </div>
      {aiOn && <WriteWithAi projectId={projectId} form={form} onForm={setForm} onPreview={onPreview} error={null} />}
    </>
  );

  const fields = (
    <>
      <div className="dk-np-fields">
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="st-field-label" htmlFor="docs-new-title" style={{ fontSize: 11 }}>
            Title
          </label>
          <input
            id="docs-new-title"
            autoFocus={!phone}
            className="st-input"
            value={title}
            placeholder="Page title"
            aria-label="Title"
            aria-invalid={empty}
            onFocus={() => setTitleFocus(true)}
            onBlur={() => setTitleFocus(false)}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleTouched(true);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            style={titleBorder ?? undefined}
          />
          {empty && (
            <div
              role="alert"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#C4432A' }}
            >
              <Icon name="i22" size={13} strokeWidth={2} />
              Give the page a title to create it.
            </div>
          )}
          {clash && !empty && (
            <div
              data-testid="title-clash"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                fontSize: 12,
                lineHeight: 1.45,
                color: '#7A4F08',
              }}
            >
              <Icon name="i14" size={13} strokeWidth={2} style={{ color: '#B4791E', marginTop: 1 }} />
              <span>
                A page named <b>{trimmed}</b> already exists under {parentNode ? parentNode.title : 'the top level'}.
                You can still create it; the new page gets the address <span className="st-code">{nextAddress}</span>.
              </span>
            </div>
          )}
        </div>
        <div style={{ width: phone ? '100%' : 250, flexShrink: 0 }}>
          <ParentPicker nodes={nodes} parentId={parentId} onChange={setParentId} onOpenChange={setPickOpen} />
        </div>
      </div>
      {!aiOn && (
        <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.5 }}>
          The new page will be placed at the end of{' '}
          {parentNode ? <b style={{ color: '#1E2A22', fontWeight: 700 }}>{parentNode.title}</b> : 'the top level'}. You
          can drag it elsewhere later.
        </div>
      )}
    </>
  );

  const showFields = !phone || step === 'name' || chip === 'ai';
  const busy = creating || create.isPending;
  const createButton = aiOn ? (
    <button
      type="button"
      className="st-btn st-btn-sm st-btn-primary"
      style={{ background: '#7C5CD6', borderColor: '#7C5CD6', flex: phone ? 1 : undefined }}
      disabled={writing || startWrite.isPending || !canWrite(form, title)}
      onClick={() => void submit()}
      data-testid="write-draft"
    >
      <AiSpark size={14} />
      {writing || startWrite.isPending ? 'Writing…' : 'Write draft'}
    </button>
  ) : phone && step === 'pick' ? (
    <button
      type="button"
      className="st-btn st-btn-primary"
      style={{ flex: 1 }}
      disabled={!tpl}
      onClick={() => setStep('name')}
      data-testid="next-name-it"
    >
      Next: name it
    </button>
  ) : (
    <button
      type="button"
      className="st-btn st-btn-primary"
      style={phone ? { flex: 1 } : undefined}
      disabled={busy}
      onClick={() => void submit()}
      data-testid="create-page"
    >
      <Icon name="plus" size={14} strokeWidth={1.9} />
      {busy ? 'Creating…' : 'Create page'}
    </button>
  );

  return (
    <div
      className="docs-root"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(37,61,44,0.5)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New page"
        className={`dk-np${layout === 'tablet' ? ' dk-np-tablet' : phone ? ' dk-np-phone' : ''}`}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 22px 12px' }}>
          {phone && step === 'name' && chip !== 'ai' ? (
            <button
              type="button"
              className="dk-icobtn"
              aria-label="Back to the templates"
              onClick={() => setStep('pick')}
            >
              <Icon name="chevronRight" size={16} strokeWidth={1.9} style={{ transform: 'rotate(180deg)' }} />
            </button>
          ) : (
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: chip === 'ai' ? '#F1EAFF' : '#DCEEE1',
                color: chip === 'ai' ? '#5B3AA6' : '#2E6F40',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {chip === 'ai' ? <AiSpark size={16} /> : <Icon name="i23" size={16} strokeWidth={1.8} />}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>
              {phone && step === 'name' && chip !== 'ai' ? (tpl?.name ?? 'New page') : 'New page'}
            </div>
            {!phone && (
              <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>
                {chip === 'ai'
                  ? 'Write with AI'
                  : chip === 'yours'
                    ? 'Your templates'
                    : 'Choose a template, then name the page'}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: 'none',
              background: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#9AA8A0',
            }}
          >
            <Icon name="close" size={16} strokeWidth={1.8} />
          </button>
        </div>
        <div className="dk-np-body">
          {(!phone || step === 'pick' || chip === 'ai') && chips}
          {phone && step === 'pick' && chip !== 'ai' && (
            <div className="dk-np-search">
              <Icon name="search" size={13} strokeWidth={2} style={{ color: '#9AA8A0' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a template…"
                aria-label="Find a template"
              />
            </div>
          )}
          {chip === 'ai' ? (
            <div className="dk-np-main">{aiPane}</div>
          ) : phone ? (
            step === 'pick' ? (
              grid
            ) : (
              preview
            )
          ) : (
            <div className="dk-np-main">
              {grid}
              {preview}
            </div>
          )}
          {chip === 'yours' && counts.yours > 0 && !phone && (
            <div style={{ fontSize: 12, color: '#5B6B60' }}>
              Save a page as a template from its page menu. Templates you save keep the page style and what you chose.
            </div>
          )}
          {showFields && fields}
          {error && (
            <div role="alert" style={{ fontSize: 12.5, color: '#C4432A', fontWeight: 600 }}>
              {error}
            </div>
          )}
        </div>
        <div className="dk-np-foot">
          {(!phone || step === 'name') && (
            <span style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45 }}>
              {writing
                ? (job.data?.steps[(job.data?.steps.length ?? 1) - 1]?.text ?? 'Starting…')
                : aiOn
                  ? 'The draft is private to you until you publish it.'
                  : 'Created as a draft. Only you can see it until you publish.'}
            </span>
          )}
          {!phone && <div style={{ flex: 1 }} />}
          {!phone && (
            <button
              type="button"
              className={aiOn ? 'st-btn st-btn-sm' : 'st-btn'}
              onClick={() => {
                if (jobId) cancelJob.mutate(jobId);
                onClose();
              }}
            >
              Cancel
            </button>
          )}
          {createButton}
        </div>
      </div>
    </div>
  );
}
