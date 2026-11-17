/**
 * Parts the embed blocks share while editing: the toolbar over a selected embed, its buttons, and the card of a
 * video or file on its way to the server (design "Embeds", frames 16, 44-47, 74): uploading with progress and Cancel,
 * scanning for viruses, refused (too large, blocked type, a virus) with Choose another and Remove, failed with Try
 * again.
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getFileTypeMeta } from '../../../../utils/fileIcons';
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

/** The type badge of a file card ("PDF", "XLS"). */
export function FileBadge({ name }: { name: string }) {
  const meta = getFileTypeMeta(name);
  const ext = (name.split('.').pop() ?? '').slice(0, 4).toUpperCase();
  return (
    <span className="dk-fc-badge" style={{ color: meta.color, background: meta.bgColor }} aria-hidden="true">
      {meta.badge || ext || 'FILE'}
    </span>
  );
}

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
    <button type="button" className="dk-btn-ghost" onClick={() => cancelDocUpload(editor, upload.id)}>
      Remove
    </button>
  );
  let body: ReactNode;
  if (upload.status === 'uploading') {
    const left = timeLeft(upload);
    body = (
      <>
        <div className="dk-fc-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="dk-fc-status">
          <span>
            Uploading {pct} % · {formatBytes(upload.loaded)} of {formatBytes(size)}
          </span>
          {left && <span className="dk-bp-muted">{left}</span>}
          <button type="button" className="dk-btn-ghost" onClick={() => cancelDocUpload(editor, upload.id)}>
            Cancel
          </button>
        </div>
      </>
    );
  } else if (upload.status === 'scanning') {
    body = (
      <div className="dk-fc-status" role="status">
        <span>
          <strong>Scanning for viruses…</strong> This takes a few seconds. The file is added to the page once it passes.
        </span>
        <button type="button" className="dk-btn-ghost" onClick={() => cancelDocUpload(editor, upload.id)}>
          Cancel
        </button>
      </div>
    );
  } else if (upload.status === 'failed') {
    body = (
      <div className="dk-fc-status dk-fc-bad" role="alert">
        <span>{upload.problem?.text ?? 'The file did not reach the server. Try again.'}</span>
        <button type="button" className="dk-btn-ghost" onClick={() => retryDocUpload(editor, upload.id)}>
          Try again
        </button>
        {remove}
      </div>
    );
  } else {
    body = (
      <div className="dk-fc-status dk-fc-bad" role="alert" data-testid="upload-refused">
        <span>{upload.problem?.text}</span>
        <button type="button" className="dk-btn-ghost" onClick={() => pick.current?.click()}>
          Choose another
        </button>
        {remove}
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
      </div>
    );
  }
  return (
    <div className="dk-fc dk-fc-upload" contentEditable={false} data-upload-status={upload.status}>
      {head}
      {body}
    </div>
  );
}
