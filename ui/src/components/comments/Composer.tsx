import { useEffect, useMemo, useRef, useState } from 'react';
import { uploadAnyFile } from '../../api/tickets';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { RefSuggester, type SuggestMember } from '../docs/RefSuggester';
import { Icon } from '../docs/Icon';
import { COUNTER_FROM, MAX_COMMENT_CHARS, draftKey, readJson, writeJson, type Person } from './commentUtils';

interface Chip {
  id: string;
  name: string;
  size?: number;
  status: 'uploading' | 'done' | 'error';
  markdown?: string;
  isImage: boolean;
}

interface Props {
  ticketId: string;
  projectId: string;
  me: Person;
  members: SuggestMember[];
  /** Edit in place: starts with this text, label "EDITING" and a Save button. */
  initial?: string;
  editing?: boolean;
  autoFocus?: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

function Avatar({ person }: { person: Person }) {
  return (
    <div title={person.name} style={{ width: 28, height: 28, borderRadius: '50%', background: person.bg, color: person.color, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, userSelect: 'none' }}>
      {person.initials}
    </div>
  );
}

const kb = { fontFamily: 'var(--font-mono)', fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid #DCE6DF', background: '#F6FAF7', color: '#5B6B60' } as const;

/** The comment box: Write / Preview, markdown toolbar, attachments, draft kept on this device. */
export function Composer({ ticketId, projectId, me, members, initial = '', editing = false, autoFocus = true, onSubmit, onCancel }: Props) {
  const [text, setText] = useState(() => (editing ? initial : readJson<string>(draftKey(ticketId), '')));
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [chips, setChips] = useState<Chip[]>([]);
  const [saved, setSaved] = useState(!editing && !!readJson<string>(draftKey(ticketId), ''));
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) ta.current?.focus();
    const el = ta.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the draft is kept per ticket on this device while typing
  useEffect(() => {
    if (editing) return;
    const t = setTimeout(() => {
      writeJson(draftKey(ticketId), text.trim() ? text : null);
      setSaved(!!text.trim());
    }, 400);
    return () => clearTimeout(t);
  }, [text, ticketId, editing]);

  const uploading = chips.some((c) => c.status === 'uploading');
  const tooLong = text.length > MAX_COMMENT_CHARS;
  const hasContent = !!text.trim() || chips.some((c) => c.status === 'done');
  const canSend = hasContent && !uploading && !tooLong;

  function wrap(before: string, after = before, placeholder = '') {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const picked = value.slice(a, b) || placeholder;
    const next = value.slice(0, a) + before + picked + after + value.slice(b);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + picked.length);
    });
  }
  function prefixLines(prefix: string) {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const block = value.slice(start, b).split('\n').map((l) => prefix + l).join('\n');
    setText(value.slice(0, start) + block + value.slice(b));
    requestAnimationFrame(() => el.focus());
  }
  function insert(token: string) {
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

  function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const isImage = file.type.startsWith('image/');
      setChips((c) => [...c, { id, name: file.name, size: file.size, status: 'uploading', isImage }]);
      uploadAnyFile(file)
        .then((res) => setChips((c) => c.map((x) => (x.id === id ? { ...x, status: 'done', markdown: res.markdown } : x))))
        .catch(() => setChips((c) => c.map((x) => (x.id === id ? { ...x, status: 'error' } : x))));
    }
  }

  function send() {
    if (!canSend) return;
    const extra = chips.filter((c) => c.status === 'done' && c.markdown).map((c) => c.markdown).join('\n\n');
    onSubmit([text.trim(), extra].filter(Boolean).join('\n\n'));
    if (!editing) writeJson(draftKey(ticketId), null);
  }

  function cancel() {
    if (!editing && !text.trim() && chips.length === 0) writeJson(draftKey(ticketId), null);
    onCancel();
  }

  const btn: React.CSSProperties = { minWidth: 28, height: 28, padding: '0 5px', borderRadius: 6, border: 'none', background: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5B6B60', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' };
  const tools = useMemo(
    () => [
      { label: 'Bold', node: <b>B</b>, run: () => wrap('**', '**', 'bold') },
      { label: 'Italic', node: <i style={{ fontFamily: 'serif' }}>i</i>, run: () => wrap('_', '_', 'italic') },
      { label: 'Code', node: <Icon name="i33" size={14} strokeWidth={1.8} />, run: () => wrap('`', '`', 'code') },
      { label: 'Link', node: <Icon name="link" size={14} strokeWidth={1.8} />, run: () => wrap('[', '](https://)', 'text') },
      { label: 'Quote', node: <span style={{ fontSize: 14 }}>❝</span>, run: () => prefixLines('> ') },
      { label: 'List', node: <Icon name="i05" size={0} />, run: () => prefixLines('- ') },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <Avatar person={me} />
      <div data-testid={editing ? 'comment-editor' : 'comment-composer'} style={{ flex: 1, minWidth: 0, border: '1px solid #2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.14)', borderRadius: 10, background: '#FFFFFF', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 10px', borderBottom: tab === 'write' ? '1px solid #EEF3EF' : undefined, background: '#FBFCFB' }}>
          <div style={{ display: 'inline-flex', background: '#EEF1EE', borderRadius: 8, padding: 3, gap: 2 }}>
            {(['write', 'preview'] as const).map((t) => (
              <button
                key={t}
                type="button"
                data-testid={`comment-tab-${t}`}
                onClick={() => setTab(t)}
                style={{ border: 'none', cursor: 'pointer', padding: '4px 12px', borderRadius: 6, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, background: tab === t ? '#FFFFFF' : 'transparent', color: tab === t ? '#1E2A22' : '#5B6B60', boxShadow: tab === t ? '0 1px 2px rgba(30,42,34,0.10)' : undefined }}
              >
                {t === 'write' ? 'Write' : 'Preview'}
              </button>
            ))}
          </div>
          {editing && <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: '#2E6F40', marginLeft: 8 }}>EDITING</span>}
          {tab === 'write' && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
              {tools.map((t) => (
                <button key={t.label} type="button" aria-label={t.label} title={t.label} style={btn} onMouseDown={(e) => { e.preventDefault(); t.run(); }}>
                  {t.label === 'List' ? <span style={{ fontSize: 15, lineHeight: 1 }}>≡</span> : t.node}
                </button>
              ))}
              <span style={{ width: 1, height: 16, background: '#DCE6DF', margin: '0 5px' }} />
              <button type="button" aria-label="Insert doc reference" title="Link a doc or ticket" style={{ ...btn, fontFamily: 'var(--font-mono)', fontSize: 11 }} onMouseDown={(e) => { e.preventDefault(); insert('[['); }}>[[ ]]</button>
              <button type="button" aria-label="Mention a member" title="Mention a member" style={{ ...btn, color: '#2F6FB0' }} onMouseDown={(e) => { e.preventDefault(); insert('@'); }}>@</button>
            </div>
          )}
        </div>

        {tab === 'preview' && (
          <div data-testid="comment-preview" style={{ padding: '12px 14px', minHeight: 72, fontSize: 14, lineHeight: 1.6 }}>
            {text.trim() ? <MarkdownRenderer>{text}</MarkdownRenderer> : <span style={{ color: '#9AA8A0' }}>Nothing to preview</span>}
          </div>
        )}
        {(
          <textarea
            ref={ta}
            value={text}
            data-testid="comment-textarea"
            aria-label="Comment"
            placeholder="Add a comment…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              } else if (e.key === 'Escape' && !e.defaultPrevented) {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files.length) {
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }
            }}
            rows={3}
            style={{ display: tab === 'write' ? 'block' : 'none', width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', resize: 'vertical', minHeight: 72, padding: '12px 14px', font: 'inherit', fontSize: 14, lineHeight: 1.6, color: '#1E2A22', background: '#FFFFFF' }}
          />
        )}

        {chips.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 12px 10px' }}>
            {chips.map((c) => (
              <div key={c.id} data-testid="comment-chip" style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #E3E8E5', borderRadius: 8, padding: '7px 10px', minWidth: 200, background: '#FFFFFF' }}>
                <span style={{ width: 28, height: 28, borderRadius: 6, background: c.isImage ? '#E8F1FB' : '#E8F1FB', color: '#2F6FB0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="i00" size={14} /></span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1E2A22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ fontSize: 11.5, color: c.status === 'error' ? '#C4432A' : '#5B6B60' }}>
                    {c.status === 'uploading' ? 'Uploading…' : c.status === 'error' ? 'Upload failed' : c.size != null ? `${Math.max(1, Math.round(c.size / 1024))} KB` : ''}
                  </span>
                  {c.status === 'uploading' && <span style={{ height: 3, borderRadius: 2, background: '#E3E8E5', overflow: 'hidden' }}><span className="mc-bar" style={{ display: 'block', height: 3, width: '60%', background: '#2E6F40' }} /></span>}
                </span>
                <button type="button" aria-label={`Remove ${c.name}`} onClick={() => setChips((x) => x.filter((y) => y.id !== c.id))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9AA8A0', padding: 2 }}><Icon name="close" size={12} strokeWidth={2} /></button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid #EEF3EF' }}>
          <button type="button" onClick={() => fileRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: '#5B6B60' }}>
            <Icon name="i24" size={14} strokeWidth={1.8} />Attach
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: '#9AA8A0' }}>
            <span style={kb}>{MOD}</span>+<span style={kb}>Enter</span>
          </span>
          {text.length >= COUNTER_FROM && <span data-testid="comment-counter" style={{ fontSize: 11.5, color: tooLong ? '#C4432A' : '#B4791E', marginLeft: 6 }}>{text.length.toLocaleString()} / {MAX_COMMENT_CHARS.toLocaleString()}</span>}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
            <button type="button" className="st-btn" data-testid="comment-cancel" onClick={cancel}>Cancel</button>
            <button type="button" className="st-btn st-btn-primary" data-testid="comment-send" disabled={!canSend} onClick={send}>{editing ? 'Save' : 'Comment'}</button>
          </span>
        </div>
        {!editing && saved && (
          <div data-testid="comment-draft-saved" style={{ padding: '0 14px 8px', fontSize: 11.5, color: '#5B6B60', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: '#2E6F40', display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 }}><Icon name="check" size={12} strokeWidth={2.4} />Draft saved</span>
            <span>· kept on this device, per ticket</span>
          </div>
        )}
      </div>
      <RefSuggester targetRef={ta} projectId={projectId} keyPrefix={ticketId.split('-')[0]} members={members} />
    </div>
  );
}
