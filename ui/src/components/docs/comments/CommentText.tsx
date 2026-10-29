import { useMemo } from 'react';
import { MarkdownRenderer } from '../../MarkdownRenderer';

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Comment text as Markdown for the shared renderer: a plain `@Name` of a mentioned member becomes the picker's
 * `@[Name](member:id)` so it shows as a mention, and a single line break stays a line break (outside code blocks).
 */
function toMarkdown(text: string, mentions: { id: string; name: string }[]): string {
  let out = text;
  const byLength = [...mentions].sort((a, b) => b.name.length - a.name.length);
  if (byLength.length) {
    const re = new RegExp(`(^|[^\\w[])@(${byLength.map((m) => escapeRe(m.name)).join('|')})(?![\\w\\]])`, 'gi');
    out = out.replace(re, (_all, lead: string, name: string) => {
      const m = byLength.find((x) => x.name.toLowerCase() === name.toLowerCase());
      return m ? `${lead}@[${m.name}](member:${m.id})` : _all;
    });
  }
  let fenced = false;
  return out
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return fenced || !line.trim() ? line : `${line}  `;
    })
    .join('\n');
}

/**
 * Render a comment as Markdown: formatting, lists, links, images and attachments, diagrams, `[[Page]]` and
 * ticket-key chips, and @mentions of project members.
 * @param props.text - Comment text.
 * @param props.mentions - Members mentioned (only these are shown as mentions).
 * @param props.projectId - Project whose pages and tickets the chips resolve against.
 */
export function CommentText({
  text,
  mentions,
  projectId,
}: {
  text: string;
  mentions: { id: string; name: string }[];
  projectId: string;
}) {
  const md = useMemo(() => toMarkdown(text, mentions), [text, mentions]);
  const docs = useMemo(() => ({ projectId }), [projectId]);
  return (
    <div className="dc-text" data-testid="comment-text">
      <MarkdownRenderer docs={docs}>{md}</MarkdownRenderer>
    </div>
  );
}
