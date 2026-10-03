import { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { markdownToHtml, htmlToMarkdown } from '../utils/markdownWysiwyg';
import styles from './MarkdownEditor.module.css';

const SUPPORTED_UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const FILE_INPUT_ACCEPT = SUPPORTED_UPLOAD_IMAGE_TYPES.join(',');

interface Props {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
  onUploadImage?: (file: File) => Promise<{ markdown: string }>;
  onUploadComplete?: (value: string) => void;
  readOnly?: boolean;
  startInEditMode?: boolean;
  placeholderText?: string;
  editAriaLabel?: string;
  viewClassName?: string;
}

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onUploadImage,
  onUploadComplete,
  readOnly = false,
  startInEditMode = false,
  placeholderText = 'Add a description…',
  editAriaLabel = 'Edit description',
  viewClassName,
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

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  // Initial populate of contentEditable when entering edit mode
  useEffect(() => {
    if (isEditing && wysiwygRef.current) {
      const html = markdownToHtml(latestValueRef.current);
      wysiwygRef.current.innerHTML = html;
      requestAnimationFrame(() => {
        wysiwygRef.current?.focus();
      });
    }
  }, [isEditing]);

  // Click outside listener to exit edit mode and save
  useEffect(() => {
    if (!isEditing) return;

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
  }, [isEditing, isLinkPopoverOpen]);

  function syncContent() {
    if (!wysiwygRef.current) return;
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
    const md = htmlToMarkdown(wysiwygRef.current);
    latestValueRef.current = md;
    onChange(md);
    setIsEditing(false);
    setIsLinkPopoverOpen(false);
    onBlur?.(md);
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
    const url = linkUrl.trim();
    if (!url) {
      setIsLinkPopoverOpen(false);
      return;
    }

    wysiwygRef.current?.focus();
    if (savedSelectionRangeRef.current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedSelectionRangeRef.current);

      if (savedSelectionRangeRef.current.collapsed || !savedSelectionRangeRef.current.toString()) {
        const textToUse = linkText.trim() || url;
        const a = document.createElement('a');
        a.href = url.startsWith('http') ? url : `https://${url}`;
        a.textContent = textToUse;
        savedSelectionRangeRef.current.insertNode(a);
      } else {
        document.execCommand('createLink', false, url.startsWith('http') ? url : `https://${url}`);
      }
    } else {
      const textToUse = linkText.trim() || url;
      const a = document.createElement('a');
      a.href = url.startsWith('http') ? url : `https://${url}`;
      a.textContent = textToUse;
      wysiwygRef.current?.appendChild(a);
    }

    syncContent();
    setIsLinkPopoverOpen(false);
  }

  function cancelLink() {
    setIsLinkPopoverOpen(false);
  }

  async function handleFilePickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !onUploadImage) return;

    setIsUploading(true);
    try {
      const res = await onUploadImage(file);
      // res.markdown is ![alt](url)
      const match = res.markdown.match(/!\[(.*?)\]\((.*?)\)/);
      if (match) {
        const [, alt, src] = match;
        wysiwygRef.current?.focus();
        document.execCommand('insertImage', false, src);
        // Find inserted img and add alt
        const imgs = wysiwygRef.current?.querySelectorAll('img');
        if (imgs && imgs.length > 0) {
          const lastImg = imgs[imgs.length - 1];
          if (lastImg && !lastImg.getAttribute('alt')) {
            lastImg.setAttribute('alt', alt);
          }
        }
        syncContent();
      }
      onUploadComplete?.(latestValueRef.current);
    } catch {
      // upload error handled in mutation
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // RENDER: READ-ONLY VIEW
  // ══════════════════════════════════════════════════════════════
  if (!isEditing) {
    return (
      <div
        className={`${styles.viewArea} ${readOnly ? styles.viewAreaReadOnly : ''} ${viewClassName || ''}`}
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
      <div className={styles.editContainer}>
        {/* Toolbar Header (no Write/Preview tabs in Approach B) */}
        <div className={styles.toolbarHeader}>
          <div className={styles.toolsGroup}>
            {/* Bold */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${isBold ? styles.toolbarBtnActive : ''}`}
              aria-label="Bold"
              title="Bold"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('bold');
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 800 }}>B</span>
            </button>

            {/* Italic */}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${isItalic ? styles.toolbarBtnActive : ''}`}
              aria-label="Italic"
              title="Italic"
              onMouseDown={(e) => {
                e.preventDefault();
                executeFormat('italic');
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

        {/* Approach B: WYSIWYG Content Area */}
        <div
          ref={wysiwygRef}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          className={styles.wysiwygArea}
          data-placeholder={placeholderText}
          onInput={() => {
            syncContent();
            updateToolbarState();
          }}
          onKeyUp={updateToolbarState}
          onMouseUp={updateToolbarState}
          onBlur={syncContent}
        />
      </div>

      <div className={styles.hintText}>
        Same toolbar as Approach A, same buttons — the only difference is what&apos;s underneath it: rendered content you type straight into, instead of raw Markdown text. Select a word, hit Bold, it turns bold right there.
      </div>
    </div>
  );
}
