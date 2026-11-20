/**
 * An HTML embed as a reader sees it (design "Embeds", frames 1, 7, 8, 10): the "HTML" header with its title and
 * "View source", and the frame. Anyone who can read the page can read the source. An embed of a site (uploaded as a
 * folder) shows its page and, as its source, the page it opens and its files.
 */

import { useState } from 'react';
import { EmbIcon } from './embIcons';
import { knownSite } from './embedApi';
import { HtmlEmbedFrame } from './HtmlEmbedFrame';
import { kbOrMb } from './htmlSandbox';
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
          className="st-btn st-btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(html).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          <EmbIcon name="copy" size={12} sw={2.2} />
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

/** The page a site embed opens (`index.html`): the address after `/docs/sites/<id>/`. */
export function siteEntry(src: string): string {
  const m = /\/docs\/sites\/[0-9a-f]+\/(.+)$/.exec(src.split(/[?#]/)[0]);
  return m ? decodeURIComponent(m[1]) : src;
}

/** The source of a site embed (read only): the page it opens, a link to open it in a new tab, and its files. */
export function SiteSourceView({ src }: { src: string }) {
  const site = knownSite(src);
  return (
    <div className="dk-emb-source" data-testid="html-embed-site-source">
      <div className="dk-emb-source-head">
        <span>
          Site · opens {siteEntry(src)}
          {site ? ` · ${site.files.length} ${site.files.length === 1 ? 'file' : 'files'}, ${kbOrMb(site.bytes)}` : ''}
        </span>
        <a className="st-btn st-btn-sm" href={src} target="_blank" rel="noreferrer">
          <EmbIcon name="open" size={12} sw={2.2} />
          Open in a new tab
        </a>
      </div>
      {site && (
        <pre>
          {site.files.map((f) => (
            <div key={f.path} className="dk-emb-src-line">
              <span className="dk-emb-src-no">{f.path === site.entry ? '▸' : ' '}</span>
              <span>
                {f.path} · {kbOrMb(f.bytes)}
              </span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** The "HTML" kind chip of the header. */
export function HtmlKind() {
  return (
    <span className="dk-emb-kind">
      <EmbIcon name="html" size={12} sw={2.2} />
      HTML
    </span>
  );
}

/** The "HTML · title" header label. */
export function HtmlChip({ title }: { title: string }) {
  return (
    <>
      <HtmlKind />
      <span className="dk-emb-title">{title || 'HTML embed'}</span>
    </>
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
  const src = typeof attrs.src === 'string' && attrs.src ? attrs.src : null;
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
        <button type="button" className="st-btn st-btn-sm" aria-pressed={source} onClick={() => setSource((v) => !v)}>
          <EmbIcon name="code" size={12} sw={2.2} />
          {source ? 'Hide source' : 'View source'}
        </button>
      </div>
      <div className="dk-emb-body">
        {src?.startsWith('uploading:') ? (
          <div className="dk-emb-fail" role="status" data-testid="html-embed-uploading">
            <EmbIcon name="upload" size={24} />
            <strong>This embed is still uploading</strong>
            <span>It shows here once its files reach the board.</span>
          </div>
        ) : (
          <HtmlEmbedFrame
            html={html}
            src={src}
            title={title}
            height={height}
            runScripts={!!attrs.runScripts}
            projectId={projectId}
            onViewSource={() => setSource(true)}
          />
        )}
      </div>
      {source && (src ? <SiteSourceView src={src} /> : <SourceView html={html} />)}
    </div>
  );
}
