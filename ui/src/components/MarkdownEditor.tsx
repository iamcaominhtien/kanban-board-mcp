import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
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
}

export function MarkdownEditor({ value, onChange }: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  function insertMarkdown(before: string, after: string, placeholder: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end, value: v } = ta;
    const selected = v.slice(start, end) || placeholder;
    const newValue = v.slice(0, start) + before + selected + after + v.slice(end);
    onChange(newValue);
    requestAnimationFrame(() => {
      ta.focus();
      const newCursor = start + before.length + selected.length + after.length;
      ta.setSelectionRange(newCursor, newCursor);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.nativeEvent.stopImmediatePropagation();
      setIsEditing(false);
    }
  }

  function handleBlur(e: React.FocusEvent) {
    if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node)) {
      setIsEditing(false);
    }
  }

  if (!isEditing) {
    return (
      <div
        className={styles.viewArea}
        onClick={() => setIsEditing(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setIsEditing(true);
        }}
        aria-label="Edit description"
      >
        {value ? (
          <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{value}</ReactMarkdown>
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
            onMouseDown={(e) => {
              e.preventDefault();
              insertMarkdown(btn.before, btn.after, btn.placeholder);
            }}
          >
            {btn.label}
          </button>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        rows={6}
        placeholder="Write markdown here..."
      />
    </div>
  );
}
