/**
 * The block nodes format 1 adds (schema.json): pull quote, columns, video, HTML embed, file, link, page and ticket
 * cards. Each has a minimal `renderHTML` (a `div` with `data-rd-node` and its attributes as `data-*`) that `parseHTML`
 * reads back, and writes plain Markdown as README.md's table says; the real screens come in later phases.
 */

import { Node, mergeAttributes, type Attribute, type JSONContent } from '@tiptap/core';
import { dataAttr, nullable } from './attr';
import { embedLine, escapeMarkdownText, plainLine } from '../plain';

/** `parseHTML` / `renderHTML` for a node drawn as `<div data-rd-node="name">`. */
function htmlSpec(name: string, leaf: boolean) {
  return {
    parseHTML: () => [{ tag: `div[data-rd-node="${name}"]`, priority: 60 }],
    renderHTML: ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) =>
      (leaf
        ? ['div', mergeAttributes(HTMLAttributes, { 'data-rd-node': name })]
        : ['div', mergeAttributes(HTMLAttributes, { 'data-rd-node': name }), 0]) as never,
  };
}

/** A leaf block (no content, one selectable unit) with these attributes and this plain Markdown line. */
function leafBlock(name: string, attrs: Record<string, Attribute>, markdown: (a: Record<string, unknown>) => string) {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes: () => attrs,
    ...htmlSpec(name, true),
    renderMarkdown: (node: JSONContent) => markdown(node.attrs ?? {}),
  });
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A quote set large, on its own (`> text` in Markdown); `source` is who said it. */
export const PullQuote = Node.create({
  name: 'pullQuote',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes: () => ({ textAlign: dataAttr('textAlign', 'center'), ...nullable('source') }),
  ...htmlSpec('pullQuote', false),
  renderMarkdown: (node, h) =>
    h
      .renderChildren(node.content ?? [])
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n'),
});

/** Two to six columns side by side; Markdown writes the columns' blocks one after another. */
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,6}',
  defining: true,
  isolating: true,
  addAttributes: () => ({
    ...nullable('ratio'),
    gap: dataAttr('gap', 24, 'json'),
    line: dataAttr('line', false, 'json'),
    ...nullable('valign'),
  }),
  ...htmlSpec('columns', false),
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], '\n\n'),
});

/** One column of a `columns` block: its blocks are top-level blocks of the page. */
export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  ...htmlSpec('column', false),
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], '\n\n'),
});

/** An uploaded video or a YouTube / Vimeo one: `[embed: video · title]` in Markdown. */
export const Video = leafBlock(
  'video',
  {
    src: dataAttr('src', ''),
    provider: dataAttr('provider', 'file'),
    ...nullable('poster', 'title', 'caption', 'description'),
    loop: dataAttr('loop', false, 'json'),
    muted: dataAttr('muted', false, 'json'),
    widthPct: dataAttr('widthPct', 100, 'json'),
  },
  (a) => embedLine('video', str(a.title) || str(a.caption) || str(a.src)),
);

/** Sanitised HTML shown in a frame: `[embed: HTML embed · title]` in Markdown. */
export const HtmlEmbed = leafBlock(
  'htmlEmbed',
  {
    html: dataAttr('html', ''),
    ...nullable('title'),
    height: dataAttr('height', null, 'json'),
    runScripts: dataAttr('runScripts', false, 'json'),
  },
  (a) => embedLine('HTML embed', str(a.title)),
);

/** An uploaded file shown as a card: `[name](src)` on its own line. */
export const FileCard = leafBlock(
  'fileCard',
  {
    src: dataAttr('src', ''),
    name: dataAttr('name', ''),
    size: dataAttr('size', null, 'json'),
    ...nullable('mime'),
    preview: dataAttr('preview', false, 'json'),
  },
  (a) => `[${escapeMarkdownText(plainLine(str(a.name) || str(a.src)))}](${str(a.src)})`,
);

/** A web link shown as a card (title, description, picture): `[embed: link · title]` in Markdown. */
export const LinkEmbed = leafBlock(
  'linkEmbed',
  {
    url: dataAttr('url', ''),
    ...nullable('title', 'description', 'image', 'site'),
    kind: dataAttr('kind', 'card'),
  },
  (a) => embedLine('link', str(a.title) || str(a.url)),
);

/** Another page shown as a card: `[[Page]]` on its own line. */
export const PageCard = leafBlock('pageCard', { page: dataAttr('page', ''), ...nullable('pageId') }, (a) =>
  str(a.page) ? `[[${plainLine(str(a.page)).replace(/[|#]/g, ' ').trim()}]]` : '',
);

/** A ticket shown as a card: its key (`KAN-12`) on its own line. */
export const TicketCard = leafBlock('ticketCard', { key: dataAttr('key', '') }, (a) => str(a.key));
