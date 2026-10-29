import { useMemo } from 'react';
import { useBacklinksEx } from '../../api/docsActions';
import type { DocsHeading } from '../../types/docs';
import { headingAnchors, slugify } from '../../utils/docsMarkdown';
import { Icon } from './Icon';
import { plural } from './docsShared';

interface Props {
  pageId: string;
  /** Headings of the published version (what other pages and tickets link to). */
  published: DocsHeading[];
  /** The markdown being edited. */
  markdown: string;
}

/** Pairs of (old, new) headings when the same number of headings are left and some slug changed. */
function renamedHeadings(published: DocsHeading[], markdown: string): { from: DocsHeading; to: DocsHeading }[] {
  const now = headingAnchors(markdown);
  if (now.length !== published.length) return [];
  const live = new Set(now.map((h) => h.slug));
  const out: { from: DocsHeading; to: DocsHeading }[] = [];
  published.forEach((h, i) => {
    if (h.slug !== now[i].slug && !live.has(h.slug)) out.push({ from: h, to: now[i] });
  });
  return out;
}

/**
 * Inline note while a heading is being renamed: links to its old anchor keep working through a stored redirect
 * (DocsRefs board F3). Nothing is rewritten; the server keeps the old slug as an alias when the page is published.
 * @param props.pageId - Page being edited.
 * @param props.published - Headings of the published version.
 * @param props.markdown - The markdown in the editor.
 */
export function HeadingRenameNote({ pageId, published, markdown }: Props) {
  const back = useBacklinksEx(published.length ? pageId : null);
  const note = useMemo(() => {
    if (!back.data) return null;
    for (const r of renamedHeadings(published, markdown)) {
      const sources: string[] = [];
      let n = 0;
      for (const p of back.data.pages)
        if (p.targetAnchor && slugify(p.targetAnchor) === r.from.slug) {
          n += 1;
          sources.push(p.title);
        }
      for (const t of back.data.tickets)
        if (t.targetAnchor && slugify(t.targetAnchor) === r.from.slug) {
          n += 1;
          sources.push(t.ticketId);
        }
      if (n) return { ...r, n, sources: [...new Set(sources)] };
    }
    return null;
  }, [back.data, published, markdown]);
  if (!note) return null;
  const who =
    note.sources.length > 1
      ? `${note.sources.slice(0, -1).join(', ')} and ${note.sources[note.sources.length - 1]}`
      : note.sources[0];
  return (
    <div
      role="status"
      data-testid="heading-rename-note"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '9px 24px',
        background: '#E8F1FB',
        borderBottom: '1px solid #B9D3EE',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: '#3A4A3E',
      }}
    >
      <span style={{ display: 'flex', color: '#2F6FB0', marginTop: 1 }}>
        <Icon name="i28" size={15} strokeWidth={1.9} />
      </span>
      <span>
        <b style={{ color: '#1E2A22' }}>{plural(note.n, 'link')} to this section will keep working (redirect)</b>{' '}
        <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
          #{note.from.slug} → #{note.to.slug}
        </code>{' '}
        from {who}; the old anchor is kept as an alias.
      </span>
    </div>
  );
}
