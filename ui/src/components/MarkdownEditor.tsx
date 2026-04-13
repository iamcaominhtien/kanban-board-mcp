import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import styles from './MarkdownEditor.module.css';

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
  { label: '🔗',     before: '[',         after: '](url)',  placeholder: 'link text' },
  { label: '`code`', before: '`',         after: '`',       placeholder: 'code' },
  { label: '```',    before: '\n```\n',   after: '\n```\n', placeholder: 'code block' },
  { label: 'UL',     before: '\n- ',      after: '',        placeholder: 'list item' },
  { label: 'OL',     before: '\n1. ',     after: '',        placeholder: 'list item' },
  { label: '>',      before: '\n> ',      after: '',        placeholder: 'blockquote' },
  { label: '—',      before: '\n---\n',   after: '',        placeholder: '' },
];

interface Props {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
  onUploadImage?: (file: File) => Promise<{ markdown: string }>;
  onUploadComplete?: (value: string) => void;
  readOnly?: boolean;
}

const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    img: ['src', 'alt', 'title'],
  },
};

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onUploadImage,
  onUploadComplete,
  readOnly = false,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestValueRef = useRef(value);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  function updateValue(nextValue: string, selectionStart?: number, selectionEnd?: number) {
    latestValueRef.current = nextValue;
    onChange(nextValue);

    if (selectionStart === undefined || selectionEnd === undefined) {
      return;
    }

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

  async function handleImageUpload(file: File) {
    if (!onUploadImage || isUploading) {
      return;
    }

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayName = file.name.replace(/\.[^.]+$/, '') || 'image';
    const placeholder = `![Uploading ${displayName}...](uploading:${uploadId})`;
    const inserted = insertTextAtCursor(placeholder);
    if (!inserted) {
      return;
    }

    setIsUploading(true);
    try {
      const result = await onUploadImage(file);
      const updatedValue = latestValueRef.current.replace(placeholder, result.markdown);
      if (updatedValue !== latestValueRef.current) {
        const cursor = inserted.start + result.markdown.length;
        updateValue(updatedValue, cursor, cursor);
        onUploadComplete?.(updatedValue);
      }
    } catch {
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
      .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
      ?.getAsFile();

    if (!imageFile) {
      return;
    }

    e.preventDefault();
    void handleImageUpload(imageFile);
  }

  function handleFilePickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
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
    if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node | null)) {
      setIsEditing(false);
      onBlur?.(value);
    }
  }

  if (!isEditing) {
    return (
      <div
        className={`${styles.viewArea}${readOnly ? ` ${styles.viewAreaReadOnly}` : ''}`}
        onClick={readOnly ? undefined : () => setIsEditing(true)}
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
        onKeyDown={readOnly ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') setIsEditing(true);
        }}
        aria-label={readOnly ? undefined : 'Edit description'}
      >
        {value ? (
          <ReactMarkdown rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}>{value}</ReactMarkdown>
        ) : (
          <span className={styles.placeholder}>Click to add a description...</span>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={styles.editContainer} onBlur={handleBlur}>
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
        {onUploadImage && (
          <>
            <button
              type="button"
              className={styles.toolbarBtn}
              disabled={isUploading}
              onMouseDown={(e) => {
                e.preventDefault();
                fileInputRef.current?.click();
              }}
            >
              Img
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className={styles.fileInput}
              onChange={handleFilePickerChange}
            />
          </>
        )}
      </div>
      {isUploading && <div className={styles.uploadStatus}>Uploading image...</div>}
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        autoFocus
        rows={6}
        placeholder="Write markdown here..."
      />
    </div>
  );
}
