import { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import styles from './MarkdownEditor.module.css';

// TODO(backend): the design calls for a consolidated Attachments section
// showing every file from the description + all comments in one place.
// Doing this client-side would mean re-parsing every comment's markdown on
// every render; a dedicated attachments-index endpoint would be better.
// Not implemented — see design/ mockups (Attachments.dc.html) for the spec.
const SUPPORTED_UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const FILE_INPUT_ACCEPT = SUPPORTED_UPLOAD_IMAGE_TYPES.join(',');

interface ToolbarButton {
  label: string;
  before: string;
  after: string;
  placeholder: string;
}

const TOOLBAR: ToolbarButton[] = [
  { label: 'B',      before: '**',        after: '**',      placeholder: 'bold text' },
  { label: 'I',      before: '*',         after: '*',       placeholder: 'italic text' },
  { label: 'H1',     before: '# ',        after: '',        placeholder: 'Heading 1' },
  { label: 'H2',     before: '## ',       after: '',        placeholder: 'Heading 2' },
  { label: 'H3',     before: '### ',      after: '',        placeholder: 'Heading 3' },
  { label: '`code`', before: '`',         after: '`',       placeholder: 'code' },
  { label: '```',    before: '\n```\n',   after: '\n```\n', placeholder: 'code block' },
  { label: 'UL',     before: '\n- ',      after: '',        placeholder: 'list item' },
  { label: 'OL',     before: '\n1. ',     after: '',        placeholder: 'list item' },
  { label: '>',      before: '\n> ',      after: '',        placeholder: 'blockquote' },
  { label: '—',      before: '\n---\n',   after: '',        placeholder: '' },
];

/** Icons for the buttons that don't use a plain text label. */
function HighlightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11L15 5L19 9L13 15" />
      <path d="M9 11L13 15L7 19H3V15L9 11Z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13.5C10.8 14.6 12.4 14.7 13.5 13.8L17 11C18.3 9.9 18.5 8 17.4 6.7C16.3 5.4 14.4 5.2 13.1 6.3L11.3 7.9" />
      <path d="M14 10.5C13.2 9.4 11.6 9.3 10.5 10.2L7 13C5.7 14.1 5.5 16 6.6 17.3C7.7 18.6 9.6 18.8 10.9 17.7L12.7 16.1" />
    </svg>
  );
}

function AlignLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M3 6H21" /><path d="M3 12H15" /><path d="M3 18H18" />
    </svg>
  );
}

function AlignCenterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M3 6H21" /><path d="M6 12H18" /><path d="M4.5 18H19.5" />
    </svg>
  );
}

function AlignRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M3 6H21" /><path d="M9 12H21" /><path d="M6 18H21" />
    </svg>
  );
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
  onUploadImage?: (file: File) => Promise<{ markdown: string }>;
  onUploadComplete?: (value: string) => void;
  readOnly?: boolean;
  startInEditMode?: boolean;
  /** Text shown in the collapsed view when there's no content yet. */
  placeholderText?: string;
  /** aria-label for the collapsed, clickable view. */
  editAriaLabel?: string;
  /** Extra class appended to the collapsed view, to override its look per use case. */
  viewClassName?: string;
}

interface LinkPopoverState {
  /** Selection range in the textarea to replace when Apply is pressed. */
  start: number;
  end: number;
  /** Whether text was selected when the Link button was pressed. */
  hadSelection: boolean;
  /** The selected text, shown read-only, when hadSelection is true. */
  selectedText: string;
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
  const [isUploading, setIsUploading] = useState(false);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [linkPopover, setLinkPopover] = useState<LinkPopoverState | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkPopoverRef = useRef<HTMLDivElement>(null);
  const linkUrlInputRef = useRef<HTMLInputElement>(null);
  const latestValueRef = useRef(value);
  const pendingUploadPlaceholdersRef = useRef(new Map<string, string>());
  const isFilePickerOpenRef = useRef(false);
  // Best-effort remembered cursor position, so switching Preview -> Write
  // doesn't reset the textarea's caret to the start.
  const lastSelectionRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  // Restore the remembered selection when coming back to Write mode.
  useEffect(() => {
    if (mode !== 'write' || !lastSelectionRef.current) {
      return;
    }
    const { start, end } = lastSelectionRef.current;
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      try {
        textarea.setSelectionRange(start, end);
      } catch {
        // ignore out-of-range selection (e.g. content shrank)
      }
    });
  }, [mode]);

  // Close the Link popover on outside click or Escape.
  useEffect(() => {
    if (!linkPopover) return;
    function onPointerDown(e: MouseEvent) {
      if (linkPopoverRef.current && !linkPopoverRef.current.contains(e.target as Node)) {
        setLinkPopover(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setLinkPopover(null);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [linkPopover]);

  function updateValue(nextValue: string, selectionStart?: number, selectionEnd?: number) {
    latestValueRef.current = nextValue;
    onChange(nextValue);

    if (selectionStart === undefined || selectionEnd === undefined) {
      return;
    }

    lastSelectionRef.current = { start: selectionStart, end: selectionEnd };
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function insertTextAtCursor(text: string) {
    const textarea = textareaRef.current;
    if (!textarea) {
      return null;
    }

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

  /** Wraps the current selection (or inserts a placeholder block) in a `::: name` … `:::` container. */
  function insertAlignBlock(name: 'center' | 'right') {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end, value: v } = ta;
    const selected = v.slice(start, end) || 'aligned text';
    const block = `\n::: ${name}\n${selected}\n:::\n`;
    const newValue = v.slice(0, start) + block + v.slice(end);
    const newCursor = start + block.length;
    updateValue(newValue, newCursor, newCursor);
  }

  function openLinkPopover() {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end, value: v } = ta;
    const hadSelection = end > start;
    const selectedText = v.slice(start, end);
    setLinkUrl('');
    setLinkLabel('');
    setLinkPopover({ start, end, hadSelection, selectedText });
    requestAnimationFrame(() => linkUrlInputRef.current?.focus());
  }

  function applyLink() {
    if (!linkPopover) return;
    const { start, end, hadSelection, selectedText } = linkPopover;
    const label = (hadSelection ? selectedText : linkLabel.trim()) || 'link text';
    const url = linkUrl.trim() || 'url';
    const text = `[${label}](${url})`;
    const currentValue = latestValueRef.current;
    const nextValue = currentValue.slice(0, start) + text + currentValue.slice(end);
    const nextCursor = start + text.length;
    updateValue(nextValue, nextCursor, nextCursor);
    setLinkPopover(null);
  }

  function getPersistableValue() {
    let nextValue = latestValueRef.current;
    pendingUploadPlaceholdersRef.current.forEach((placeholder) => {
      nextValue = nextValue.replace(placeholder, '');
    });
    return nextValue;
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    latestValueRef.current = e.target.value;
    onChange(e.target.value);
  }

  function handleTextareaSelect(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    const target = e.currentTarget;
    lastSelectionRef.current = { start: target.selectionStart, end: target.selectionEnd };
  }

  async function handleImageUpload(file: File) {
    if (!onUploadImage || isUploading) {
      return;
    }

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayName = (file.name.replace(/\.[^.]+$/, '') || 'image')
      .replace(/[[\]()!]/g, '');
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
    if (!onUploadImage || isUploading) {
      return;
    }

    const imageFile = Array.from(e.clipboardData.items)
      .find((item) => item.kind === 'file' && SUPPORTED_UPLOAD_IMAGE_TYPES.includes(item.type.toLowerCase()))
      ?.getAsFile();

    if (!imageFile) {
      return;
    }

    e.preventDefault();
    void handleImageUpload(imageFile);
  }

  function handleFilePickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    isFilePickerOpenRef.current = false;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    if (!SUPPORTED_UPLOAD_IMAGE_TYPES.includes(file.type.toLowerCase())) {
      return;
    }
    void handleImageUpload(file);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.nativeEvent.stopImmediatePropagation();
      setIsEditing(false);
    }
  }

  function handleBlur(e: React.FocusEvent) {
    if (isFilePickerOpenRef.current) {
      return;
    }
    if (linkPopover) {
      // Don't collapse the editor while the Link popover (which lives
      // outside the textarea) is open and taking focus.
      return;
    }
    if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node | null)) {
      setIsEditing(false);
      onBlur?.(getPersistableValue());
    }
  }

  if (!isEditing) {
    return (
      <div
        className={`${styles.viewArea}${readOnly ? ` ${styles.viewAreaReadOnly}` : ''}${viewClassName ? ` ${viewClassName}` : ''}`}
        onClick={readOnly ? undefined : () => setIsEditing(true)}
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
        onKeyDown={readOnly ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') setIsEditing(true);
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
    <div ref={containerRef} className={styles.editContainer} onBlur={handleBlur}>
      <div className={styles.toolbarRow}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${mode === 'write' ? styles.tabActive : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMode('write')}
          >
            Write
          </button>
          <button
            type="button"
            className={`${styles.tab} ${mode === 'preview' ? styles.tabActive : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
        </div>
        {mode === 'write' && (
          <div className={styles.toolbar}>
            {TOOLBAR.map((btn) => (
              <button
                key={btn.label}
                type="button"
                className={`${styles.toolbarBtn} ${btn.label === 'B' ? styles.bold : ''} ${btn.label === 'I' ? styles.italic : ''}`}
                disabled={isUploading}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMarkdown(btn.before, btn.after, btn.placeholder);
                }}
              >
                {btn.label}
              </button>
            ))}
            <div className={styles.toolbarBtnAnchor}>
              <button
                type="button"
                className={styles.toolbarBtn}
                aria-label="Link"
                disabled={isUploading}
                onMouseDown={(e) => {
                  e.preventDefault();
                  openLinkPopover();
                }}
              >
                <LinkIcon />
              </button>
              {linkPopover && (
                <div ref={linkPopoverRef} className={styles.linkPopover}>
                  <div className={styles.linkPopoverRow}>
                    <LinkIcon />
                    <input
                      ref={linkUrlInputRef}
                      type="text"
                      className={styles.linkPopoverInput}
                      placeholder="https://…"
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                      }}
                    />
                  </div>
                  <div className={styles.linkPopoverDivider} />
                  <div className={styles.linkPopoverLabel}>Text</div>
                  {linkPopover.hadSelection ? (
                    <div className={styles.linkPopoverSelectedText}>{linkPopover.selectedText}</div>
                  ) : (
                    <input
                      type="text"
                      className={styles.linkPopoverInput}
                      placeholder="link text"
                      value={linkLabel}
                      onChange={(e) => setLinkLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                      }}
                    />
                  )}
                  <div className={styles.linkPopoverActions}>
                    <button type="button" className={styles.linkPopoverCancel} onClick={() => setLinkPopover(null)}>
                      Cancel
                    </button>
                    <button type="button" className={styles.linkPopoverApply} onClick={applyLink}>
                      Apply
                    </button>
                  </div>
                </div>
              )}
            </div>
            {onUploadImage && (
              <>
                <button
                  type="button"
                  className={styles.toolbarBtn}
                  disabled={isUploading}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (isFilePickerOpenRef.current) return; // prevent double-registration
                    isFilePickerOpenRef.current = true;
                    window.addEventListener('focus', () => {
                      isFilePickerOpenRef.current = false;
                    }, { once: true });
                    fileInputRef.current?.click();
                  }}
                >
                  Img
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
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Highlight"
              disabled={isUploading}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMarkdown('==', '==', 'highlighted text');
              }}
            >
              <HighlightIcon />
            </button>
            <span className={styles.toolbarDivider} />
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Align left"
              disabled={isUploading}
              // Left is the implicit default (no ::: wrapper needed); nothing
              // meaningful to insert here.
              onMouseDown={(e) => e.preventDefault()}
            >
              <AlignLeftIcon />
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Align center"
              disabled={isUploading}
              onMouseDown={(e) => {
                e.preventDefault();
                insertAlignBlock('center');
              }}
            >
              <AlignCenterIcon />
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              aria-label="Align right"
              disabled={isUploading}
              onMouseDown={(e) => {
                e.preventDefault();
                insertAlignBlock('right');
              }}
            >
              <AlignRightIcon />
            </button>
          </div>
        )}
      </div>
      {isUploading && <div className={styles.uploadStatus}>Uploading image...</div>}
      {mode === 'write' ? (
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={value}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onSelect={handleTextareaSelect}
          autoFocus
          rows={6}
          placeholder="Write markdown here..."
        />
      ) : (
        <div className={styles.previewArea}>
          {value ? (
            <MarkdownRenderer>{value}</MarkdownRenderer>
          ) : (
            <span className={styles.placeholder}>Nothing to preview yet.</span>
          )}
        </div>
      )}
    </div>
  );
}
