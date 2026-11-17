/**
 * Gives the editor's blocks their editing views (images, columns, quotes, pull quotes, dividers, and the embeds: HTML,
 * video, files, links, page and ticket cards, draw.io diagrams) without changing
 * their schema: the same extensions, extended with `addNodeView`. The headless converter (richdoc) keeps the plain
 * ones; only the mounted editor (DocsEditor) uses these.
 */

import { flattenExtensions, type AnyExtension, type Node as TiptapNode } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ColumnsView } from './ColumnsView';
import { HtmlEmbedView } from './HtmlEmbedView';
import { DiagramBlockView, LinkEmbedView, PageCardNodeView, TicketCardNodeView } from './LinkViews';
import { FileCardView, VideoView } from './MediaViews';
import { ImageView, imageOuterAttrs } from './ImageView';
import { BlockquoteView, PullQuoteView, RuleView } from './QuoteViews';
import './blocks.css';

/** A node extended with a React view (no other change). */
const withView =
  (view: Parameters<typeof ReactNodeViewRenderer>[0]) =>
  (ext: TiptapNode): AnyExtension =>
    ext.extend({
      addNodeView() {
        return ReactNodeViewRenderer(view);
      },
    });

const VIEWS: Record<string, (ext: TiptapNode) => AnyExtension> = {
  htmlEmbed: withView(HtmlEmbedView),
  video: withView(VideoView),
  fileCard: withView(FileCardView),
  linkEmbed: withView(LinkEmbedView),
  pageCard: withView(PageCardNodeView),
  ticketCard: withView(TicketCardNodeView),
  diagram: withView(DiagramBlockView),
  image: (ext) =>
    ext.extend({
      addNodeView() {
        return ReactNodeViewRenderer(ImageView, {
          attrs: ({ node }) => imageOuterAttrs(node.attrs as Record<string, unknown>),
        });
      },
    }),
  columns: (ext) =>
    ext.extend({
      addNodeView() {
        return ReactNodeViewRenderer(ColumnsView);
      },
    }),
  pullQuote: (ext) =>
    ext.extend({
      addNodeView() {
        return ReactNodeViewRenderer(PullQuoteView);
      },
    }),
  blockquote: (ext) =>
    ext.extend({
      addNodeView() {
        return ReactNodeViewRenderer(BlockquoteView);
      },
    }),
  horizontalRule: (ext) =>
    ext.extend({
      addNodeView() {
        return ReactNodeViewRenderer(RuleView);
      },
    }),
};

/** The kit's nodes that get a view; the kit is configured without them and they come back extended. */
const FROM_KIT = ['blockquote', 'horizontalRule'] as const;

/**
 * The extensions with the block views added.
 * @param extensions - What buildExtensions returns.
 */
export function withBlockViews(extensions: AnyExtension[]): AnyExtension[] {
  const out: AnyExtension[] = [];
  for (const ext of extensions) {
    if (ext.name === 'starterKit') {
      const opts = (ext.options ?? {}) as Record<string, unknown>;
      const kids = flattenExtensions([ext]).filter((e) => (FROM_KIT as readonly string[]).includes(e.name));
      out.push(StarterKit.configure({ ...opts, blockquote: false, horizontalRule: false }));
      for (const k of kids) out.push(VIEWS[k.name](k as TiptapNode));
      continue;
    }
    out.push(ext.name in VIEWS && ext.type === 'node' ? VIEWS[ext.name](ext as TiptapNode) : ext);
  }
  return out;
}
