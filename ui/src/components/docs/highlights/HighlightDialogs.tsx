/**
 * The confirms, messages and strips of shared highlights (design board "Rich Docs — reading", K): the confirm before
 * removing (99, 118, 119), the dark message with Undo for 8 seconds (99, 119), "Couldn’t save the highlight" with Try
 * again (125), the first-time tip under the page bar (85, 86) and the "N new highlights" chip (115-117).
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DOCS_SCRIM, useEscape } from '../docsShared';
import { HlIcon, type HlIconName } from './hlIcons';
import { HlAvatar } from './HighlightPopover';
import type { HlPerson } from './useHighlightLayer';

/**
 * A confirm with a round icon, a title and a line under it, a body and Cancel and a red-outlined button (or a green
 * one: Add to the page, 92).
 * @param props.touch - Tablet or phone: 390 px wide with 44 px buttons.
 * @param props.icon - The round icon and the button's icon (the bin by default).
 * @param props.primary - The button is the green primary one, not a removal.
 */
export function HlConfirm({
  title,
  sub,
  width = 460,
  touch,
  action,
  onCancel,
  onConfirm,
  children,
  testId,
  icon = 'trash',
  primary = false,
}: {
  title: string;
  sub: ReactNode;
  icon?: HlIconName;
  primary?: boolean;
  width?: number;
  touch: boolean;
  /** The button's words ("Remove 2 highlights"). */
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
  testId?: string;
}) {
  useEscape(onCancel);
  return createPortal(
    <div
      className="docs-root hl-scrim"
      style={{ background: DOCS_SCRIM }}
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`hl-dlg${touch ? ' is-touch' : ''}`}
        style={{ width: touch ? Math.min(width, 390) : width }}
        data-testid={testId ?? 'hl-confirm'}
      >
        <div className="hl-dlg-head">
          <span className="hl-dlg-ico">
            <HlIcon name={icon} size={17} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hl-dlg-title">{title}</div>
            <div className="hl-dlg-sub">{sub}</div>
          </div>
          <button type="button" className="hl-x hl-dlg-x" aria-label="Close" onClick={onCancel}>
            <HlIcon name="close" size={16} />
          </button>
        </div>
        <div className="hl-dlg-body">{children}</div>
        <div className="hl-dlg-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={primary ? 'st-btn st-btn-primary' : 'st-btn st-btn-danger-outline'}
            onClick={onConfirm}
            autoFocus
            data-testid="hl-confirm-go"
          >
            <HlIcon name={icon} size={14} stroke={2} />
            {action}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The people chips of the Clear all confirm ("Hoa Mai · 3"). */
export function PeopleChips({ people }: { people: { person: HlPerson; n: number }[] }) {
  return (
    <div className="hl-dlg-chips">
      {people.map(({ person, n }) => (
        <span key={person.name} className="hl-dlg-chip">
          <HlAvatar person={person} size={18} />
          {person.name} · {n}
        </span>
      ))}
    </div>
  );
}

/**
 * The dark message at the foot of the window: "Highlight removed · Yellow  Undo".
 * @param props.text - What happened.
 * @param props.onUndo - Undo, or none for a plain message.
 */
export function HlToast({
  text,
  onUndo,
  onClose,
  testId,
}: {
  text: ReactNode;
  onUndo?: () => void;
  onClose: () => void;
  testId?: string;
}) {
  return createPortal(
    <div className="hl-toast" role="status" aria-live="polite" data-testid={testId ?? 'hl-undo'}>
      <span style={{ flex: 1 }}>{text}</span>
      {onUndo && (
        <button type="button" className="hl-toast-undo" onClick={onUndo} data-testid="hl-undo-button">
          Undo
        </button>
      )}
      <button type="button" className="hl-toast-x" aria-label="Dismiss" onClick={onClose}>
        <HlIcon name="close" size={14} stroke={2} color="#93A398" />
      </button>
    </div>,
    document.body,
  );
}

/**
 * "Hoa Mai removed a highlight you were looking at. Its comments stay on the page. OK" (126): shown once, only to
 * someone who had the highlight open; not a notification.
 * @param props.person - Who removed it.
 */
export function RemovedNote({ person, onClose }: { person: HlPerson; onClose: () => void }) {
  return createPortal(
    <div className="hl-toast hl-removed" role="status" aria-live="polite" data-testid="hl-removed-note">
      <HlAvatar person={person} size={22} />
      <span style={{ flex: 1 }}>
        {person.name} removed a highlight you were looking at. Its comments stay on the page.
      </span>
      <button type="button" className="hl-toast-undo" onClick={onClose} data-testid="hl-removed-ok">
        OK
      </button>
    </div>,
    document.body,
  );
}

/** "Couldn’t save the highlight. Try again." (125). */
export function SaveFailed({ onRetry, onClose }: { onRetry: () => void; onClose: () => void }) {
  return createPortal(
    <div className="hl-failed" role="alert" data-testid="hl-save-failed">
      <HlIcon name="warn" size={16} stroke={2} color="#C4432A" />
      <span style={{ flex: 1 }}>
        <b>Couldn’t save the highlight.</b> Try again.
      </span>
      <button type="button" className="hl-failed-retry" onClick={onRetry} data-testid="hl-retry">
        Try again
      </button>
      <button type="button" className="hl-toast-x" aria-label="Dismiss" onClick={onClose}>
        <HlIcon name="close" size={14} stroke={2} color="#8A2A18" />
      </button>
    </div>,
    document.body,
  );
}

/**
 * The one-line tip under the page bar the first time (85; 86 on a phone).
 * @param props.touch - A phone or a tablet: the touch gesture instead of "Select some text".
 */
export function HlTip({ touch, onDone }: { touch: boolean; onDone: () => void }) {
  return (
    <div className="hl-tip" data-testid="hl-tip">
      <span className="hl-tip-ico">
        <HlIcon name="marker" size={14} stroke={2} color="#8A5A00" />
      </span>
      <div style={{ flex: 1 }}>
        <b>Highlight while you read.</b> {touch ? 'Press and hold a word, then drag.' : 'Select some text.'} Everyone in
        the project who can read this page will see your highlight.
      </div>
      <button type="button" className="st-btn st-btn-sm hl-tip-ok" onClick={onDone} data-testid="hl-tip-ok">
        Got it
      </button>
    </div>
  );
}

/**
 * "2 new highlights by Hoa Mai · Show" (115-117), in a strip under the page bar.
 * @param props.people - Who made them (one avatar each, up to three).
 * @param props.count - How many.
 */
export function NewChip({
  people,
  count,
  onShow,
  onDismiss,
}: {
  people: HlPerson[];
  count: number;
  onShow: () => void;
  onDismiss: () => void;
}) {
  const what = `${count} new ${count === 1 ? 'highlight' : 'highlights'} by ${people.length === 1 ? people[0].name : `${people.length} people`}`;
  return (
    <div className="hl-chipstrip" data-testid="hl-new-strip">
      <div className="hl-newchip" role="status" aria-live="polite">
        <span className={people.length > 1 ? 'hl-newchip-stack' : undefined}>
          {people.slice(0, 3).map((p) => (
            <HlAvatar key={p.name} person={p} size={20} />
          ))}
        </span>
        <span>{what}</span>
        <button type="button" className="hl-newchip-show" onClick={onShow} data-testid="hl-new-show">
          Show
        </button>
        <button type="button" className="hl-newchip-x" aria-label="Dismiss" onClick={onDismiss}>
          <HlIcon name="close" size={13} stroke={2.2} color="#93A398" />
        </button>
      </div>
    </div>
  );
}
