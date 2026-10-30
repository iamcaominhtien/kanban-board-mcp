/** Rules for "Write a page with AI", publishing and import tidy (design/screens/docs-ai.md D, docs-ai-care.md D). Pure. */

/** `[Needs input: what is missing]`; the editor may save the brackets escaped. */
const MARKER = /\\?\[Needs input:[^\]\n]*\]/g;
const FENCE = /^\s*(```|~~~)/;

export interface NeedsInputMarker {
  /** The marker as written, `[Needs input: maximum rows]`. */
  text: string;
  /** What is missing, `maximum rows`. */
  label: string;
  /** 1-based line. */
  line: number;
}

/** The Needs input markers in a text (not inside fenced code). */
export function findMarkers(markdown: string): NeedsInputMarker[] {
  const out: NeedsInputMarker[] = [];
  let fenced = false;
  (markdown ?? '').split('\n').forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of line.matchAll(MARKER)) {
      const text = m[0].replace(/\\/g, '');
      out.push({ text, label: text.slice('[Needs input:'.length, -1).trim(), line: i + 1 });
    }
  });
  return out;
}

/** Scheme the reader uses to draw a marker as a chip. */
export const NEEDS_INPUT_SCHEME = 'needsinput:';

/**
 * Rewrite markers as links with the `needsinput:` scheme so the reader can draw them as warning chips.
 * Code spans and fences are left alone.
 */
export function markNeedsInput(markdown: string): string {
  if (!markdown.includes('Needs input:')) return markdown;
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced || !line.includes('Needs input:')) return line;
      return line
        .split(/(`[^`\n]*`)/g)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(MARKER, (m) => {
                const label = m
                  .replace(/\\/g, '')
                  .slice(1, -1)
                  .replace(/[[\]()]/g, '');
                return `[${label}](${NEEDS_INPUT_SCHEME}${encodeURIComponent(label)})`;
              }),
        )
        .join('');
    })
    .join('\n');
}

/** Remove the `[1]` citation marks the AI writes after a claim (outside code). */
export function stripCitations(markdown: string): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : line.replace(/ ?\[\d{1,2}\](?!\()/g, '');
    })
    .join('\n');
}

/** How many `[n]` citation marks the text still has. */
export function countCitations(markdown: string): number {
  return (markdown.match(/\[\d{1,2}\](?!\()/g) ?? []).length;
}

export type WriteSourceKind = 'ticket' | 'idea' | 'notes' | 'prompt';
export type WritePageKind = 'spec' | 'howto' | 'release_note' | 'decision' | 'meeting_notes';

export const PAGE_KIND_LABEL: Record<WritePageKind, string> = {
  spec: 'Spec',
  howto: 'How-to',
  release_note: 'Release note',
  decision: 'Decision record',
  meeting_notes: 'Meeting notes',
};

export interface WriteForm {
  kind: WriteSourceKind;
  ticketId: string | null;
  ideaId: string | null;
  text: string;
  pageKind: WritePageKind;
  comments: boolean;
  linkedPages: boolean;
  /** Off unless the person turns it on. */
  codeChanges: boolean;
}

/** The form a source kind starts with (notes default to meeting notes; code changes are always off). */
export function initialWriteForm(kind: WriteSourceKind, seed: { ticketId?: string; text?: string } = {}): WriteForm {
  return {
    kind,
    ticketId: seed.ticketId ?? null,
    ideaId: null,
    text: seed.text ?? '',
    pageKind: kind === 'notes' ? 'meeting_notes' : 'spec',
    comments: true,
    linkedPages: true,
    codeChanges: false,
  };
}

/** Whether Write draft can be pressed: a source is picked and the title is not empty. */
export function canWrite(form: WriteForm, title: string): boolean {
  if (!title.trim()) return false;
  if (form.kind === 'ticket') return !!form.ticketId;
  if (form.kind === 'idea') return !!form.ideaId;
  return form.text.trim().length > 0;
}

/** The request body of the preview and of Write draft. */
export function writeRequest(form: WriteForm, title: string, parentId: string | null) {
  return {
    source: {
      kind: form.kind,
      ticketId: form.kind === 'ticket' ? form.ticketId : null,
      ideaId: form.kind === 'idea' ? form.ideaId : null,
      text: form.kind === 'notes' || form.kind === 'prompt' ? form.text : null,
    },
    pageKind: form.pageKind,
    include: {
      comments: form.comments,
      linkedPages: form.linkedPages,
      codeChanges: form.kind === 'ticket' && form.codeChanges,
    },
    title: title.trim(),
    parentId,
  };
}

export interface SendPreview {
  send: {
    ticket: { id: string; title: string } | null;
    description: boolean;
    comments: number;
    pages: { id: string; title: string }[];
    code: boolean;
    idea: boolean;
    notes: boolean;
    prompt: boolean;
    styleGuide: string | null;
  };
  skipped: { pageId: string; title: string; reason: string }[];
  notes: string[];
}

/** "What will be sent": the chips, in the order of the design (Ticket, 4 comments, 2 pages, Code). */
export function sendChips(p: SendPreview): { id: string; label: string }[] {
  const s = p.send;
  const out: { id: string; label: string }[] = [];
  if (s.ticket) out.push({ id: 'ticket', label: 'Ticket' });
  if (s.idea) out.push({ id: 'idea', label: 'Idea' });
  if (s.notes) out.push({ id: 'notes', label: 'Your notes' });
  if (s.prompt) out.push({ id: 'prompt', label: 'Your request' });
  if (s.comments) out.push({ id: 'comments', label: `${s.comments} comment${s.comments === 1 ? '' : 's'}` });
  if (s.pages.length) out.push({ id: 'pages', label: `${s.pages.length} page${s.pages.length === 1 ? '' : 's'}` });
  if (s.code) out.push({ id: 'code', label: 'Code changes' });
  if (s.styleGuide) out.push({ id: 'style', label: 'Style guide' });
  return out;
}

/** "The ticket description and 4 comments": the label of the first Also read row. */
export function commentsRowLabel(commentCount: number | null): string {
  if (commentCount == null) return 'The ticket description and its comments';
  return `The ticket description and ${commentCount} comment${commentCount === 1 ? '' : 's'}`;
}

export interface PublishWarning {
  show: boolean;
  title: string;
  detail: string;
}

/** The warning Publish shows while Needs input markers remain ("1 Needs input marker is still in this draft"). */
export function publishWarning(markers: NeedsInputMarker[]): PublishWarning {
  if (!markers.length) return { show: false, title: '', detail: '' };
  const n = markers.length;
  const first = markers[0].label;
  return {
    show: true,
    title: `${n} Needs input marker${n === 1 ? ' is' : 's are'} still in this draft`,
    detail:
      n === 1
        ? `${first.charAt(0).toUpperCase()}${first.slice(1)}. Readers would see the marker.`
        : `${markers
            .slice(0, 3)
            .map((m) => m.label)
            .join('; ')}${n > 3 ? '…' : ''}. Readers would see the markers.`,
  };
}

/** The Publish button reads "Publish anyway" while markers remain. */
export function publishLabel(markers: NeedsInputMarker[], version: number): string {
  return markers.length ? 'Publish anyway' : `Publish v${version}`;
}

export interface TidyCounts {
  pages: number;
  ticketKeys: { key: string; count: number; known: boolean }[];
  ticketKeyTotal: number;
  seeLinks: number;
}

/** "KAN-12 found 6 times, KAN-31 twice". */
export function ticketKeySummary(keys: TidyCounts['ticketKeys']): string {
  if (!keys.length) return 'No ticket keys found';
  const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  const text = keys
    .slice(0, 3)
    .map((k, i) => (i === 0 ? `${k.key} found ${times(k.count)}` : `${k.key} ${times(k.count)}`));
  return text.join(', ') + (keys.length > 3 ? ` and ${keys.length - 3} more` : '');
}

/** The sub-line of each tidy option from the counts of a preview (null until it is known). */
export function tidyHints(c: TidyCounts | null, sections: number | null): Record<string, string> {
  return {
    splitByHeading: sections && sections > 1 ? `${sections} pages instead of 1 long page` : 'Only one section found',
    ticketChips: c ? ticketKeySummary(c.ticketKeys) : 'Ticket keys show as chips',
    seeLinks: c
      ? c.seeLinks
        ? `${c.seeLinks} found. Shown for review before they are added`
        : 'None found'
      : 'Shown for review before they are added',
    headingLevels: 'Starts at ## as the editor expects',
  };
}

/** "3 pages" for the digest header. */
export function pagesLabel(n: number): string {
  return `${n} page${n === 1 ? '' : 's'}`;
}
