/**
 * The colours in the reader's selection bar (design board "Rich Docs — reading", K 74-75, 96, 98): six colours first,
 * ⋯ for all 12, each a 24 px tile of its tint with its shape. When adding is off the tiles are greyed and a line
 * under the bar says why: a Viewer, an older version, switched off, or a limit reached.
 */

import { useState, type KeyboardEvent } from 'react';
import type { HighlightColor } from '../../../api/docsHighlights';
import { HL_COLORS, HL_FIRST_SIX, HL_INK, HlShape, colorName, tintOf } from './colors';
import { HlIcon } from './hlIcons';
import type { HlLimit } from './useHighlights';

/** Why adding is off, in the boards' words. */
export type AddBlock = 'viewer' | 'older' | 'off' | 'project-off' | null;

/** The line under the bar for each reason (75, 98, 120). */
export function blockText(block: AddBlock, limit: HlLimit): { text: string; bold?: string; warn: boolean } | null {
  if (block === 'viewer')
    return { text: 'Viewers can read comments but cannot add them. Highlights work the same way.', warn: false };
  if (block === 'older') return { text: 'Highlights cannot be added to an older version.', warn: false };
  if (block === 'off')
    return {
      text: 'Highlights are off for this page. People who can edit the page can turn them on in Page settings › Access.',
      warn: false,
    };
  if (block === 'project-off') return { text: 'An admin turned highlights off for this project.', warn: false };
  if (limit === 'person')
    return { bold: 'You have 200 highlights on this page.', text: 'Remove one of yours to add another.', warn: true };
  if (limit === 'page')
    return {
      bold: 'This page has 500 highlights.',
      text: 'It cannot hold more. People who can edit can clear some, or you can ask them to.',
      warn: true,
    };
  return null;
}

/**
 * One colour tile.
 * @param props.color - The colour.
 * @param props.ring - Ringed: the colour in use (yours) or the last used (the ⋯ grid).
 * @param props.big - The ⋯ grid's 26 px tile in a 34 px cell (24 in 32 otherwise).
 */
export function Swatch({
  color,
  ring,
  big,
  disabled,
  onApply,
  testId,
}: {
  color: HighlightColor;
  ring?: boolean;
  big?: boolean;
  disabled?: boolean;
  onApply: (c: HighlightColor) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`hl-sw${big ? ' hl-sw-big' : ''}${ring ? ' is-on' : ''}`}
      aria-label={`Highlight ${colorName(color)}`}
      aria-pressed={ring || undefined}
      title={colorName(color)}
      disabled={disabled}
      data-testid={testId ?? `hl-swatch-${color}`}
      data-color={color}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onApply(color)}
    >
      <span className="hl-sw-tile" style={{ background: tintOf(color), borderColor: `${HL_INK[color]}55` }}>
        <HlShape color={color} size={12} />
      </span>
    </button>
  );
}

/** ← → move between the tiles of a row (100). */
function arrows(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const btns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length]?.focus();
}

/**
 * The 12 colours of the ⋯ panel.
 * @param props.current - The colour ringed (the last used, or the highlight's own).
 * @param props.onApply - Called with the colour chosen.
 * @param props.onClose - Closes the panel.
 */
export function AllColours({
  current,
  disabled,
  onApply,
  onClose,
}: {
  current: HighlightColor | null;
  disabled?: boolean;
  onApply: (c: HighlightColor) => void;
  onClose: () => void;
}) {
  return (
    <div className="hl-all" data-testid="hl-all-colours" data-nocomment>
      <div className="hl-all-head">
        <span className="hl-label">12 highlight colours</span>
        <button
          type="button"
          className="hl-x"
          aria-label="Close"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          <HlIcon name="close" size={14} stroke={2} color="#5B6B60" />
        </button>
      </div>
      <div className="hl-all-grid" role="group" aria-label="Highlight colours" onKeyDown={arrows}>
        {HL_COLORS.map((c) => (
          <Swatch key={c} color={c} big ring={c === current} disabled={disabled} onApply={onApply} />
        ))}
      </div>
      <div className="hl-all-note">
        The same 12 colours as the editor, with a shape each. The last colour you used is remembered.
      </div>
    </div>
  );
}

/**
 * The colours shown in the selection bar, before Comment.
 * @param props.lastColor - The colour last used (ringed in the ⋯ panel).
 * @param props.block - Why adding is off, or null.
 * @param props.limit - The limit reached, or null.
 * @param props.onApply - Highlights the selection in a colour.
 */
export function SelectionSwatches({
  lastColor,
  block,
  limit,
  onApply,
}: {
  lastColor: HighlightColor;
  block: AddBlock;
  limit: HlLimit;
  onApply: (c: HighlightColor) => void;
}) {
  const [all, setAll] = useState(false);
  const off = !!block || !!limit;
  const note = blockText(block, limit);
  return (
    <>
      <span
        className={`hl-sw-row${off ? ' is-off' : ''}`}
        role="group"
        aria-label="Highlight colours"
        aria-description="Everyone in the project who can read this page will see it."
        data-testid="hl-swatches"
        onKeyDown={arrows}
      >
        {HL_FIRST_SIX.map((c) => (
          <Swatch key={c} color={c} disabled={off} onApply={onApply} />
        ))}
        <button
          type="button"
          className="hl-sw-more"
          aria-label="All 12 colours"
          aria-expanded={all}
          disabled={off}
          data-testid="hl-more-colours"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAll((v) => !v)}
        >
          <HlIcon name="dots" size={16} stroke={2} />
        </button>
      </span>
      {all && !off && (
        <AllColours
          current={lastColor}
          onApply={(c) => {
            setAll(false);
            onApply(c);
          }}
          onClose={() => setAll(false)}
        />
      )}
      {note && (
        <div
          className={note.warn ? 'hl-selnote hl-selnote-warn' : 'hl-selnote'}
          role="status"
          data-testid="hl-sel-note"
          data-nocomment
        >
          {note.warn ? (
            <HlIcon name="warn" size={14} stroke={2.2} color="#8A5A00" />
          ) : (
            <HlIcon name="people" size={12} stroke={2} />
          )}
          <span>
            {note.bold && <b>{note.bold}</b>} {note.text}
          </span>
        </div>
      )}
    </>
  );
}
