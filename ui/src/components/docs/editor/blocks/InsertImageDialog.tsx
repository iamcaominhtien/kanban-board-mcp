/**
 * Insert image (board D 14–16): Upload (drop or choose; several files go in one under the other), Link (by address,
 * with a preview and "Save a copy in this project") and Project files (pictures already on this page or in the
 * project's tickets). Also Replace on a selected image: the same dialog, which keeps the image's place, size and
 * caption.
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTickets } from '../../../../api/tickets';
import { setNodeAttrs } from './commands';
import { IMAGE_TYPES, isImageFile, startImageUpload } from './imageUpload';
import { Dialog, Toggle, formatBytes } from './ui';

type Tab = 'upload' | 'link' | 'files';

/** A picture the project already has. */
interface ProjectFile {
  src: string;
  name: string;
  /** Where it is used: a ticket key, or "Docs" for this page. */
  where: string;
  kind: 'ticket' | 'doc';
}

const IMG_MD = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const IMG_HTML = /<img[^>]+src=["']([^"']+)["']/g;

/** The file name at the end of an address. */
export function fileNameOf(src: string): string {
  try {
    const u = new URL(src, 'http://x');
    return decodeURIComponent(u.searchParams.get('name') || u.pathname.split('/').pop() || src);
  } catch {
    return src;
  }
}

/** "JPG" for `…/hanoi-office.jpg`, else the picture type's subtype ("image/png" gives "PNG"); "" when neither. */
export function imageKind(src: string, type?: string | null): string {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(fileNameOf(src))?.[1];
  if (ext) return ext.toUpperCase().replace('JPEG', 'JPG');
  const sub = type?.startsWith('image/') ? type.slice(6).replace(/\+.*$/, '') : '';
  return sub.toUpperCase().replace('JPEG', 'JPG');
}

/** The tabs' icons (board D 14-16): upload arrow, link, folder. */
const TAB_ICON: Record<Tab, ReactNode> = {
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  files: <path d="M3 6h6l2 2h10v11H3z" />,
};

/** The picture addresses in a Markdown text (`![…](src)` and `<img src>`). */
export function imagesInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IMG_MD)) out.add(m[1]);
  for (const m of text.matchAll(IMG_HTML)) out.add(m[1]);
  return [...out].filter((s) => !s.startsWith('uploading:'));
}

/**
 * The dialog.
 * @param props.replacePos - Replace the picture of the image at this position instead of inserting one.
 * @param props.limitMb - The project's image limit in MB.
 */
export function InsertImageDialog({
  editor,
  projectId,
  replacePos,
  limitMb,
  onClose,
}: {
  editor: Editor;
  projectId: string;
  replacePos?: number;
  limitMb: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('upload');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<{ w: number; h: number } | null | 'error'>(null);
  // the picture's size and type when the site answers a HEAD request (it often does not: then they are left out)
  const [head, setHead] = useState<{ bytes: number | null; type: string | null } | null>(null);
  const [saveCopy, setSaveCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'ticket' | 'doc'>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const tickets = useTickets(projectId);
  const typed = url.trim();
  useEffect(() => {
    setHead(null);
    if (!/^https?:\/\//i.test(typed) && !typed.startsWith('/')) return undefined;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      fetch(typed, { method: 'HEAD', signal: ctl.signal })
        .then((r) => {
          if (!r.ok) return;
          const len = Number(r.headers.get('content-length'));
          setHead({ bytes: Number.isFinite(len) && len > 0 ? len : null, type: r.headers.get('content-type') });
        })
        .catch(() => {});
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [typed]);

  const files = useMemo<ProjectFile[]>(() => {
    const out: ProjectFile[] = [];
    const seen = new Set<string>();
    editor.state.doc.descendants((n) => {
      const src = typeof n.attrs.src === 'string' ? n.attrs.src : '';
      if (n.type.name === 'image' && src && !src.startsWith('uploading:') && !seen.has(src)) {
        seen.add(src);
        out.push({ src, name: fileNameOf(src), where: 'Docs', kind: 'doc' });
      }
    });
    for (const t of tickets.data ?? []) {
      for (const src of imagesInText(t.description ?? '')) {
        if (seen.has(src)) continue;
        seen.add(src);
        out.push({ src, name: fileNameOf(src), where: t.id, kind: 'ticket' });
      }
    }
    return out;
  }, [editor, tickets.data]);
  const shown = files.filter(
    (f) =>
      (filter === 'all' || f.kind === filter) &&
      (!q.trim() || `${f.name} ${f.where}`.toLowerCase().includes(q.trim().toLowerCase())),
  );

  const replacing = replacePos != null;
  const putSrc = (srcs: string[]) => {
    if (!srcs.length) return;
    if (replacing) setNodeAttrs(editor, replacePos, { src: srcs[0], crop: null });
    else
      editor
        .chain()
        .focus()
        .insertContent(
          srcs.map((src) => ({ type: 'image', attrs: { src, alt: fileNameOf(src).replace(/\.[^.]+$/, '') } })),
        )
        .run();
    onClose();
  };
  const upload = (list: File[]) => {
    const pics = list.filter(isImageFile);
    if (!pics.length) return;
    if (replacing) startImageUpload(editor, pics[0], { replacePos, limitMb });
    else for (const f of pics) startImageUpload(editor, f, { limitMb });
    onClose();
  };
  const insertLink = async () => {
    const src = url.trim();
    if (!src) return;
    if (saveCopy) {
      setBusy(true);
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        if (!res.ok || !blob.type.startsWith('image/')) throw new Error('not a picture');
        upload([new File([blob], fileNameOf(src), { type: blob.type })]);
        return;
      } catch {
        // the site does not let the browser read the picture: link to it instead
      } finally {
        setBusy(false);
      }
    }
    putSrc([src]);
  };

  return (
    <Dialog
      title={replacing ? 'Replace image' : 'Insert image'}
      onClose={onClose}
      width={tab === 'link' ? 360 : 560}
      className="dk-imgdlg"
      testId="insert-image"
      footer={
        tab === 'upload' ? undefined : (
          <>
            {tab === 'files' && <span className="dk-bp-muted">{chosen.length} selected</span>}
            <span style={{ flex: 1 }} />
            <button type="button" className="dk-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dk-btn-primary"
              disabled={tab === 'link' ? !url.trim() || busy : !chosen.length}
              onClick={() => (tab === 'link' ? void insertLink() : putSrc(chosen))}
            >
              {replacing ? 'Replace image' : 'Insert image'}
            </button>
          </>
        )
      }
    >
      <div className="dk-track dk-imgdlg-tabs" role="tablist" aria-label="Where the picture comes from">
        {(
          [
            ['upload', 'Upload'],
            ['link', 'Link'],
            ['files', 'Project files'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={tab === v}
            className={tab === v ? 'on' : undefined}
            onClick={() => setTab(v)}
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {TAB_ICON[v]}
            </svg>
            {label}
          </button>
        ))}
      </div>
      {tab === 'upload' && (
        <div
          className={`dk-drop${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            upload(Array.from(e.dataTransfer.files));
          }}
        >
          <div className="dk-drop-title">Drop an image here</div>
          <button type="button" className="dk-btn-primary" onClick={() => fileRef.current?.click()}>
            Choose file
          </button>
          <p>Or paste a screenshot with Ctrl V anywhere on the page.</p>
          <p className="dk-bp-muted">
            PNG, JPG, GIF, WebP or SVG, up to {limitMb} MB.
            {replacing ? '' : ' Several files go in one under the other.'}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple={!replacing}
            hidden
            aria-label="Choose image files"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = '';
              upload(list);
            }}
          />
        </div>
      )}
      {tab === 'link' && (
        <div className="dk-bp-col dk-imgdlg-link">
          <label className="dk-imgdlg-label" htmlFor="dk-img-url">
            Image address
          </label>
          <input
            id="dk-img-url"
            className="dk-bp-input dk-imgdlg-url"
            type="url"
            placeholder="https://images.example.com/picture.jpg"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(null);
            }}
          />
          {url.trim() && (
            <div className="dk-link-prev">
              <img
                src={url.trim()}
                alt=""
                onLoad={(e) => setPreview({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onError={() => setPreview('error')}
              />
              <div>
                <strong>{fileNameOf(url.trim())}</strong>
                <span className="dk-bp-muted" data-testid="image-link-meta">
                  {preview === 'error'
                    ? 'Not found'
                    : preview
                      ? [
                          `${preview.w} x ${preview.h} px`,
                          imageKind(typed, head?.type),
                          head?.bytes ? formatBytes(head.bytes) : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : 'Loading…'}
                </span>
              </div>
            </div>
          )}
          <Toggle
            label="Save a copy in this project"
            hint="Keeps working if the original moves or is removed"
            checked={saveCopy}
            onChange={setSaveCopy}
          />
        </div>
      )}
      {tab === 'files' && (
        <div className="dk-bp-col">
          <input
            className="dk-bp-input"
            type="search"
            aria-label="Search by file name or ticket"
            placeholder="Search by file name or ticket"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="dk-cat-chips" role="tablist" aria-label="Where">
            {(
              [
                ['all', 'All'],
                ['ticket', 'Tickets'],
                ['doc', 'Docs pages'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={filter === v}
                className={filter === v ? 'on' : undefined}
                onClick={() => setFilter(v)}
              >
                {label}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="dk-bp-muted">No pictures in this project yet.</p>
          ) : (
            <div className="dk-files-grid" role="listbox" aria-label="Project files" aria-multiselectable={!replacing}>
              {shown.map((f) => {
                const on = chosen.includes(f.src);
                return (
                  <button
                    key={f.src}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={on ? 'on' : undefined}
                    onClick={() =>
                      setChosen((c) => (replacing ? [f.src] : on ? c.filter((x) => x !== f.src) : [...c, f.src]))
                    }
                  >
                    <img src={f.src} alt="" loading="lazy" />
                    <span className="dk-files-name">{f.name}</span>
                    <span className="dk-files-where">{f.where}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
