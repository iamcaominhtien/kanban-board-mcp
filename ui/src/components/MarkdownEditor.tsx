import { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
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
  const [activeTab, setActiveTab] = useState<'write' | 'preview'>('write');
  const [isUploading, setIsUploading] = useState(false);

  // Link Popover state
  const [isLinkPopoverOpen, setIsLinkPopoverOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const [linkSelectionRange, setLinkSelectionRange] = useState<{ start: number; end: number } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestValueRef = useRef(value);
  const isFilePickerOpenRef = useRef(false);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  // Auto-resize textarea to fit content
  useEffect(() => {
    if (isEditing && activeTab === 'write' && textareaRef.current) {
      const ta = textareaRef.current;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(180, ta.scrollHeight)}px`;
    }
  }, [isEditing, activeTab, value]);

  // Click outside listener to exit edit mode and save
  useEffect(() => {
    if (!isEditing) return;

    function handleClickOutside(e: MouseEvent) {
      if (isFilePickerOpenRef.current) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsEditing(false);
        setIsLinkPopoverOpen(false);
        onBlur?.(latestValueRef.current);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isEditing, onBlur]);

  function startEditing() {
    if (readOnly) return;
    setActiveTab('write');
    setIsEditing(true);
  }

  function finishEditing() {
    setIsEditing(false);
    setIsLinkPopoverOpen(false);
    onBlur?.(latestValueRef.current);
  }

  function updateValue(nextValue: string, selectionStart?: number, selectionEnd?: number) {
    latestValueRef.current = nextValue;
    onChange(nextValue);

    if (selectionStart === undefined || selectionEnd === undefined) {
      return;
    }

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function insertMarkdown(before: string, after: string, placeholder: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end, value: v } = ta;
    const selected = v.slice(start, end) || placeholder;
    const newValue = v.slice(0, start) + before + selected + after + v.slice(end);
    const hadSelection = end > start;
    if (hadSelection || !placeholder) {
      const newCursor = start + before.length + selected.length + after.length;
      updateValue(newValue, newCursor, newCursor);
      return;
    }

    const placeholderStart = start + before.length;
    updateValue(newValue, placeholderStart, placeholderStart + placeholder.length);
  }

  function openLinkPopover() {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end, value: v } = ta;
    const selected = v.slice(start, end);
    setLinkText(selected || '');
    setLinkUrl('');
    setLinkSelectionRange({ start, end });
    setIsLinkPopoverOpen(true);
  }

  function applyLink() {
    if (!linkSelectionRange || !textareaRef.current) {
      setIsLinkPopoverOpen(false);
      return;
    }
    const { start, end } = linkSelectionRange;
    const v = latestValueRef.current;
    const textToUse = linkText.trim() || 'link';
    const urlToUse = linkUrl.trim() || '#';
    const markdown = `[${textToUse}](${urlToUse})`;
    const newValue = v.slice(0, start) + markdown + v.slice(end);
    const newCursor = start + markdown.length;
    updateValue(newValue, newCursor, newCursor);
    setIsLinkPopoverOpen(false);
  }

  function cancelLink() {
    setIsLinkPopoverOpen(false);
  }

  async function handleImageUpload(file: File) {
    if (!onUploadImage || isUploading) return;

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayName = (file.name.replace(/\.[^.]+$/, '') || 'image').replace(/[[\]()!]/g, '');
    const placeholder = `![Uploading ${displayName}...](uploading:${uploadId})`;
    
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end, value: v } = ta;
    const newValue = v.slice(0, start) + placeholder + v.slice(end);
    updateValue(newValue, start + placeholder.length, start + placeholder.length);

    setIsUploading(true);
    try {
      const result = await onUploadImage(file);
      const updatedValue = latestValueRef.current.replace(placeholder, result.markdown);
      if (updatedValue !== latestValueRef.current) {
        updateValue(updatedValue);
        onUploadComplete?.(updatedValue);
      }
    } catch {
      const revertedValue = latestValueRef.current.replace(placeholder, '');
      if (revertedValue !== latestValueRef.current) {
        updateValue(revertedValue);
        onUploadComplete?.(revertedValue);
      }
    } finally {
      setIsUploading(false);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!onUploadImage || isUploading) return;

    const imageFile = Array.from(e.clipboardData.items)
      .find((item) => item.kind === 'file' && SUPPORTED_UPLOAD_IMAGE_TYPES.includes(item.type.toLowerCase()))
      ?.getAsFile();

    if (!imageFile) return;

    e.preventDefault();
    void handleImageUpload(imageFile);
  }

  function handleFilePickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    isFilePickerOpenRef.current = false;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!SUPPORTED_UPLOAD_IMAGE_TYPES.includes(file.type.toLowerCase())) return;
    void handleImageUpload(file);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      finishEditing();
    }
  }

  if (!isEditing) {
    return (
      <div
        className={`${styles.viewArea}${readOnly ? ` ${styles.viewAreaReadOnly}` : ''}${viewClassName ? ` ${viewClassName}` : ''}`}
        onClick={startEditing}
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
        onKeyDown={readOnly ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') startEditing();
        }}
        aria-label={readOnly ? undefined : editAriaLabel}
      >
        {value ? (
          <MarkdownRenderer>{value}</MarkdownRenderer>
        ) : (
          <span className={styles.placeholder}>{placeholderText}</span>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <div className={styles.editContainer}>
        <div className={styles.toolbarHeader}>
          {/* Tabs: Write & Preview */}
          <div className={styles.tabs}>
            <button
              type="button"
              className={`${styles.tab} ${activeTab === 'write' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('write')}
            >
              Write
            </button>
            <button
              type="button"
              className={`${styles.tab} ${activeTab === 'preview' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('preview')}
            >
              Preview
            </button>
          </div>

          {/* Toolbar buttons (hidden in preview tab, matching design) */}
          {activeTab === 'write' && (
            <div className={styles.toolsGroup}>
              {/* Bold */}
              <button
                type="button"
                className={styles.toolbarBtn}
                aria-label="Bold"
                title="Bold (**text**)"
                onMouseDown={(e) => { e.preventDefault(); insertMarkdown('**', '**', 'bold text'); }}
              >
                <span style={{ fontSize: 14, fontWeight: 800 }}>B</span>
              </button>

              {/* Italic */}
              <button
                type="button"
                className={styles.toolbarBtn}
                aria-label="Italic"
                title="Italic (*text*)"
                onMouseDown={(e) => { e.preventDefault(); insertMarkdown('*', '*', 'italic text'); }}
              >
                <span style={{ fontSize: 14, fontStyle: 'italic', fontWeight: 600 }}>i</span>
              </button>

              {/* Highlight */}
              <button
                type="button"
                className={styles.toolbarBtn}
                aria-label="Highlight"
                title="Highlight (<mark>text</mark>)"
                onMouseDown={(e) => { e.preventDefault(); insertMarkdown('<mark>', '</mark>', 'highlighted text'); }}
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
                title="Heading (## Title)"
                onMouseDown={(e) => { e.preventDefault(); insertMarkdown('\n## ', '', 'Heading'); }}
              >
                <span style={{ fontSize: 12, fontWeight: 700 }}>H2</span>
              </button>

              {/* Bulleted list */}
              <button
                type="button"
                className={styles.toolbarBtn}
                aria-label="Bulleted list"
                title="Bulleted list (- item)"
                onMouseDown={(e) => { e.preventDefault(); insertMarkdown('\n- ', '', 'List item'); }}
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
                title="Quote (> quote)"
                onMouseDown={(e) => { e.preventDefault(); insertMarkdown('\n> ', '', 'Quote'); }}
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
                title="Code (`code`)"
                onMouseDown={(e) => { e.preventDefault(); insertMarkdown('`', '`', 'code'); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 6L2 12L8 18" />
                  <path d="M16 6L22 12L16 18" />
                </svg>
              </button>

              {/* Link (with popover) */}
              <button
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
                      window.addEventListener('focus', () => {
                        isFilePickerOpenRef.current = false;
                      }, { once: true });
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
                className={styles.toolbarBtn}
                aria-label="Align left"
                title="Align left"
                onMouseDown={(e) => {
                  e.preventDefault();
                  // standard default left alignment
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
                className={styles.toolbarBtn}
                aria-label="Align center"
                title="Align center (::: center)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMarkdown('\n::: center\n', '\n:::\n', 'Centered content');
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
                className={styles.toolbarBtn}
                aria-label="Align right"
                title="Align right (::: right)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMarkdown('\n::: right\n', '\n:::\n', 'Right-aligned content');
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M3 6H21" />
                  <path d="M9 12H21" />
                  <path d="M6 18H21" />
                </svg>
              </button>
            </div>
          )}

          {/* Link Popover */}
          {isLinkPopoverOpen && (
            <div className={styles.linkPopover} onMouseDown={(e) => e.stopPropagation()}>
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

        {activeTab === 'write' ? (
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={value}
            onChange={(e) => updateValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            autoFocus
            placeholder="Write description here in Markdown…"
          />
        ) : (
          <div className={styles.previewContainer}>
            {value ? (
              <MarkdownRenderer>{value}</MarkdownRenderer>
            ) : (
              <span className={styles.placeholder} style={{ padding: '8px 0', display: 'block' }}>Nothing to preview</span>
            )}
          </div>
        )}
      </div>

      <div className={styles.hintText}>
        Toolbar buttons insert Markdown syntax at the cursor — they don't format live text like a rich editor.
      </div>
    </div>
  );
}
