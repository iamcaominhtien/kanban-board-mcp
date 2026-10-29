import { useEffect, useRef, useState } from 'react';
import { useProject } from '../../../api/projects';
import { uploadAnyFile } from '../../../api/tickets';
import { extractError } from '../../../api/extractError';
import { DiagramIcon } from '../../diagrams/DiagramIcon';
import { firstDiagramFile } from '../../diagrams/diagramFile';
import { useDiagramStarter } from '../../diagrams/useDiagramStarter';
import { RefSuggester, type SuggestMember } from '../RefSuggester';
import { Icon } from '../Icon';

interface Props {
  projectId: string;
  members: SuggestMember[];
  /** Text to start with (editing a comment). */
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  /** Show Cancel; the box is dismissed with it or with Esc. */
  onCancel?: () => void;
  /** Resolves when the comment was posted; a rejection keeps the text and shows "Not posted". */
  onSubmit: (text: string) => Promise<unknown>;
  autoFocus?: boolean;
  /** Start as one line that grows when focused (the "Reply…" field). */
  compact?: boolean;
  testId?: string;
}

const MAX = 4000;

/**
 * The comment box: markdown shortcuts, @mention / [[Page]] / ticket-key suggestions, images and files (paste, drop
 * or Attach), draw.io diagrams, Enter to post, Esc to cancel.
 * @param props.projectId - Project whose members, pages and tickets are suggested.
 * @param props.members - Members offered after `@`.
 * @param props.initial - Starting text (editing).
 * @param props.placeholder - Placeholder text.
 * @param props.submitLabel - Label of the post button.
 * @param props.onCancel - Called on Cancel or Esc; hides the Cancel button when absent.
 * @param props.onSubmit - Posts the text; reject to keep it and show the failure.
 * @param props.autoFocus - Focus the box on mount.
 * @param props.compact - Show a one-line field until focused.
 * @param props.testId - Test id of the textarea.
 */
export function CommentBox({
  projectId,
  members,
  initial = '',
  placeholder = 'Write a comment…',
  submitLabel = 'Comment',
  onCancel,
  onSubmit,
  autoFocus,
  compact,
  testId = 'comment-input',
}: Props) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(!compact);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const project = useProject(projectId);

  useEffect(() => {
    if (autoFocus) {
      ta.current?.focus();
      const n = ta.current?.value.length ?? 0;
      ta.current?.setSelectionRange(n, n);
    }
  }, [autoFocus]);

  function wrap(before: string, after = before, fallback = '') {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const picked = value.slice(a, b) || fallback;
    setText(value.slice(0, a) + before + picked + after + value.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + picked.length);
    });
  }
  function insertAt(token: string) {
    const el = ta.current;
    if (!el) return;
    el.focus();
    const { selectionStart: a, selectionEnd: b, value } = el;
    setText(value.slice(0, a) + token + value.slice(b));
    requestAnimationFrame(() => {
      el.setSelectionRange(a + token.length, a + token.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /** Put a block (image, file link, diagram) on its own line at the caret. */
  function insertBlock(md: string) {
    const el = ta.current;
    const value = el?.value ?? text;
    const a = el?.selectionStart ?? value.length;
    const b = el?.selectionEnd ?? value.length;
    const lead = a > 0 && value[a - 1] !== '\n' ? '\n' : '';
    const token = `${lead}${md}\n`;
    setText(value.slice(0, a) + token + value.slice(b));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + token.length, a + token.length);
    });
  }
  function addFiles(files: FileList | File[]) {
    setUploadError(null);
    for (const file of Array.from(files)) {
      setUploads((n) => n + 1);
      uploadAnyFile(file)
        .then((res) => insertBlock(res.markdown))
        .catch((err) => setUploadError(`${file.name}: ${extractError(err)}`))
        .finally(() => setUploads((n) => n - 1));
    }
  }
  const diagram = useDiagramStarter({ projectId, saveTo: 'Docs comment', itemKind: 'comment', onInsert: insertBlock });

  const canSend = !!text.trim() && text.length <= MAX && !busy && uploads === 0;
  async function send() {
    if (!canSend) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSubmit(text.trim());
      setText('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (compact && !focused && !text) {
    return (
      <input
        className="dc-reply-field"
        data-testid="reply-field"
        placeholder={placeholder}
        readOnly
        onFocus={() => {
          setFocused(true);
          requestAnimationFrame(() => ta.current?.focus());
        }}
      />
    );
  }

  const tools = [
    { label: 'Bold', node: <b>B</b>, run: () => wrap('**', '**', 'bold') },
    { label: 'Italic', node: <i style={{ fontFamily: 'serif' }}>I</i>, run: () => wrap('_', '_', 'italic') },
    { label: 'Code', node: <Icon name="i33" size={14} strokeWidth={1.8} />, run: () => wrap('`', '`', 'code') },
    { label: 'Mention', node: <Icon name="at" size={14} strokeWidth={1.8} />, run: () => insertAt('@') },
    { label: 'Link a page', node: <Icon name="link" size={14} strokeWidth={1.8} />, run: () => insertAt('[[') },
  ];

  return (
    <div className="dc-box" data-testid="comment-box">
      <textarea
        ref={ta}
        data-testid={testId}
        value={text}
        rows={compact ? 2 : 3}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          const dg = diagram.available ? firstDiagramFile(e.dataTransfer.files) : null;
          if (dg) {
            e.preventDefault();
            e.stopPropagation();
            void diagram.startImport(dg);
          } else if (e.dataTransfer.files.length) {
            e.preventDefault();
            e.stopPropagation();
            addFiles(e.dataTransfer.files);
          }
        }}
        onBlur={() => {
          if (compact && !text.trim()) setFocused(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel?.();
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            // the suggestion menu uses Enter to pick; it stops the event first
            if (e.defaultPrevented) return;
            e.preventDefault();
            void send();
          }
        }}
      />
      {(uploads > 0 || uploadError) && (
        <div
          className={uploadError ? 'dc-failed' : 'dc-uploading'}
          role={uploadError ? 'alert' : 'status'}
          data-testid="comment-upload"
        >
          {uploadError ? (
            <>
              <Icon name="i14" size={14} strokeWidth={1.9} /> Upload failed. {uploadError}
            </>
          ) : (
            `Uploading ${uploads} ${uploads === 1 ? 'file' : 'files'}…`
          )}
        </div>
      )}
      {failed && (
        <div className="dc-failed" role="alert" data-testid="comment-failed">
          <Icon name="i14" size={14} strokeWidth={1.9} /> Not posted. Your text is kept.
          <button type="button" onClick={() => void send()}>
            Retry
          </button>
        </div>
      )}
      <div className="dc-box-bar">
        {tools.map((t) => (
          <button
            key={t.label}
            type="button"
            className="dc-tool"
            aria-label={t.label}
            title={t.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={t.run}
          >
            {t.node}
          </button>
        ))}
        <button
          type="button"
          className="dc-tool"
          aria-label="Attach an image or file"
          title="Attach an image or file (or paste one)"
          data-testid="comment-attach"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="i54" size={14} strokeWidth={1.8} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {diagram.available && (
          <>
            <button
              type="button"
              className="dc-tool"
              aria-label="Diagram"
              title="Diagram (draw.io)"
              data-testid="comment-diagram"
              onMouseDown={(e) => {
                e.preventDefault();
                diagram.startNew();
              }}
            >
              <DiagramIcon name="drawio" size={14} />
            </button>
            {diagram.fileInput}
          </>
        )}
        <span style={{ flex: 1 }} />
        {text.length > MAX - 300 && (
          <span className="dc-count" style={{ color: text.length > MAX ? '#C4432A' : undefined }}>
            {text.length}/{MAX}
          </span>
        )}
        {onCancel && (
          <button type="button" className="dc-plain" onClick={onCancel} data-testid="comment-cancel">
            Cancel
          </button>
        )}
        <button
          type="button"
          className="dc-send"
          disabled={!canSend}
          onClick={() => void send()}
          data-testid="comment-submit"
        >
          <Icon name="send" size={13} strokeWidth={2} />
          {busy ? 'Posting…' : submitLabel}
        </button>
      </div>
      <RefSuggester targetRef={ta} projectId={projectId} keyPrefix={project.data?.prefix} members={members} />
    </div>
  );
}
