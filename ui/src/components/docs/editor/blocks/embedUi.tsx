/**
 * Parts the embed blocks share while editing: the toolbar over a selected embed, its buttons, and the card of a
 * video or file on its way to the server (design "Embeds", frames 16, 44-47, 74): uploading with progress and Cancel,
 * scanning for viruses, refused (too large, blocked type, a virus) with Choose another and Remove, failed with Try
 * again.
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getFileTypeMeta } from '../../../../utils/fileIcons';
import { EmbIcon } from '../../embeds/embIcons';
import { cancelDocUpload, chooseAnotherFile, retryDocUpload, timeLeft, type DocUpload } from './docUpload';
import { formatBytes } from './ui';

/** One toolbar button (labelled for screen readers and the tooltip). */
export function ToolBtn({
  label,
  on,
  onClick,
  children,
  wide,
  danger,
}: {
  label: string;
  on?: boolean;
  onClick: () => void;
  children?: ReactNode;
  wide?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`dk-btb${on ? ' on' : ''}${wide ? ' wide' : ''}`}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      title={label}
      style={danger ? { color: '#C4432A' } : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children ?? label}
    </button>
  );
}

/** The toolbar over a selected embed. */
export function EmbedToolbar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="dk-btoolbar dk-emb-toolbar"
      role="toolbar"
      aria-label={label}
      data-block-ui=""
      contentEditable={false}
    >
      {children}
    </div>
  );
}

/** A separator in a toolbar. */
export const Sep = () => <span className="dk-btb-sep" />;

/** The board's colours of a file type badge (text, background), by extension. */
const BADGE: Record<string, [string, string, string]> = {
  pdf: ['PDF', '#C4432A', '#FDF1EE'],
  doc: ['DOC', '#2F6FB0', '#E8F1FA'],
  docx: ['DOC', '#2F6FB0', '#E8F1FA'],
  xls: ['XLS', '#2E6F40', '#E6F2EA'],
  xlsx: ['XLS', '#2E6F40', '#E6F2EA'],
  csv: ['CSV', '#3A4A3E', '#F1F3F1'],
  zip: ['ZIP', '#8A5A00', '#FDF3E3'],
  exe: ['EXE', '#C4432A', '#FDF1EE'],
};

/** The type badge of a file card ("PDF", "XLS"): 40 × 44, a page icon over the type (frame 38). */
export function FileBadge({ name }: { name: string }) {
  const meta = getFileTypeMeta(name);
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const [label, color, bg] = BADGE[ext] ?? [
    meta.badge || ext.slice(0, 4).toUpperCase() || 'FILE',
    meta.color,
    meta.bgColor,
  ];
  return (
    <span className="dk-fc-badge" style={{ color, background: bg, borderColor: `${color}33` }} aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 3h8l4 4v14H6zM14 3v5h5" />
      </svg>
      <span>{label}</span>
    </span>
  );
}

/** The tone of a refused upload: amber when it is too large, red when it is blocked or has a virus (frames 45-47). */
const toneOf = (u: DocUpload) => (u.problem?.code === 'too_large' ? 'warn' : 'bad');

/**
 * The card of an upload in progress or refused.
 * @param props.accept - What the "Choose another" picker takes.
 */
export function UploadCard({ editor, upload, accept }: { editor: Editor; upload: DocUpload; accept?: string }) {
  const pick = useRef<HTMLInputElement>(null);
  const [, tick] = useState(0);
  // the time left is worked out again every second
  useEffect(() => {
    if (upload.status !== 'uploading') return undefined;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [upload.status]);
  const name = upload.file.name;
  const size = upload.file.size;
  const pct = size ? Math.min(100, Math.round((upload.loaded / size) * 100)) : 0;
  const meta = getFileTypeMeta(name);
  const head = (
    <div className="dk-fc-row">
      <FileBadge name={name} />
      <span className="dk-fc-text">
        <strong className="dk-fc-name">{name}</strong>
        <span className="dk-fc-meta">
          {meta.label} · {formatBytes(size)}
        </span>
      </span>
    </div>
  );
  const remove = (
    <button type="button" className="st-btn st-btn-sm" onClick={() => cancelDocUpload(editor, upload.id)}>
      Remove
    </button>
  );
  let body: ReactNode;
  let tone = '';
  if (upload.status === 'uploading') {
    const left = timeLeft(upload);
    body = (
      <div>
        <div className="dk-fc-up-head">
          <span>Uploading</span>
          <span>
            {pct} % · {formatBytes(upload.loaded)} of {formatBytes(size)}
          </span>
        </div>
        <div className="dk-fc-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="dk-fc-up-foot">
          <span>{left}</span>
          <button type="button" className="st-btn st-btn-sm" onClick={() => cancelDocUpload(editor, upload.id)}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (upload.status === 'scanning') {
    body = (
      <div className="dk-fc-status" role="status">
        <span>
          <strong>Scanning for viruses…</strong> This takes a few seconds. The file is added to the page once it passes.
        </span>
        <button type="button" className="st-btn st-btn-sm" onClick={() => cancelDocUpload(editor, upload.id)}>
          Cancel
        </button>
      </div>
    );
  } else if (upload.status === 'failed') {
    tone = ' dk-fc-tone-bad';
    body = (
      <>
        <div className="dk-fc-why" role="alert">
          <EmbIcon name="warn" size={14} sw={2.2} />
          <span>{upload.problem?.text ?? 'The file did not reach the server. Try again.'}</span>
        </div>
        <div className="dk-fc-btns">
          <button type="button" className="st-btn st-btn-sm" onClick={() => retryDocUpload(editor, upload.id)}>
            Try again
          </button>
          {remove}
        </div>
      </>
    );
  } else {
    const t = toneOf(upload);
    tone = ` dk-fc-tone-${t}`;
    const code = upload.problem?.code;
    body = (
      <>
        <div className="dk-fc-why" role="alert" data-testid="upload-refused">
          <EmbIcon
            name={code === 'too_large' ? 'warn' : code === 'type_not_allowed' ? 'lock' : 'shield'}
            size={14}
            sw={2.2}
          />
          <span>
            {upload.problem?.title && <b>{upload.problem.title.replace(/\.?$/, '.')} </b>}
            {upload.problem?.text}
          </span>
        </div>
        <div className="dk-fc-btns">
          <button type="button" className="st-btn st-btn-sm" onClick={() => pick.current?.click()}>
            Choose another
          </button>
          {remove}
        </div>
        <input
          ref={pick}
          type="file"
          hidden
          accept={accept}
          aria-label="Choose another file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) chooseAnotherFile(editor, upload.id, f);
          }}
        />
      </>
    );
  }
  return (
    <div className={`dk-fc dk-fc-upload${tone}`} contentEditable={false} data-upload-status={upload.status}>
      {head}
      {body}
    </div>
  );
}
