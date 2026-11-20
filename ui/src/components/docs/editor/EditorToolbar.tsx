import type { Editor } from '@tiptap/react';
import { PhoneBar } from './ribbon/PhoneBar';
import { Ribbon, type RibbonActions } from './ribbon/Ribbon';
import './ribbon/ribbon.css';

export { HighlightGlyph, keyLabel } from './ribbon/parts';

interface Props {
  editor: Editor | null;
  disabled?: boolean;
  onLink: () => void;
  onPickImage: () => void;
  /** Opens the picker for any file (attached as a link); the button is left out without it. */
  onPickFile?: () => void;
  /** Starts a sketch; the button is hidden without it. */
  onSketch?: () => void;
  /** Starts a canvas; the button is hidden without it. */
  onCanvas?: () => void;
  ticketPrefix: string;
  /** Board AI "Ask AI" button (A6). */
  onAskAi?: () => void;
  /** Opens the insert menu ("/"); typing "/" is the same entry point. */
  onInsert?: () => void;
  /** Opens Find (`false`) or Find and replace (`true`). */
  onFind?: (replace: boolean) => void;
  /** Focus mode on or off. */
  onFocusMode?: () => void;
  /** Opens the keyboard shortcut sheet. */
  onShortcuts?: () => void;
  /** The page colour, for colour swatches and the contrast of a custom colour (default white). */
  pageHex?: string;
  /** The text is stored as Markdown (an idea page): colours, fonts, sizes and paragraph attributes are left out. */
  markdownOnly?: boolean;
  /**
   * Where the bar sits: `top` (desktop, the two-row ribbon), `strip` (tablet: one row that scrolls sideways, 44 px
   * targets, Undo, Redo and Insert pinned) or `bottom` (phone: the bar above the on-screen keyboard; see `--dk-kb`).
   */
  variant?: ToolbarVariant;
}

/** Where the formatting bar sits (see EditorToolbar's `variant`). */
export type ToolbarVariant = 'top' | 'strip' | 'bottom';

/**
 * The editor's formatting bar (Rich Docs editor, boards B and C): the two-row ribbon on a desktop, a scrolling strip
 * on a tablet, the bar above the keyboard on a phone.
 * @param props.editor - Editor the buttons act on, or `null`.
 * @param props.disabled - Disable all buttons.
 * @param props.onLink - Called by the link button.
 * @param props.onPickImage - Called by the image button.
 * @param props.onPickFile - Called by the attach-a-file button.
 * @param props.onSketch - Called by the Sketch button (hidden when missing).
 * @param props.onCanvas - Called by the Canvas button (hidden when missing).
 * @param props.ticketPrefix - Ticket key prefix used by the reference button.
 * @param props.onAskAi - Shows the Board AI "Ask AI" button.
 * @param props.onInsert - Opens the insert menu.
 * @param props.onFind - Opens Find and replace (the button is hidden without it).
 * @param props.onFocusMode - Turns focus mode on (the button is hidden without it).
 * @param props.onShortcuts - Opens the shortcut sheet (the button is hidden without it).
 * @param props.pageHex - The page colour.
 * @param props.markdownOnly - Leave out the controls Markdown cannot keep.
 * @param props.variant - `top`, `strip` (scrolls sideways, 44 px targets) or `bottom` (above the keyboard).
 */
export function EditorToolbar({
  editor,
  disabled,
  onLink,
  onPickImage,
  onPickFile,
  onSketch,
  onCanvas,
  ticketPrefix,
  onAskAi,
  onInsert,
  onFind,
  onFocusMode,
  onShortcuts,
  pageHex = '#FFFFFF',
  markdownOnly,
  variant = 'top',
}: Props) {
  const actions: RibbonActions = {
    onLink,
    onPickImage,
    onPickFile,
    onSketch,
    onCanvas,
    onAskAi,
    onFind,
    onFocusMode,
    onShortcuts,
    ticketPrefix,
    onInsert: onInsert ?? (() => editor?.chain().focus().insertContent('/').run()),
  };
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      data-testid="editor-toolbar"
      data-variant={variant}
      className={`dk-ribbon dk-ribbon-${variant}${variant === 'bottom' ? ' dk-toolbar-bottom' : ''}`}
    >
      {variant === 'bottom' ? (
        <PhoneBar editor={editor} disabled={disabled} pageHex={pageHex} actions={actions} plain={markdownOnly} />
      ) : (
        <Ribbon
          editor={editor}
          disabled={disabled}
          variant={variant}
          pageHex={pageHex}
          actions={actions}
          plain={markdownOnly}
        />
      )}
    </div>
  );
}
