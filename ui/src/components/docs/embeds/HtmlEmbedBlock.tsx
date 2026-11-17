/**
 * An HTML embed as a reader sees it (design "Embeds", frames 1, 7, 8, 10): the "HTML" header with its title and
 * "View source", the sandbox note, and the frame. Anyone who can read the page can read the source.
 */

import { useState } from 'react';
import { HtmlEmbedFrame, SandboxNote } from './HtmlEmbedFrame';
import './embeds.css';

/** The source of an embed, read only, with line numbers and Copy (frame 7). */
export function SourceView({ html }: { html: string }) {
  const [copied, setCopied] = useState(false);
  const lines = html.split('\n');
  return (
    <div className="dk-emb-source" data-testid="html-embed-source">
      <div className="dk-emb-source-head">
        <span>Source · read only</span>
        <button
          type="button"
          className="dk-emb-link"
          onClick={() => {
            void navigator.clipboard?.writeText(html).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {lines.map((l, i) => (
          <div key={i} className="dk-emb-src-line">
            <span className="dk-emb-src-no">{i + 1}</span>
            <span>{l || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

/** The "HTML · title" header label. */
export function HtmlChip({ title }: { title: string }) {
  return (
    <span className="dk-emb-head-label">
      <span className="dk-emb-kind">HTML</span>
      <span className="dk-emb-title">{title || 'HTML embed'}</span>
    </span>
  );
}

/** Props of {@link HtmlEmbedBlock}. */
export interface HtmlEmbedBlockProps {
  attrs: Record<string, unknown>;
  projectId?: string;
  /** The block element's own attributes (`data-block-id`, classes). */
  blockProps?: Record<string, unknown> & { className?: string };
}

/**
 * The reader's HTML embed block.
 */
export function HtmlEmbedBlock({ attrs, projectId, blockProps }: HtmlEmbedBlockProps) {
  const html = typeof attrs.html === 'string' ? attrs.html : '';
  const title = typeof attrs.title === 'string' ? attrs.title : '';
  const height = typeof attrs.height === 'number' && attrs.height > 0 ? attrs.height : null;
  const [source, setSource] = useState(false);
  return (
    <div
      {...blockProps}
      className={['dk-emb dk-html-embed', blockProps?.className].filter(Boolean).join(' ')}
      data-testid="html-embed"
    >
      <div className="dk-emb-head">
        <HtmlChip title={title} />
        <button type="button" className="dk-emb-link" aria-pressed={source} onClick={() => setSource((v) => !v)}>
          {source ? 'Hide source' : 'View source'}
        </button>
      </div>
      <SandboxNote />
      <HtmlEmbedFrame
        html={html}
        title={title}
        height={height}
        runScripts={!!attrs.runScripts}
        projectId={projectId}
        onViewSource={() => setSource(true)}
      />
      {source && <SourceView html={html} />}
    </div>
  );
}
