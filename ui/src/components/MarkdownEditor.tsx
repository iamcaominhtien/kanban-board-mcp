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
  placeholderText = 'Click to add a description...',
  editAriaLabel = 'Edit description',
  viewClassName,
}: Props) {
  const [isEditing, setIsEditing] = useState(startInEditMode);
  const [activeTab, setActiveTab] = useState<'write' | 'preview'>('write');
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestValueRef = useRef(value);
  const initialValueOnEditRef = useRef(value);
  const pendingUploadPlaceholdersRef = useRef(new Map<string, string>());
  const isFilePickerOpenRef = useRef(false);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  function startEditing() {
    if (readOnly) return;
    initialValueOnEditRef.current = value;
    setActiveTab('write');
    setIsEditing(true);
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

  function insertTextAtCursor(text: string) {
    const textarea = textareaRef.current;
    if (!textarea) return null;

    const { selectionStart: start, selectionEnd: end, value: currentValue } = textarea;
    const nextValue = currentValue.slice(0, start) + text + currentValue.slice(end);
    const nextCursor = start + text.length;
    updateValue(nextValue, nextCursor, nextCursor);
    return { nextValue, start };
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

  function getPersistableValue() {
    let nextValue = latestValueRef.current;
    pendingUploadPlaceholdersRef.current.forEach((placeholder) => {
      nextValue = nextValue.replace(placeholder, '');
    });
    return nextValue;
  }

  function handleSave() {
    const finalVal = getPersistableValue();
    setIsEditing(false);
    onBlur?.(finalVal);
  }

  function handleCancel() {
    onChange(initialValueOnEditRef.current);
    setIsEditing(false);
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    latestValueRef.current = e.target.value;
    onChange(e.target.value);
  }

  async function handleImageUpload(file: File) {
    if (!onUploadImage || isUploading) return;

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayName = (file.name.replace(/\.[^.]+$/, '') || 'image').replace(/[[\]()!]/g, '');
    const placeholder = `![Uploading ${displayName}...](uploading:${uploadId})`;
    pendingUploadPlaceholdersRef.current.set(uploadId, placeholder);
    const inserted = insertTextAtCursor(placeholder);
    if (!inserted) {
      pendingUploadPlaceholdersRef.current.delete(uploadId);
      return;
    }

    setIsUploading(true);
    try {
      const result = await onUploadImage(file);
      pendingUploadPlaceholdersRef.current.delete(uploadId);
      const updatedValue = latestValueRef.current.replace(placeholder, result.markdown);
      if (updatedValue !== latestValueRef.current) {
        const cursor = inserted.start + result.markdown.length;
        updateValue(updatedValue, cursor, cursor);
        onUploadComplete?.(updatedValue);
      }
    } catch {
      pendingUploadPlaceholdersRef.current.delete(uploadId);
      const revertedValue = latestValueRef.current.replace(placeholder, '');
      if (revertedValue !== latestValueRef.current) {
        updateValue(revertedValue, inserted.start, inserted.start);
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
      handleCancel();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
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
    <div ref={containerRef} className={styles.editContainer}>
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

        {/* Toolbar buttons (hidden in preview tab) */}
        {activeTab === 'write' && (
          <div className={styles.toolsGroup}>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Bold"
              title="Bold (**text**)"
              onMouseDown={(e) => { e.preventDefault(); insertMarkdown('**', '**', 'bold text'); }}
            >
              <strong style={{ fontSize: 13, fontWeight: 800 }}>B</strong>
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Italic"
              title="Italic (*text*)"
              onMouseDown={(e) => { e.preventDefault(); insertMarkdown('*', '*', 'italic text'); }}
            >
              <span style={{ fontSize: 13, fontStyle: 'italic', fontWeight: 600 }}>i</span>
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Heading"
              title="Heading 2 (## Title)"
              onMouseDown={(e) => { e.preventDefault(); insertMarkdown('## ', '', 'Heading'); }}
            >
              <span style={{ fontSize: 11, fontWeight: 700 }}>H2</span>
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Bulleted list"
              title="Bullet list (- item)"
              onMouseDown={(e) => { e.preventDefault(); insertMarkdown('\n- ', '', 'List item'); }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" />
                <path d="M9 6H20" /><path d="M9 12H20" /><path d="M9 18H20" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Quote"
              title="Quote (> blockquote)"
              onMouseDown={(e) => { e.preventDefault(); insertMarkdown('\n> ', '', 'Quote'); }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 15C9 15 10 13.5 10 11.5C10 9.5 8.5 8 6.5 8C4.5 8 3 9.5 3 11.5C3 14.5 5 17 8 18" />
                <path d="M17 15C19 15 20 13.5 20 11.5C20 9.5 18.5 8 16.5 8C14.5 8 13 9.5 13 11.5C13 14.5 15 17 18 18" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Code"
              title="Code (`code`)"
              onMouseDown={(e) => { e.preventDefault(); insertMarkdown('`', '`', 'code'); }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 6L2 12L8 18" /><path d="M16 6L22 12L16 18" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Link"
              title="Link ([text](url))"
              onMouseDown={(e) => { e.preventDefault(); insertMarkdown('[', '](url)', 'link text'); }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13.5C10.8 14.6 12.4 14.7 13.5 13.8L17 11C18.3 9.9 18.5 8 17.4 6.7C16.3 5.4 14.4 5.2 13.1 6.3L11.3 7.9" />
                <path d="M14 10.5C13.2 9.4 11.6 9.3 10.5 10.2L7 13C5.7 14.1 5.5 16 6.6 17.3C7.7 18.6 9.6 18.8 10.9 17.7L12.7 16.1" />
              </svg>
            </button>

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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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

            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Callout warning"
              title="Callout note"
              onMouseDown={(e) => {
                e.preventDefault();
                insertMarkdown('\n> **Note:** ', '\n', 'Important context here');
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9V13" /><circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
                <path d="M10.3 3.9L2.5 17.5C1.9 18.6 2.7 20 4 20H19.9C21.2 20 22.1 18.6 21.4 17.5L13.7 3.9C13 2.7 11.1 2.7 10.3 3.9Z" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {isUploading && <div className={styles.uploadStatus}>Uploading image...</div>}

      {activeTab === 'write' ? (
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={value}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          autoFocus
          rows={7}
          placeholder="Write markdown here..."
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

      <div className={styles.footerActions}>
        <button type="button" className={styles.cancelBtn} onClick={handleCancel}>
          Cancel
        </button>
        <button type="button" className={styles.doneBtn} onClick={handleSave}>
          Done
        </button>
      </div>
    </div>
  );
}
