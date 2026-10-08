import { useMemo } from 'react';
import { useResolveRefs } from '../api/docs';
import type { DocsRefRequest } from '../types/docs';
import { RefChip } from './docs/RefChip';

const TOKEN_SRC = (prefix: string | null) => `\\[\\[([^\\][\\n]+?)\\]\\]${prefix ? `|\\b(${prefix}-\\d+)\\b` : ''}`;

interface Seg {
  text?: string;
  ref?: DocsRefRequest;
  raw?: string;
}

function segments(text: string, prefix: string | null): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(TOKEN_SRC(prefix), 'g'))) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    if (m[2]) out.push({ ref: { kind: 'ticket', key: m[2] }, raw: m[0] });
    else {
      const [target, label] = m[1].split('|');
      const [title, anchor] = target.split('#');
      out.push({ ref: { kind: 'page', title: title.trim(), anchor: anchor?.trim() || null }, raw: m[0], text: label });
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Resolves every reference in a list of texts at once (one batch call). */
export function useRefSegments(projectId: string, texts: string[], prefix: string | null) {
  const parsed = useMemo(() => texts.map((t) => segments(t, prefix)), [texts, prefix]);
  const refs = useMemo(
    () => parsed.flatMap((p) => p.filter((s) => s.ref).map((s) => s.ref as DocsRefRequest)),
    [parsed],
  );
  const resolved = useResolveRefs(projectId, refs);
  return { parsed, resolved: resolved.data };
}

/** Text with its [[references]] and ticket keys as static pills (no hover card; still clickable). */
export function RefLine({
  parsed,
  resolved,
  offset,
  projectId,
  dim,
  onOpenPage,
  onOpenTicket,
}: {
  parsed: Seg[];
  resolved: ReturnType<typeof useRefSegments>['resolved'];
  offset: number;
  projectId: string;
  dim?: boolean;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (id: string) => void;
}) {
  let n = offset;
  return (
    <>
      {parsed.map((s, i) => {
        if (!s.ref) return <span key={i}>{s.text}</span>;
        const res = resolved?.[n++];
        const ref = s.ref;
        const open = () => {
          if (ref.kind === 'ticket') onOpenTicket?.(ref.key);
          else if (res?.pageId) onOpenPage?.(res.pageId, res.anchor ?? ref.anchor ?? null);
        };
        return (
          <span
            key={i}
            data-testid="activity-ref"
            role="link"
            tabIndex={0}
            onClick={open}
            onKeyDown={(e) => e.key === 'Enter' && open()}
            style={{ opacity: dim ? 0.55 : 1, cursor: 'pointer' }}
          >
            <RefChip
              staticPill
              kind={ref.kind}
              label={
                s.text ?? (ref.kind === 'ticket' ? ref.key : ref.anchor ? `${ref.title} › ${ref.anchor}` : ref.title)
              }
              pageTitle={ref.kind === 'page' ? ref.title : undefined}
              anchor={ref.kind === 'page' ? ref.anchor : null}
              custom={ref.kind === 'page' && !!s.text}
              result={res}
              projectId={projectId}
            />
          </span>
        );
      })}
    </>
  );
}

/** Count the reference segments in parsed text. */
export function countRefs(parsed: Seg[]): number {
  return parsed.filter((s) => s.ref).length;
}

export type { Seg };
