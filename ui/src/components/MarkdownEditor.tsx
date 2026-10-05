import { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { markdownToHtml, htmlToMarkdown } from '../utils/markdownWysiwyg';
import { resolveOrigin } from '../api/resolveOrigin';
import styles from './MarkdownEditor.module.css';

const SUPPORTED_UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const FILE_INPUT_ACCEPT = SUPPORTED_UPLOAD_IMAGE_TYPES.join(',');

/** Normalise a URL (without double-encoding) so it is safe to assign to href/src. */
function normalizeUrl(url: string): string | null {
  try {
    return encodeURI(decodeURI(url));
  } catch {
    return null;
  }
}

function uploadErrorMessage(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } } };
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail;
  if (status === 413) return 'Image is too large to upload.';
  if (typeof detail === 'string' && detail) return `Upload failed: ${detail}`;
  return 'Image upload failed. Please try again.';
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  onUploadImage?: (file: File) => Promise<{ markdown: string }>;
  onUploadComplete?: (value: string) => void;
  readOnly?: boolean;
  startInEditMode?: boolean;
  disableClickOutside?: boolean;
  placeholderText?: string;
  editAriaLabel?: string;
  viewClassName?: string;
  compact?: boolean;
  actions?: React.ReactNode;
}

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onSubmit,
  onCancel,
  onUploadImage,
  onUploadComplete,
  readOnly = false,
  startInEditMode = false,
  disableClickOutside = false,
  placeholderText = 'Add a description…',
  editAriaLabel = 'Edit description',
  viewClassName,
  compact = false,
  actions,
}: Props) {
  const [isEditing, setIsEditing] = useState(startInEditMode);
  const [isUploading, setIsUploading] = useState(false);

  // Link Popover state
  const [isLinkPopoverOpen, setIsLinkPopoverOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const savedSelectionRangeRef = useRef<Range | null>(null);

  // Active toolbar formatting states
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isList, setIsList] = useState(false);
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('left');

  const wysiwygRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkBtnRef = useRef<HTMLButtonElement>(null);
  const isFilePickerOpenRef = useRef(false);
  const latestValueRef = useRef(value);
  // Only write back to the caller when the user actually changed something:
  // the HTML round-trip can normalise Markdown, so opening/closing must be a no-op.
  const dirtyRef = useRef(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  // Populate or update contentEditable when entering edit mode or when value changes externally
  useEffect(() => {
    if (isEditing && wysiwygRef.current) {
      const currentMd = htmlToMarkdown(wysiwygRef.current);
      if (value !== currentMd) {
        wysiwygRef.current.innerHTML = markdownToHtml(value);
      }
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing && wysiwygRef.current) {
      dirtyRef.current = false;
      requestAnimationFrame(() => {
        wysiwygRef.current?.focus();
      });
    }
  }, [isEditing]);

  // Click outside listener to exit edit mode and save
  useEffect(() => {
    if (!isEditing || disableClickOutside) return;

    function handleClickOutside(e: MouseEvent) {
      if (isFilePickerOpenRef.current) return;
      if (isLinkPopoverOpen) {
        // If clicking inside link popover, don't close
        const popover = document.querySelector(`.${styles.linkPopover}`);
        if (popover && popover.contains(e.target as Node)) return;
      }
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        finishEditing();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isEditing, isLinkPopoverOpen, disableClickOutside]);

  function syncContent() {
    if (!wysiwygRef.current) return;
    dirtyRef.current = true;
    const md = htmlToMarkdown(wysiwygRef.current);
    latestValueRef.current = md;
    onChange(md);
  }

  function updateToolbarState() {
    try {
      setIsBold(document.queryCommandState('bold'));
      setIsItalic(document.queryCommandState('italic'));
      setIsList(document.queryCommandState('insertUnorderedList'));
      if (document.queryCommandState('justifyCenter')) {
        setAlign('center');
      } else if (document.queryCommandState('justifyRight')) {
        setAlign('right');
      } else {
        setAlign('left');
      }
    } catch {
      // ignore
    }
  }

  function startEditing() {
    if (readOnly) return;
    setIsEditing(true);
  }

  function finishEditing() {
    if (!wysiwygRef.current) {
      setIsEditing(false);
      setIsLinkPopoverOpen(false);
      return;
    }
    let md = latestValueRef.current;
    if (dirtyRef.current) {
      md = htmlToMarkdown(wysiwygRef.current);
      latestValueRef.current = md;
      onChange(md);
    }
    dirtyRef.current = false;
    setIsEditing(false);
    setIsLinkPopoverOpen(false);
    onBlur?.(md);
  }

  function handleUndo() {
    wysiwygRef.current?.focus();
    document.execCommand('undo');
    syncContent();
    updateToolbarState();
  }

  function handleRedo() {
    wysiwygRef.current?.focus();
    document.execCommand('redo');
    syncContent();
    updateToolbarState();
  }

  /** Toggle bold/italic at the caret or over the selection without disturbing the caret. */
  function toggleInlineFormat(cmd: 'bold' | 'italic', selector: string) {
    wysiwygRef.current?.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      document.execCommand(cmd, false);
      syncContent();
      updateToolbarState();
      return;
    }

    const range = sel.getRangeAt(0);

    if (range.collapsed) {
      let node: Node | null = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
      const fmtEl = (node as HTMLElement)?.closest(selector);
      if (fmtEl && wysiwygRef.current?.contains(fmtEl)) {
        const toEnd = document.createRange();
        toEnd.selectNodeContents(fmtEl);
        toEnd.setStart(range.startContainer, range.startOffset);
        if (toEnd.toString() === '') {
          // Caret is at the end of the formatted run: just switch the format off for what comes next
          document.execCommand(cmd, false);
          updateToolbarState();
          return;
        }
        // Caret is inside the run: unwrap it and put the caret back at the same character position
        const toCaret = document.createRange();
        toCaret.selectNodeContents(fmtEl);
        toCaret.setEnd(range.startContainer, range.startOffset);
        const caretOffset = toCaret.toString().length;
        const text = fmtEl.textContent || '';
        const textNode = document.createTextNode(text);
        fmtEl.parentNode?.replaceChild(textNode, fmtEl);
        const newRange = document.createRange();
        newRange.setStart(textNode, Math.min(caretOffset, text.length));
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
        syncContent();
        updateToolbarState();
        return;
      }

      // Not inside a formatted run: format the word under the caret, or arm the format if on whitespace
      const textNode = range.startContainer;
      if (textNode.nodeType === Node.TEXT_NODE) {
        const text = textNode.nodeValue || '';
        const offset = range.startOffset;
        let start = offset;
        let end = offset;
        while (start > 0 && /\S/.test(text[start - 1])) start--;
        while (end < text.length && /\S/.test(text[end])) end++;
        if (end > start) {
          const wordRange = document.createRange();
          wordRange.setStart(textNode, start);
          wordRange.setEnd(textNode, end);
          sel.removeAllRanges();
          sel.addRange(wordRange);
        }
      }
    }

    const was = document.queryCommandState(cmd);
    document.execCommand(cmd, false);

    // If it was already formatted, make sure every wrapper covering the selection is removed
    if (was) {
      wysiwygRef.current?.querySelectorAll(selector).forEach((el) => {
        if (sel.containsNode(el, true)) {
          el.replaceWith(document.createTextNode(el.textContent || ''));
        }
      });
    }

    syncContent();
    updateToolbarState();
  }

  function toggleBold() {
    toggleInlineFormat('bold', 'strong, b');
  }

  function toggleItalic() {
    toggleInlineFormat('italic', 'em, i');
  }

  function executeFormat(cmd: string, val: string = '') {
    wysiwygRef.current?.focus();
    document.execCommand(cmd, false, val);
    syncContent();
    updateToolbarState();
  }

  function handleHighlight() {
    wysiwygRef.current?.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    // Check if already in <mark>
    let parentNode: Node | null = range.commonAncestorContainer;
    if (parentNode.nodeType === Node.TEXT_NODE) {
      parentNode = parentNode.parentNode;
    }
    if (parentNode && (parentNode as HTMLElement).tagName === 'MARK') {
      // Unwrap mark
      const mark = parentNode as HTMLElement;
      const text = mark.textContent || '';
      const textNode = document.createTextNode(text);
      mark.parentNode?.replaceChild(textNode, mark);
    } else {
      const mark = document.createElement('mark');
      mark.textContent = range.toString();
      range.deleteContents();
      range.insertNode(mark);
      sel.removeAllRanges();
      const newRange = document.createRange();
      newRange.selectNodeContents(mark);
      sel.addRange(newRange);
    }
    syncContent();
    updateToolbarState();
  }

  function handleCode() {
    wysiwygRef.current?.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    let parentNode: Node | null = range.commonAncestorContainer;
    if (parentNode.nodeType === Node.TEXT_NODE) {
      parentNode = parentNode.parentNode;
    }
    if (parentNode && (parentNode as HTMLElement).tagName === 'CODE') {
      const code = parentNode as HTMLElement;
      const text = code.textContent || '';
      const textNode = document.createTextNode(text);
      code.parentNode?.replaceChild(textNode, code);
    } else {
      const code = document.createElement('code');
      code.textContent = range.toString();
      range.deleteContents();
      range.insertNode(code);
      sel.removeAllRanges();
      const newRange = document.createRange();
      newRange.selectNodeContents(code);
      sel.addRange(newRange);
    }
    syncContent();
    updateToolbarState();
  }

  function openLinkPopover() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedSelectionRangeRef.current = sel.getRangeAt(0).cloneRange();
      const selected = sel.toString();
      setLinkText(selected || '');
    } else {
      savedSelectionRangeRef.current = null;
      setLinkText('');
    }
    setLinkUrl('');
    setIsLinkPopoverOpen(true);
  }

  function applyLink() {
    const raw = linkUrl.trim();
    const url = raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) ? `https://${raw}` : raw;
    const safeUrl = url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:')
      ? normalizeUrl(url)
      : null;
    if (!safeUrl) {
      setIsLinkPopoverOpen(false);
      return;
    }

    wysiwygRef.current?.focus();
    if (savedSelectionRangeRef.current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedSelectionRangeRef.current);

      if (savedSelectionRangeRef.current.collapsed || !savedSelectionRangeRef.current.toString()) {
        const textToUse = linkText.trim() || safeUrl;
        const a = document.createElement('a');
        a.href = safeUrl;
        a.textContent = textToUse;
        savedSelectionRangeRef.current.insertNode(a);
      } else {
        document.execCommand('createLink', false, safeUrl);
      }
    } else {
      const textToUse = linkText.trim() || safeUrl;
      const a = document.createElement('a');
      a.href = safeUrl;
      a.textContent = textToUse;
      wysiwygRef.current?.appendChild(a);
    }

    syncContent();
    setIsLinkPopoverOpen(false);
  }

  function cancelLink() {
    setIsLinkPopoverOpen(false);
  }

  async function handleUploadImageFile(file: File) {
    if (!onUploadImage || isUploading) return;
    setUploadError(null);
    if (!SUPPORTED_UPLOAD_IMAGE_TYPES.includes(file.type.toLowerCase())) {
      setUploadError('Only PNG, JPEG, GIF or WebP images can be inserted.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setIsUploading(true);
    try {
      const res = await onUploadImage(file);
      const match = res.markdown.match(/!\[(.*?)\]\((.*?)\)/);
      if (match) {
        const [, alt, src] = match;
        wysiwygRef.current?.focus();

        const img = document.createElement('img');
        const resolvedSrc = src.startsWith('/uploads/') ? `${resolveOrigin()}${src}` : src;
        const safeSrc = resolvedSrc.startsWith('https://') || resolvedSrc.startsWith('http://') || resolvedSrc.startsWith('/')
          ? normalizeUrl(resolvedSrc)
          : null;
        if (!safeSrc) return;
        img.src = safeSrc;
        img.alt = alt;

        const sel = window.getSelection();
        const savedRange = savedSelectionRangeRef.current;
        if (savedRange && wysiwygRef.current?.contains(savedRange.commonAncestorContainer)) {
          savedRange.deleteContents();
          savedRange.insertNode(img);

          const newRange = document.createRange();
          newRange.setStartAfter(img);
          newRange.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(newRange);
        } else {
          let targetP = wysiwygRef.current?.lastElementChild;
          if (!targetP || targetP.tagName.toLowerCase() !== 'p') {
            targetP = document.createElement('p');
            wysiwygRef.current?.appendChild(targetP);
          }
          targetP.appendChild(img);
        }

        syncContent();
      }
      onUploadComplete?.(latestValueRef.current);
    } catch (err) {
      console.error('Failed to upload image:', err);
      setUploadError(uploadErrorMessage(err));
    } finally {
      setIsUploading(false);
      savedSelectionRangeRef.current = null;
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  async function handleFilePickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleUploadImageFile(file);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!onUploadImage || isUploading) return;
    const file = Array.from(e.clipboardData.items)
      .find((item) => item.kind === 'file' && SUPPORTED_UPLOAD_IMAGE_TYPES.includes(item.type.toLowerCase()))
      ?.getAsFile();

    if (file) {
      e.preventDefault();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && wysiwygRef.current?.contains(sel.anchorNode)) {
        savedSelectionRangeRef.current = sel.getRangeAt(0).cloneRange();
      }
      void handleUploadImageFile(file);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!onUploadImage || isUploading) return;
    const file = Array.from(e.dataTransfer.files).find((f) =>
      SUPPORTED_UPLOAD_IMAGE_TYPES.includes(f.type.toLowerCase())
    );
    if (file) {
      e.preventDefault();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && wysiwygRef.current?.contains(sel.anchorNode)) {
        savedSelectionRangeRef.current = sel.getRangeAt(0).cloneRange();
      }
      void handleUploadImageFile(file);
    }
  }


  function handleKeyDown(e: React.KeyboardEvent) {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key === 'Enter') {
      e.preventDefault();
      syncContent();
      if (onSubmit) {
        onSubmit();
      } else {
        finishEditing();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (onCancel) {
        e.preventDefault();
        onCancel();
        return;
      }
    }
    if (isMod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      handleUndo();
      return;
    }
    if ((isMod && e.shiftKey && e.key.toLowerCase() === 'z') || (isMod && e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      handleRedo();
      return;
    }
    if (isMod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleBold();
      return;
    }
    if (isMod && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      toggleItalic();
      return;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // RENDER: READ-ONLY VIEW
  // ══════════════════════════════════════════════════════════════
  if (!isEditing) {
    return (
      <div
        className={`${styles.viewArea} ${compact ? styles.viewAreaCompact : ''} ${readOnly ? styles.viewAreaReadOnly : ''} ${viewClassName || ''}`}
        onClick={startEditing}
        role="button"
        tabIndex={readOnly ? -1 : 0}
        aria-label={editAriaLabel}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            startEditing();
          }
        }}
      >
        {value ? (
          <MarkdownRenderer>{value}</MarkdownRenderer>
        ) : (
          <span className={styles.placeholder}>{placeholderText}</span>
        )}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // RENDER: EDITING (Approach B WYSIWYG)
  // ══════════════════════════════════════════════════════════════
  const popoverLeft = linkBtnRef.current?.offsetLeft ?? 200;

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <div className={`${styles.editContainer} ${compact ? styles.editContainerCompact : ''}`}>
        {/* Toolbar Header (no Write/Preview tabs in Approach B) */}
        <div className={`${styles.toolbarHeader} ${compact ? styles.toolbarHeaderCompact : ''}`}>
          <div className={styles.toolsGroup}>
            {/* Undo (Hoàn tác) */}
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Undo"
              title="Undo (⌘Z / Ctrl+Z)"
              onMouseDown={(e) => {
                e.preventDefault();
                handleUndo();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>
            </button>

            {/* Redo (Làm lại) */}
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Redo"
              title="Redo (⌘⇧Z / Ctrl+Y)"
              onMouseDown={(e) => {
                e.preventDefault();
                handleRedo();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 7v6h-6" />
                <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
              </svg>
            </button>

            <span className={styles.divider} />

            {/* Bold */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${isBold ? styles.toolbarBtnActive : ''}`}
              aria-label="Bold"
              title="Bold (⌘B / Ctrl+B)"
              onMouseDown={(e) => {
                e.preventDefault();
                toggleBold();
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 800 }}>B</span>
            </button>

            {/* Italic */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${isItalic ? styles.toolbarBtnActive : ''}`}
              aria-label="Italic"
              title="Italic (⌘I / Ctrl+I)"
              onMouseDown={(e) => {
                e.preventDefault();
                toggleItalic();
              }}
            >
              <span style={{ fontSize: 14, fontStyle: 'italic', fontWeight: 600 }}>i</span>
            </button>

            {/* Highlight */}
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Highlight"
              title="Highlight"
              onMouseDown={(e) => {
                e.preventDefault();
                handleHighlight();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11L15 5L19 9L13 15" />
                <path d="M9 11L13 15L7 19H3V15L9 11Z" />
              </svg>
            </button>

            <span className={styles.divider} />

            {/* Heading H2 */}
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Heading"
              title="Heading 2"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('formatBlock', '<h2>');
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>H2</span>
            </button>

            {/* Bulleted list */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${isList ? styles.toolbarBtnActive : ''}`}
              aria-label="Bulleted list"
              title="Bulleted list"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('insertUnorderedList');
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="4.5" cy="6" r="1" />
                <circle cx="4.5" cy="12" r="1" />
                <circle cx="4.5" cy="18" r="1" />
                <path d="M9 6H20" />
                <path d="M9 12H20" />
                <path d="M9 18H20" />
              </svg>
            </button>

            {/* Quote */}
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Quote"
              title="Quote"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('formatBlock', '<blockquote>');
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 15C9 15 10 13.5 10 11.5C10 9.5 8.5 8 6.5 8C4.5 8 3 9.5 3 11.5C3 14.5 5 17 8 18" />
                <path d="M17 15C19 15 20 13.5 20 11.5C20 9.5 18.5 8 16.5 8C14.5 8 13 9.5 13 11.5C13 14.5 15 17 18 18" />
              </svg>
            </button>

            {/* Code */}
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Code"
              title="Code"
              onMouseDown={(e) => {
                e.preventDefault();
                handleCode();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 6L2 12L8 18" />
                <path d="M16 6L22 12L16 18" />
              </svg>
            </button>

            {/* Link (with popover) */}
            <button
              ref={linkBtnRef}
              type="button"
              className={`${styles.toolbarBtn} ${isLinkPopoverOpen ? styles.toolbarBtnActive : ''}`}
              aria-label="Link"
              title="Link"
              onMouseDown={(e) => {
                e.preventDefault();
                if (isLinkPopoverOpen) {
                  setIsLinkPopoverOpen(false);
                } else {
                  openLinkPopover();
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13.5C10.8 14.6 12.4 14.7 13.5 13.8L17 11C18.3 9.9 18.5 8 17.4 6.7C16.3 5.4 14.4 5.2 13.1 6.3L11.3 7.9" />
                <path d="M14 10.5C13.2 9.4 11.6 9.3 10.5 10.2L7 13C5.7 14.1 5.5 16 6.6 17.3C7.7 18.6 9.6 18.8 10.9 17.7L12.7 16.1" />
              </svg>
            </button>

            {/* Image upload */}
            {onUploadImage && (
              <>
                <button
                  type="button"
                  className={styles.toolbarBtn}
                  aria-label="Image"
                  title="Upload Image"
                  disabled={isUploading}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const sel = window.getSelection();
                    if (sel && sel.rangeCount > 0 && wysiwygRef.current?.contains(sel.anchorNode)) {
                      savedSelectionRangeRef.current = sel.getRangeAt(0).cloneRange();
                    } else {
                      savedSelectionRangeRef.current = null;
                    }
                    if (isFilePickerOpenRef.current) return;
                    isFilePickerOpenRef.current = true;
                    window.addEventListener(
                      'focus',
                      () => {
                        isFilePickerOpenRef.current = false;
                      },
                      { once: true }
                    );
                    fileInputRef.current?.click();
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <circle cx="8.5" cy="9.5" r="1.5" />
                    <path d="M21 15L16 10L5 21" />
                  </svg>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={FILE_INPUT_ACCEPT}
                  className={styles.fileInput}
                  onChange={handleFilePickerChange}
                />
              </>
            )}

            <span className={styles.divider} />

            {/* Align left */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${align === 'left' ? styles.toolbarBtnActive : ''}`}
              aria-label="Align left"
              title="Align left"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('justifyLeft');
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 6H21" />
                <path d="M3 12H15" />
                <path d="M3 18H18" />
              </svg>
            </button>

            {/* Align center */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${align === 'center' ? styles.toolbarBtnActive : ''}`}
              aria-label="Align center"
              title="Align center"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('justifyCenter');
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 6H21" />
                <path d="M6 12H18" />
                <path d="M4.5 18H19.5" />
              </svg>
            </button>

            {/* Align right */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${align === 'right' ? styles.toolbarBtnActive : ''}`}
              aria-label="Align right"
              title="Align right"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('justifyRight');
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 6H21" />
                <path d="M9 12H21" />
                <path d="M6 18H21" />
              </svg>
            </button>
          </div>

          {/* Link Popover matching description-markdown-5-link-popover.png */}
          {isLinkPopoverOpen && (
            <div
              className={styles.linkPopover}
              style={{ left: Math.min(popoverLeft, 400) }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className={styles.popoverUrlRow}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9AA8A0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M10 13.5C10.8 14.6 12.4 14.7 13.5 13.8L17 11C18.3 9.9 18.5 8 17.4 6.7C16.3 5.4 14.4 5.2 13.1 6.3L11.3 7.9" />
                  <path d="M14 10.5C13.2 9.4 11.6 9.3 10.5 10.2L7 13C5.7 14.1 5.5 16 6.6 17.3C7.7 18.6 9.6 18.8 10.9 17.7L12.7 16.1" />
                </svg>
                <input
                  className={styles.popoverUrlInput}
                  placeholder="https://…"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyLink();
                    if (e.key === 'Escape') cancelLink();
                  }}
                  autoFocus
                />
              </div>

              <div className={styles.popoverDivider} />

              <div className={styles.popoverLabel}>Text</div>
              <input
                className={styles.popoverTextDisplay}
                value={linkText}
                placeholder="Link text…"
                onChange={(e) => setLinkText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyLink();
                  if (e.key === 'Escape') cancelLink();
                }}
              />

              <div className={styles.popoverActions}>
                <button type="button" className={styles.popoverCancelBtn} onClick={cancelLink}>
                  Cancel
                </button>
                <button type="button" className={styles.popoverApplyBtn} onClick={applyLink}>
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>

        {isUploading && <div className={styles.uploadStatus}>Uploading image...</div>}
        {uploadError && (
          <div className={styles.uploadError} role="alert">
            {uploadError}
          </div>
        )}

        {/* Approach B: WYSIWYG Content Area */}
        <div
          ref={wysiwygRef}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          className={`${styles.wysiwygArea} ${compact ? styles.wysiwygAreaCompact : ''}`}
          data-placeholder={placeholderText}
          onInput={() => {
            syncContent();
            updateToolbarState();
          }}
          onKeyUp={updateToolbarState}
          onMouseUp={updateToolbarState}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onClick={(e) => {
            if ((e.target as HTMLElement).tagName === 'INPUT') syncContent();
          }}
          onBlur={() => {
            if (dirtyRef.current) syncContent();
          }}
        />

        {actions && <div className={styles.editorActions}>{actions}</div>}
      </div>

    </div>
  );
}
