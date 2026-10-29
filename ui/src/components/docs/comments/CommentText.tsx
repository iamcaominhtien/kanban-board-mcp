import { Fragment, type ReactNode } from 'react';

const TOKEN =
  /(@\[[^\]\n]+\]\(member:[\w-]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![\w*])_[^_\n]+_(?![\w])|\*[^*\n]+\*|\[\[[^\][\n]+\]\]|\b[A-Z][A-Z0-9]{1,9}-\d+\b)/g;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render a comment: bold, italic, code, `[[Page]]`, ticket keys and @mentions of project members.
 * @param props.text - Comment text.
 * @param props.mentions - Members mentioned (only these are shown as mentions).
 */
export function CommentText({ text, mentions }: { text: string; mentions: { id: string; name: string }[] }) {
  const names = mentions.map((m) => m.name).sort((a, b) => b.length - a.length);
  const mention = names.length ? new RegExp(`@(${names.map(escapeRe).join('|')})(?!\\w)`, 'gi') : null;

  function plain(s: string, key: string): ReactNode[] {
    if (!mention) return [s];
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of s.matchAll(mention)) {
      const at = m.index ?? 0;
      if (at > last) out.push(s.slice(last, at));
      out.push(
        <span key={`${key}-${at}`} className="dc-mention" data-testid="comment-mention">
          {m[0]}
        </span>,
      );
      last = at + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }

  const lines = text.split('\n');
  return (
    <div className="dc-text" data-testid="comment-text">
      {lines.map((line, li) => {
        const parts: ReactNode[] = [];
        let last = 0;
        for (const m of line.matchAll(TOKEN)) {
          const at = m.index ?? 0;
          if (at > last) parts.push(...plain(line.slice(last, at), `${li}-${last}`));
          const tok = m[0];
          const k = `${li}-${at}`;
          if (tok.startsWith('@[')) {
            const [, name, id] = /^@\[([^\]]+)\]\(member:([\w-]+)\)$/.exec(tok) ?? [];
            const known = mentions.some((m) => m.id === id);
            parts.push(
              known ? (
                <span key={k} className="dc-mention" data-testid="comment-mention">
                  @{name}
                </span>
              ) : (
                `@${name}`
              ),
            );
          } else if (tok.startsWith('**')) parts.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
          else if (tok.startsWith('`')) parts.push(<code key={k}>{tok.slice(1, -1)}</code>);
          else if (tok.startsWith('[[')) {
            parts.push(
              <span key={k} className="dc-ref" data-testid="comment-page-ref">
                {tok.slice(2, -2).split('|').pop()}
              </span>,
            );
          } else if (tok.startsWith('_') || tok.startsWith('*')) parts.push(<em key={k}>{tok.slice(1, -1)}</em>);
          else
            parts.push(
              <span key={k} className="dc-ref dc-key" data-testid="comment-ticket-ref">
                {tok}
              </span>,
            );
          last = at + tok.length;
        }
        if (last < line.length) parts.push(...plain(line.slice(last), `${li}-${last}`));
        return (
          <Fragment key={li}>
            {li > 0 && <br />}
            {parts}
          </Fragment>
        );
      })}
    </div>
  );
}
