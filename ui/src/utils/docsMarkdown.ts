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

/**
 * Turn [[Page#Section|label]] and ticket keys into markdown links with the docref:/dockey: schemes
 * (code spans and fences are left alone) and list the references so they can be resolved in one call.
 */
export function linkifyDocs(markdown: string): { markdown: string; refs: DocsRefRequest[] } {
  const refs: DocsRefRequest[] = [];
  const seen = new Set<string>();
  const add = (r: DocsRefRequest) => {
    const key = r.kind === 'page' ? `p:${r.title}#${r.anchor ?? ''}` : `t:${r.key}`;
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
      .map((part, i) => {
        if (i % 2 === 1) return part;
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

export function parseDocRef(href: string): { title: string; anchor: string | null } | null {
  if (!href.startsWith(REF_SCHEME)) return null;
  const [title, anchor] = decodeURIComponent(href.slice(REF_SCHEME.length)).split('#');
  return { title, anchor: anchor || null };
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
