/**
 * One card of the New page gallery: the drawing, the name and what it starts with. A saved template of the caller's
 * has a menu (frame 10): Rename, Share with project / Keep to me, Delete template.
 */

import { useEffect, useRef, useState } from 'react';
import { useTemplateActions } from '../../../api/docsGallery';
import { docsErrorDetail } from '../../../api/docs';
import { extractError } from '../../../api/extractError';
import { Icon } from '../Icon';
import { GalleryThumb } from './GalleryThumb';
import { MAX_TEMPLATE_NAME, templateNameState, type GalleryItem } from './galleryRules';

/** The small line under a saved template's name: who can use it. */
export function savedMark(it: GalleryItem): string | null {
  if (!it.saved) return null;
  if (it.source === 'project') return `Shared by ${it.saved.owner}`;
  return it.saved.scope === 'project' ? 'Yours · this project' : 'Yours · only you';
}

function CardMenu({ projectId, item, onClose }: { projectId: string; item: GalleryItem; onClose: () => void }) {
  const { update, remove } = useTemplateActions(projectId);
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [name, setName] = useState(item.name);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const saved = item.saved!;
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);
  const fail = (e: unknown) => setError(docsErrorDetail(e)?.message ?? extractError(e));
  const nameOk = templateNameState(name) === 'ok';

  return (
    <div
      ref={ref}
      className="dk-menu dk-gal-menu"
      role="menu"
      aria-label={`${item.name} actions`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {mode === 'menu' && (
        <>
          <button type="button" role="menuitem" className="dk-mi" onClick={() => setMode('rename')}>
            <Icon name="i15" size={15} strokeWidth={1.8} />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="dk-mi"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { id: saved.id, scope: saved.scope === 'project' ? 'me' : 'project' },
                { onSuccess: onClose, onError: fail },
              )
            }
          >
            <Icon name={saved.scope === 'project' ? 'lock' : 'i27'} size={15} strokeWidth={1.8} />
            {saved.scope === 'project' ? 'Keep to me' : 'Share with project'}
          </button>
          <div style={{ height: 1, background: '#EEF3EF', margin: '4px 6px' }} />
          <button
            type="button"
            role="menuitem"
            className="dk-mi"
            style={{ color: '#C4432A' }}
            onClick={() => setMode('delete')}
          >
            <Icon name="i12" size={15} strokeWidth={1.8} />
            Delete template
          </button>
        </>
      )}
      {mode === 'rename' && (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 4 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!nameOk) return;
            update.mutate({ id: saved.id, name: name.trim() }, { onSuccess: onClose, onError: fail });
          }}
        >
          <input
            autoFocus
            className="st-input"
            aria-label="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {templateNameState(name) === 'too_long' && (
            <div style={{ fontSize: 11.5, color: '#7A4F08' }}>
              Up to {MAX_TEMPLATE_NAME} characters. {[...name.trim()].length} / {MAX_TEMPLATE_NAME}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="st-btn st-btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="st-btn st-btn-sm st-btn-primary" disabled={!nameOk || update.isPending}>
              Rename
            </button>
          </div>
        </form>
      )}
      {mode === 'delete' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 6, fontSize: 12.5, color: '#3A4A3E' }}>
          <span>
            Delete <b>{item.name}</b>? Pages made from it stay as they are.
          </span>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="st-btn st-btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm st-btn-danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(saved.id, { onSuccess: onClose, onError: fail })}
            >
              Delete template
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12, color: '#C4432A', padding: '4px 6px' }}>
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * A gallery card.
 * @param props.projectId - The project (for the saved template's menu).
 * @param props.item - The card.
 * @param props.selected - The card is the chosen one.
 * @param props.onSelect - Called when the card is chosen (choosing never creates anything).
 * @param props.onOpen - Called on a double click (choose and go on).
 */
export function GalleryCard({
  projectId,
  item,
  selected,
  onSelect,
  onOpen,
}: {
  projectId: string;
  item: GalleryItem;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const mark = savedMark(item);
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        className="dk-gal-card"
        data-testid={`template-${item.id}`}
        onClick={onSelect}
        onDoubleClick={onOpen}
        style={{ width: '100%' }}
      >
        <GalleryThumb item={item} />
        {selected && !item.saved?.mine && (
          <span className="dk-gal-check" aria-hidden="true">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12.5L10 17.5L19 7" />
            </svg>
          </span>
        )}
        <span className="dk-gal-text">
          <span className="dk-gal-name">{item.name}</span>
          {mark ? <span className="dk-gal-mark">{mark}</span> : <span className="dk-gal-desc">{item.description}</span>}
        </span>
      </button>
      {item.saved?.mine && (
        <button
          type="button"
          className="dk-gal-more"
          aria-label={`${item.name}: template actions`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <Icon name="more" size={14} strokeWidth={1.8} />
        </button>
      )}
      {menu && <CardMenu projectId={projectId} item={item} onClose={() => setMenu(false)} />}
    </div>
  );
}
