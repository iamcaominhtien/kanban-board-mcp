/**
 * The readability check (RichDocsStates J 74): a short list of what may be hard to read on a page, checked while
 * the person writes, that never blocks Publish. Two things are checked: a text colour whose contrast against the
 * page is under 4.5 to 1, and a picture without a description.
 */

import { useEffect, useRef } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { RichDoc } from '../../../types/docs';
import { BACKGROUND_LABEL } from '../pageSettings';
import { backgroundOf, checkContrast, colorLabel, HEX_RE, type TextColorName } from '../editor/ribbon/palette';
import { StIcon } from './stIcons';
import './states.css';

/** One thing to look at. */
export type ReadabilityIssue =
  | {
      kind: 'contrast';
      blockId: string;
      /** 1-based place of the block. */
      n: number;
      hex: string;
      /** "custom colour 1": the custom colours are numbered in the order they appear. */
      name: string;
      ratio: number;
      suggestion: TextColorName | null;
    }
  | { kind: 'alt'; blockId: string; n: number; what: string };

function walkMarks(node: JSONContent, out: Set<string>) {
  for (const m of node.marks ?? []) {
    const c = m.type === 'textStyle' ? m.attrs?.color : null;
    if (typeof c === 'string' && HEX_RE.test(c)) out.add(c.toLowerCase());
  }
  for (const c of node.content ?? []) walkMarks(c, out);
}

function picturesWithoutAlt(node: JSONContent, out: JSONContent[]) {
  if (
    node.type === 'image' &&
    !String(node.attrs?.alt ?? '').trim() &&
    !String(node.attrs?.src ?? '').startsWith('uploading:')
  )
    out.push(node);
  for (const c of node.content ?? []) picturesWithoutAlt(c, out);
}

/**
 * What may be hard to read on a page, in page order.
 * @param doc - The page.
 * @param pageHex - The page colour (`#rrggbb`).
 */
export function readabilityIssues(doc: RichDoc | JSONContent, pageHex: string): ReadabilityIssue[] {
  const out: ReadabilityIssue[] = [];
  const customs: string[] = [];
  (doc.content ?? []).forEach((block, i) => {
    const id = String(block.attrs?.blockId ?? `#${i}`);
    const colours = new Set<string>();
    walkMarks(block, colours);
    for (const hex of colours) {
      if (!customs.includes(hex)) customs.push(hex);
      const c = checkContrast(hex, pageHex);
      if (!c.ok)
        out.push({
          kind: 'contrast',
          blockId: id,
          n: i + 1,
          hex,
          name: `custom colour ${customs.indexOf(hex) + 1}`,
          ratio: c.ratio,
          suggestion: c.suggestion,
        });
    }
    const pics: JSONContent[] = [];
    picturesWithoutAlt(block, pics);
    if (pics.length) {
      const cap = String(pics[0].attrs?.caption ?? '').trim();
      out.push({ kind: 'alt', blockId: id, n: i + 1, what: cap ? `the picture “${cap}”` : 'a picture' });
    }
  });
  return out;
}

/**
 * The page with one block's custom colour replaced by a palette colour (Fix).
 * @param doc - The page.
 * @param blockId - The block.
 * @param hex - The colour to replace.
 * @param name - The palette colour that takes its place.
 */
export function fixColour(doc: RichDoc, blockId: string, hex: string, name: string): RichDoc {
  const swap = (n: JSONContent): JSONContent => ({
    ...n,
    ...(n.marks
      ? {
          marks: n.marks.map((m) =>
            m.type === 'textStyle' && String(m.attrs?.color ?? '').toLowerCase() === hex
              ? { ...m, attrs: { ...m.attrs, color: name } }
              : m,
          ),
        }
      : {}),
    ...(n.content ? { content: n.content.map(swap) } : {}),
  });
  return {
    ...doc,
    content: (doc.content ?? []).map((b) => (b.attrs?.blockId === blockId ? swap(b) : b)),
  } as RichDoc;
}

const ratioText = (r: number) => `${(Math.floor(r * 10) / 10).toFixed(1)} to 1`;

interface Props {
  issues: ReadabilityIssue[];
  pageHex: string;
  onFix: (issue: Extract<ReadabilityIssue, { kind: 'contrast' }>) => void;
  onAdd: (issue: Extract<ReadabilityIssue, { kind: 'alt' }>) => void;
  onClose: () => void;
}

/**
 * The readability list (`data-testid="readability-check"`), a popover under its button; Esc or a click outside
 * closes it.
 * @param props.issues - What to look at.
 * @param props.pageHex - The page colour (its name is said in the contrast row).
 * @param props.onFix - Replaces a hard-to-read colour with the suggested palette colour.
 * @param props.onAdd - Goes to a picture to add its description.
 * @param props.onClose - Closes the list.
 */
export function ReadabilityCheck({ issues, pageHex, onFix, onAdd, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest?.('[data-testid="readability-button"]')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const bg = BACKGROUND_LABEL[backgroundOf(pageHex)];
  return (
    <div
      ref={ref}
      className="dst-menu dst-read"
      role="dialog"
      aria-label="Readability check"
      data-testid="readability-check"
      style={{ width: 420, right: 0, top: 'calc(100% + 10px)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div className="dst-read-title">Readability check</div>
        {issues.length > 0 ? (
          <span className="dst-read-tag">{issues.length} to look at</span>
        ) : (
          <span className="dst-read-tag dst-read-tag-ok">Nothing to look at</span>
        )}
      </div>
      <div className="dst-read-sub">Checked while you write. Nothing here blocks Publish.</div>
      {issues.map((x) => (
        <div key={`${x.kind}-${x.blockId}-${x.kind === 'contrast' ? x.hex : ''}`} className="dst-read-row">
          <span className="dst-read-icon" aria-hidden="true">
            <StIcon name={x.kind === 'contrast' ? 'warn' : 'picture'} size={15} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dst-read-row-title">
              {x.kind === 'contrast' ? 'Text colour is hard to read' : 'A picture has no description'}
            </div>
            <div className="dst-read-row-sub">
              {x.kind === 'contrast'
                ? `Block ${x.n} · ${x.name} on ${bg}, ${ratioText(x.ratio)}`
                : `Block ${x.n} · ${x.what}. People who cannot see it will not know what it shows.`}
            </div>
          </div>
          {x.kind === 'contrast' ? (
            x.suggestion && (
              <button
                type="button"
                className="st-btn st-btn-sm"
                aria-label={`Fix: use ${colorLabel(x.suggestion)}`}
                onClick={() => onFix(x)}
              >
                Fix
              </button>
            )
          ) : (
            <button type="button" className="st-btn st-btn-sm" onClick={() => onAdd(x)}>
              Add
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
