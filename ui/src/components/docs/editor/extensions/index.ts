import { InputRule, type AnyExtension } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Callout } from './Callout';
import { CodeBlock } from './CodeBlock';
import { DocImage } from './DocImage';
import { DocRef } from './DocRef';
import { HeadingAnchors } from './HeadingAnchors';
import { Placeholder } from './Placeholder';
import { Shortcuts } from './Shortcuts';
import { TableMethods } from './TableMethods';
import { TicketRef } from './TicketRef';

export interface ExtensionOptions {
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

/** Assemble the Tiptap extensions for the Docs editor. */
export function buildExtensions(opts: ExtensionOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
    }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    CodeBlock,
    DocImage,
    Callout,
    DocRefInput,
    TicketRef.configure({ isTicket: opts.isTicket }),
    HeadingAnchors,
    TableMethods,
    Placeholder,
    Shortcuts.configure({ onLink: opts.onLink }),
  ];
}
