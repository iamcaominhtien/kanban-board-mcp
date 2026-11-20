import { InputRule, type AnyExtension } from '@tiptap/core';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Callout } from './Callout';
import { CommentHighlights } from './CommentHighlights';
import { SharedHighlights } from './SharedHighlights';
import { CodeBlock } from './CodeBlock';
import { Diagram } from './Diagram';
import { DocImage } from './DocImage';
import { DocRef } from './DocRef';
import { HeadingAnchors } from './HeadingAnchors';
import { MathBlock, MathInline } from './Math';
import { NeedsInput } from './NeedsInput';
import { Placeholder } from './Placeholder';
import { Shortcuts } from './Shortcuts';
import { Sketch } from './Sketch';
import { Canvas } from './Canvas';
import { TableMethods } from './TableMethods';
import { TicketRef } from './TicketRef';
import { BlockId } from '../../../../richdoc/blockId';
import {
  Column,
  Columns,
  FileCard,
  HtmlEmbed,
  LinkEmbed,
  PageCard,
  PullQuote,
  RichAttrs,
  RichHighlight,
  RichTable,
  Subscript,
  Superscript,
  TextStyle,
  TicketCard,
  Underline,
  Video,
  richLink,
} from '../../../../richdoc/extensions';

export interface ExtensionOptions {
  onCommentSelect?: (threadId: string) => void;
  isTicket: (key: string) => boolean;
  onLink: () => void;
}

/** Typing a complete `[[Page#Section|label]]` turns it into a reference chip. */
const DocRefInput = DocRef.extend({
  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: /\[\[([^\]|#\n]+?)(?:#([^\]|\n]+?))?(?:\|([^\]\n]+?))?\]\]$/,
        handler: ({ state, range, match }) => {
          const page = match[1].trim();
          if (/^[A-Z][A-Z0-9]{1,5}-\d+$/.test(page) && !match[2]) {
            state.tr.replaceWith(range.from, range.to, state.schema.nodes.ticketRef.create({ key: page }));
            return;
          }
          state.tr.replaceWith(
            range.from,
            range.to,
            type.create({ page, section: match[2]?.trim() || null, label: match[3]?.trim() || null }),
          );
        },
      }),
    ];
  },
});

/** HTML tags the page keeps as formatting when they appear in Markdown; any other tag stays as the text typed. */
const KEPT_HTML = new Set([
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'strike',
  'sup',
  'sub',
  'code',
  'mark',
  'br',
]);
const TAG = /<\/?\s*([A-Za-z][\w-]*)/g;

// Format 1: HTML in Markdown whose tags are not all in KEPT_HTML is read as literal text, so `<title>` in a template
// or `<div>` in prose is never dropped (the HTML parser drops elements the schema does not know, text and all). The
// manager has no option for it, so its check for unknown HTML is widened once, for every editor.
const manager = MarkdownManager.prototype as unknown as { isUnrecognizedHtml: (html: string) => boolean };
manager.isUnrecognizedHtml = (html: string) => [...html.matchAll(TAG)].some((m) => !KEPT_HTML.has(m[1].toLowerCase()));

/** Assemble the Tiptap extensions for the Docs editor. */
export function buildExtensions(opts: ExtensionOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      underline: false,
      // the link comes from richLink: the same extension, storing only href and title (schema.json)
      link: false,
    }),
    richLink({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    // `==text==` in the Markdown whatever its colour (format 1 `color`), a <mark> on screen, Mod-Shift-H (the reading
    // view renders the same, remarkDocs)
    RichHighlight,
    Underline,
    Superscript,
    Subscript,
    TextStyle,
    TaskList,
    TaskItem.configure({ nested: true }),
    // the table itself is RichTable: a table with merged cells is a placeholder line in plain Markdown
    RichTable.configure({ resizable: false }),
    TableKit.configure({ table: false }),
    CodeBlock,
    DocImage,
    Diagram,
    Sketch,
    Canvas,
    Callout,
    PullQuote,
    Columns,
    Column,
    Video,
    HtmlEmbed,
    FileCard,
    LinkEmbed,
    PageCard,
    TicketCard,
    DocRefInput,
    MathInline,
    MathBlock,
    TicketRef.configure({ isTicket: opts.isTicket }),
    HeadingAnchors,
    CommentHighlights.configure({ onSelect: (id) => opts.onCommentSelect?.(id) }),
    // the readers' shared highlights, as dotted lines while the page is edited (K 101)
    SharedHighlights,
    TableMethods,
    Placeholder,
    NeedsInput,
    Shortcuts.configure({ onLink: opts.onLink }),
    // format 1: the rich attributes of the existing blocks, and a unique blockId on every block
    RichAttrs,
    BlockId,
  ];
}
