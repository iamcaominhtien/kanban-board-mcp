/**
 * "Save as a template" (design "Starting and shaping a page", frames 21-23, 48, 49 and 55): a name, a short
 * description, what the template keeps, who can use it and where it is listed. The page itself does not change.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { docsErrorDetail } from '../../../api/docs';
import { galleryKey, saveTemplate } from '../../../api/docsGallery';
import { extractError } from '../../../api/extractError';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsPage } from '../../../types/docs';
import type { GallerySaved, TemplateCategory, TemplateKeeps, TemplateScope } from '../../../types/docsGallery';
import { Icon } from '../Icon';
import { MAX_TEMPLATE_NAME, templateNameState } from './galleryRules';
import './start.css';

const KEEPS: { id: TemplateKeeps; label: string; text: string }[] = [
  { id: 'content', label: 'Style and content', text: 'Text, pictures and blocks stay as they are.' },
  {
    id: 'structure',
    label: 'Style and structure',
    text: 'Headings, layout and cover stay; text becomes prompts you write over.',
  },
  { id: 'style', label: 'Style only', text: 'Width, fonts, colours, cover and header settings.' },
];

const CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: 'writing', label: 'Writing' },
  { id: 'work', label: 'Work' },
  { id: 'ba', label: 'BA' },
];

/** The first words of a page, for the small preview at the top of the dialog. */
function firstWords(page: DocsPage): string {
  const md = page.draft?.markdown ?? page.markdown ?? '';
  const line = md.split('\n').find((l) => l.trim() && !/^#/.test(l.trim())) ?? '';
  return line.replace(/[*_`>[\]#]/g, '').trim();
}

/**
 * The dialog.
 * @param props.projectId - The page's project.
 * @param props.page - The page to save as a template.
 * @param props.layout - Desktop and tablet: a dialog (640 wide with 44 px buttons on a tablet); phone: a full-screen sheet.
 * @param props.onClose - Called to dismiss it.
 * @param props.onSaved - Called with the saved template (the caller shows the toast).
 */
export function SaveTemplateDialog({
  projectId,
  page,
  layout = 'desktop',
  onClose,
  onSaved,
}: {
  projectId: string;
  page: DocsPage;
  layout?: DocsLayout;
  onClose: () => void;
  onSaved: (t: GallerySaved) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(page.title);
  const [description, setDescription] = useState('');
  const [keeps, setKeeps] = useState<TemplateKeeps>('content');
  const [scope, setScope] = useState<TemplateScope>('me');
  const [category, setCategory] = useState<TemplateCategory>('work');
  const [taken, setTaken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const state = templateNameState(name);
  const length = [...name.trim()].length;
  const phone = layout === 'phone';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(replace = false) {
    if (state !== 'ok' || saving) return;
    setSaving(true);
    setError(null);
    try {
      const t = await saveTemplate(projectId, {
        pageId: page.id,
        name: name.trim(),
        description: description.trim() || undefined,
        category,
        keeps,
        scope,
        replace,
      });
      void qc.invalidateQueries({ queryKey: galleryKey(projectId) });
      onSaved(t);
    } catch (e) {
      const d = docsErrorDetail(e);
      if (d?.code === 'name_taken') setTaken(name.trim());
      else setError(d?.message ?? extractError(e));
    } finally {
      setSaving(false);
    }
  }

  const isTaken = taken !== null && taken === name.trim();
  const nameBorder = isTaken
    ? { borderColor: '#C4432A', boxShadow: '0 0 0 3px rgba(196,67,42,0.14)' }
    : state === 'too_long'
      ? { borderColor: '#D9A23A', boxShadow: '0 0 0 3px rgba(217,162,58,0.18)' }
      : undefined;

  return (
    <div
      className="docs-root"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(37,61,44,0.5)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Save as a template"
        className={`dk-st${layout === 'tablet' ? ' dk-st-tablet' : phone ? ' dk-st-phone' : ''}`}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 22px 12px' }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: '#DCEEE1',
              color: '#2E6F40',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon name="i24" size={16} strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Save as a template</div>
            <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>Use this page as the start of new pages</div>
          </div>
          <button type="button" className="dk-icobtn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} strokeWidth={1.8} />
          </button>
        </div>
        <div style={{ padding: '4px 22px 16px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <div
            style={{
              borderRadius: 10,
              border: '1px solid #E3E8E5',
              background: '#FBFCFB',
              padding: '10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>{page.title}</div>
            {firstWords(page) && (
              <div
                style={{
                  fontSize: 12,
                  color: '#5B6B60',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {firstWords(page)}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="st-field-label" htmlFor="docs-tpl-name" style={{ fontSize: 11 }}>
              Name
            </label>
            <input
              id="docs-tpl-name"
              ref={nameRef}
              autoFocus
              className="st-input"
              value={name}
              aria-invalid={isTaken || state === 'too_long'}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
              style={nameBorder}
            />
            {state === 'too_long' && (
              <div data-testid="name-too-long" style={{ display: 'flex', gap: 6, fontSize: 12, color: '#7A4F08' }}>
                <span style={{ flex: 1 }}>Names can have up to {MAX_TEMPLATE_NAME} characters.</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {length} / {MAX_TEMPLATE_NAME}
                </span>
              </div>
            )}
            {isTaken && (
              <div
                role="alert"
                data-testid="name-taken"
                style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: '#A5321E' }}
              >
                <span>
                  A template named <b>{taken}</b> already exists. Choose another name, or replace it.
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="st-btn st-btn-sm"
                    onClick={() => {
                      setTaken(null);
                      nameRef.current?.focus();
                      nameRef.current?.select();
                    }}
                  >
                    Use another name
                  </button>
                  <button
                    type="button"
                    className="st-btn st-btn-sm st-btn-danger"
                    disabled={saving}
                    onClick={() => void save(true)}
                  >
                    Replace
                  </button>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="st-field-label" htmlFor="docs-tpl-desc" style={{ fontSize: 11 }}>
              Short description
            </label>
            <input
              id="docs-tpl-desc"
              className="st-input"
              value={description}
              maxLength={200}
              placeholder="What a page made from it starts with"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="st-field-label" style={{ fontSize: 11 }}>
              What the template keeps
            </span>
            <div className="dk-keeps" role="radiogroup" aria-label="What the template keeps">
              {KEEPS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  role="radio"
                  aria-checked={keeps === k.id}
                  className="dk-keep"
                  onClick={() => setKeeps(k.id)}
                >
                  <span className="dk-keep-dot" />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <b style={{ fontSize: 13, color: '#1E2A22' }}>{k.label}</b>
                    <span style={{ fontSize: 12, color: '#5B6B60' }}>{k.text}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="st-field-label" style={{ fontSize: 11 }}>
                Who can use it
              </span>
              <div className="dk-seg" role="group" aria-label="Who can use it">
                <button type="button" aria-pressed={scope === 'me'} onClick={() => setScope('me')}>
                  Only me
                </button>
                <button type="button" aria-pressed={scope === 'project'} onClick={() => setScope('project')}>
                  This project
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="st-field-label" style={{ fontSize: 11 }}>
                Listed under
              </span>
              <div className="dk-seg" role="group" aria-label="Listed under">
                {CATEGORIES.map((c) => (
                  <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {error && (
            <div role="alert" style={{ fontSize: 12.5, color: '#C4432A', fontWeight: 600 }}>
              {error}
            </div>
          )}
        </div>
        <div className="dk-np-foot">
          {!phone && (
            <span style={{ fontSize: 12, color: '#5B6B60' }}>
              {scope === 'project'
                ? 'Everyone in this project can start a page from it. '
                : 'Only you see it in the gallery. '}
              The page itself does not change.
            </span>
          )}
          {!phone && <div style={{ flex: 1 }} />}
          {!phone && (
            <button type="button" className="st-btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="st-btn st-btn-primary"
            style={phone ? { flex: 1 } : undefined}
            disabled={state !== 'ok' || saving || isTaken}
            onClick={() => void save()}
            data-testid="save-template"
          >
            {saving ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  );
}
