/** Markdown helpers for the Docs space: slug anchors, [[reference]] parsing, callouts. Mirrors server/services/docs.py. */

import type { DocsHeading, DocsRefRequest } from '../types/docs';

/** Lower-case, spaces to dashes, punctuation dropped ("Example request" -> "example-request"). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const ANCHOR_PREFIX = 'docs-';

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const REF_RE = /\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

function stripInline(text: string): string {
  return text
    .replace(/\[\[([^\]|#]+?)(?:#[^\]|]+?)?(?:\|([^\]]+?))?\]\]/g, (_m, t, label) => label || t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

/** Headings with unique slug anchors (duplicates get -2, -3…), skipping code fences. */
export function headingAnchors(markdown: string): DocsHeading[] {
  const out: DocsHeading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(HEADING_RE);
    if (!m) continue;
    const text = stripInline(m[2]);
    const base = slugify(text) || 'section';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ level: m[1].length, text, slug: n === 1 ? base : `${base}-${n}` });
  }
  return out;
}

export const REF_SCHEME = 'docref:';
export const TICKET_SCHEME = 'dockey:';

/** Marks a `docref:` written from a Markdown link, which may name the page by slug or id as well as by title. */
const LINK_MARK = '?link';

/**
 * The page a Markdown link points at when it stays inside the space: `[Overview](tong-quan)`,
 * `[Spec](/docs/spec#fields)`, `[API](./api.md)`. Null for web and mail links, other schemes, `#section`
 * links and uploads. The last path segment is the page (its slug, title or id), `.md` dropped.
 */
export function internalPageLink(href: string): { title: string; anchor: string | null } | null {
  const url = href.trim();
  if (!url || url.startsWith('#') || url.startsWith('//') || url.includes('/uploads/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const hash = url.indexOf('#');
  const path = (hash < 0 ? url : url.slice(0, hash)).split('?')[0];
  const segment = path
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .pop();
  if (!segment) return null;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const title = decode(segment)
    .replace(/\.(md|markdown)$/i, '')
    .trim();
  const anchor = hash < 0 ? '' : decode(url.slice(hash + 1)).trim();
  return title ? { title, anchor: anchor || null } : null;
}

/** The key a page reference's resolve result is kept under (a Markdown link and a [[Title]] resolve apart). */
export function pageRefKey(ref: { title: string; anchor?: string | null; bySlug?: boolean }): string {
  return `${ref.bySlug ? 'link:' : ''}${ref.title}#${ref.anchor ?? ''}`;
}

/**
 * Turn [[Page#Section|label]] and ticket keys into markdown links with the docref:/dockey: schemes
 * (code spans and fences are left alone) and list the references so they can be resolved in one call.
 * With `pageLinks`, a Markdown link that points inside the space (`[Overview](tong-quan)`, see
 * {@link internalPageLink}) becomes a page reference too, resolved by slug, title or id: in the desktop app such a
 * link would otherwise open nothing.
 */
export function linkifyDocs(
  markdown: string,
  { pageLinks = false }: { pageLinks?: boolean } = {},
): { markdown: string; refs: DocsRefRequest[] } {
  const refs: DocsRefRequest[] = [];
  const seen = new Set<string>();
  const add = (r: DocsRefRequest) => {
    const key = r.kind === 'page' ? `p:${pageRefKey(r)}` : `t:${r.key}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(r);
    }
  };
  let inFence = false;
  const lines = markdown.split('\n').map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // split on inline code and existing links so only plain prose is rewritten
    return line
      .split(/(`[^`\n]*`|\[[^\]]*\]\([^)]*\))/g)
      .map((part, i, parts) => {
        if (i % 2 === 1) {
          // an existing Markdown link (not an image) to a page of the space
          const m = pageLinks && !parts[i - 1]?.endsWith('!') ? part.match(/^\[([^\]]*)\]\(([^)]*)\)$/) : null;
          const target = m ? internalPageLink(m[2].trim().split(/\s+/)[0] ?? '') : null;
          if (!m || !target) return part;
          add({ kind: 'page', title: target.title, anchor: target.anchor, bySlug: true });
          const text = m[1] || (target.anchor ? `${target.title} › ${target.anchor}` : target.title);
          return `[${text}](${REF_SCHEME}${encodeURIComponent(`${target.title}#${target.anchor ?? ''}`)}${LINK_MARK})`;
        }
        let out = part.replace(REF_RE, (_m, title: string, anchor?: string, label?: string) => {
          add({ kind: 'page', title: title.trim(), anchor: anchor?.trim() || null });
          const text = (label || (anchor ? `${title} › ${anchor}` : title)).replace(/[[\]]/g, '');
          const target = encodeURIComponent(`${title.trim()}#${anchor?.trim() ?? ''}`);
          return `[${text}](${REF_SCHEME}${target})`;
        });
        out = out.replace(/(?<!\]\()\b([A-Z][A-Z0-9]{1,5}-\d+)\b(?![^[]*\])/g, (_m, key: string) => {
          add({ kind: 'ticket', key });
          return `[${key}](${TICKET_SCHEME}${key})`;
        });
        return out;
      })
      .join('');
  });
  return { markdown: lines.join('\n'), refs };
}

/** Parse a `docref:` href into page title and anchor (and whether a Markdown link wrote it), or null. */
export function parseDocRef(href: string): { title: string; anchor: string | null; bySlug: boolean } | null {
  if (!href.startsWith(REF_SCHEME)) return null;
  const bySlug = href.endsWith(LINK_MARK);
  const body = href.slice(REF_SCHEME.length, bySlug ? -LINK_MARK.length : undefined);
  const [title, anchor] = decodeURIComponent(body).split('#');
  return { title, anchor: anchor || null, bySlug };
}

// ── remark plugin: callouts (> [!WARNING]) and heading anchors ──

interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

function nodeText(node: MdNode): string {
  if (node.value != null) return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

const CALLOUT_KINDS: Record<string, 'info' | 'warning' | 'danger' | 'tip'> = {
  note: 'info',
  info: 'info',
  important: 'info',
  tip: 'tip',
  success: 'tip',
  ok: 'tip',
  warn: 'warning',
  warning: 'warning',
  caution: 'warning',
  danger: 'danger',
};

/** Remark plugin: mark `> [!KIND]` callouts and add heading ids. */
export function remarkDocs() {
  return (tree: MdNode) => {
    const seen = new Map<string, number>();
    const walk = (node: MdNode) => {
      if (node.type === 'heading') {
        const base = slugify(nodeText(node).replace(/[*_`~]/g, '')) || 'section';
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, id: n === 1 ? base : `${base}-${n}` },
        };
      } else if (node.type === 'blockquote') {
        const para = node.children?.[0];
        const first = para?.type === 'paragraph' ? para.children?.[0] : undefined;
        const m = first?.type === 'text' ? first.value?.match(/^\[!(\w+)\]\s*/) : null;
        if (m && para && first && CALLOUT_KINDS[m[1].toLowerCase()]) {
          first.value = (first.value ?? '').slice(m[0].length);
          if (!first.value && para.children) para.children.shift();
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, dataCallout: CALLOUT_KINDS[m[1].toLowerCase()] },
          };
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * Undo the HTML escaping the editor's Markdown serializer applies to text: `&` comes out as `&amp;` (and `<`, `>`
 * as `&lt;`, `&gt;`), which would end up in the stored page and change heading slugs. Code spans and fenced code
 * are left as they are, and a `<` that would start a tag stays escaped.
 * @param md - Markdown from `editor.getMarkdown()`.
 */
export function cleanEditorMarkdown(md: string): string {
  const unescape = (s: string) =>
    s
      .replace(/&lt;(?![A-Za-z/!?])/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push(line);
    } else if (fenced) out.push(line);
    else
      out.push(
        line
          .split(/(`[^`]*`)/)
          .map((part, i) => (i % 2 ? part : unescape(part)))
          .join(''),
      );
  }
  return out.join('\n');
}
