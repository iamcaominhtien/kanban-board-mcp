import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchIdeaTickets } from '../../../api/ideaTickets';
import { docsAiError } from '../../../api/docsAi';
import { useTickets } from '../../../api/tickets';
import { useWritePreview, type WritePreview } from '../../../api/docsAiWrite';
import { costLabel } from '../../../utils/docsAiRules';
import {
  PAGE_KIND_LABEL,
  commentsRowLabel,
  sendChips,
  writeRequest,
  type WriteForm,
  type WritePageKind,
} from '../../../utils/writeRules';
import { Icon } from '../Icon';

const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#1E2A22', margin: '0 0 6px' };
const hint: CSSProperties = { fontSize: 11.5, color: '#5B6B60', lineHeight: 1.4 };
const KINDS: WritePageKind[] = ['spec', 'howto', 'release_note', 'decision', 'meeting_notes'];

interface Props {
  projectId: string;
  form: WriteForm;
  onForm: (next: WriteForm) => void;
  /** Tells the dialog what the preview said (it shows the title it suggests). */
  onPreview?: (p: WritePreview | undefined) => void;
  error?: string | null;
}

/** An inline picker: the picked item, or a search list. */
function Picker<T extends { id: string; title: string }>({
  items,
  value,
  placeholder,
  chip,
  onPick,
}: {
  items: T[];
  value: string | null;
  placeholder: string;
  chip: (item: T) => string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const picked = items.find((i) => i.id === value);
  const shown = useMemo(
    () =>
      items
        .filter((i) => !q.trim() || `${i.id} ${i.title}`.toLowerCase().includes(q.trim().toLowerCase()))
        .slice(0, 40),
    [items, q],
  );
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="st-input"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', cursor: 'pointer', width: '100%' }}
      >
        <Icon name="page" size={15} strokeWidth={1.8} style={{ color: '#5B6B60' }} />
        {picked ? (
          <>
            <span
              className="mc-chip"
              style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, background: '#F6FAF7' }}
            >
              {chip(picked)}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {picked.title}
            </span>
          </>
        ) : (
          <span style={{ flex: 1, color: '#9AA8A0' }}>{placeholder}</span>
        )}
        <Icon name="chevronDown" size={12} strokeWidth={2.3} style={{ color: '#9AA8A0' }} />
      </button>
      {open && (
        <div
          className="dk-menu"
          role="listbox"
          style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 30, padding: 6 }}
        >
          <input
            autoFocus
            className="st-input"
            aria-label="Find"
            placeholder="Find…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ marginBottom: 4 }}
          />
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {shown.map((i) => (
              <div
                key={i.id}
                role="option"
                aria-selected={i.id === value}
                className={`dk-mi${i.id === value ? ' dk-mi-on' : ''}`}
                onClick={() => {
                  onPick(i.id);
                  setOpen(false);
                  setQ('');
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700, color: '#5B6B60' }}>
                  {chip(i)}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</span>
              </div>
            ))}
            {shown.length === 0 && (
              <div style={{ padding: '8px 10px', fontSize: 12.5, color: '#9AA8A0' }}>Nothing found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The right-hand side of New page › Write with AI: the source (ticket, idea, notes or a prompt), the kind of page,
 * what else to read, and "What will be sent" with tokens and cost. Nothing is asked of the AI until Write draft.
 * @param props.form - What the person picked; `onForm` changes it.
 */
export function WriteWithAi({ projectId, form, onForm, onPreview, error }: Props) {
  const tickets = useTickets(projectId);
  const ideas = useQuery({
    queryKey: ['docs-ai', 'ideas', projectId],
    queryFn: () => fetchIdeaTickets(projectId),
    enabled: form.kind === 'idea',
    retry: false,
  });
  const ready = form.kind === 'ticket' ? !!form.ticketId : form.kind === 'idea' ? !!form.ideaId : !!form.text.trim();
  const body = ready ? writeRequest(form, '', null) : null;
  const preview = useWritePreview(projectId, body);
  useEffect(() => {
    onPreview?.(preview.data);
  }, [preview.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = preview.data;
  const problem = preview.error ? docsAiError(preview.error) : null;
  const set = (patch: Partial<WriteForm>) => onForm({ ...form, ...patch });

  return (
    <div
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}
      data-testid="write-with-ai"
    >
      {form.kind === 'ticket' && (
        <div>
          <div style={label}>Ticket</div>
          <Picker
            items={tickets.data ?? []}
            value={form.ticketId}
            placeholder="Pick a ticket"
            chip={(t) => t.id}
            onPick={(id) => set({ ticketId: id })}
          />
        </div>
      )}
      {form.kind === 'idea' && (
        <div>
          <div style={label}>Idea</div>
          <Picker
            items={ideas.data ?? []}
            value={form.ideaId}
            placeholder={ideas.isLoading ? 'Loading ideas…' : 'Pick an idea'}
            chip={(i) => i.id}
            onPick={(id) => set({ ideaId: id })}
          />
        </div>
      )}
      {(form.kind === 'notes' || form.kind === 'prompt') && (
        <div>
          <div style={label}>{form.kind === 'notes' ? 'Your notes' : 'What the page is about'}</div>
          <textarea
            className="st-input"
            aria-label={form.kind === 'notes' ? 'Your notes' : 'What the page is about'}
            value={form.text}
            placeholder={
              form.kind === 'notes'
                ? 'Paste the notes here: a meeting, a call, a brain dump'
                : 'Say what the page should cover. The AI writes only from this.'
            }
            onChange={(e) => set({ text: e.target.value })}
            style={{
              minHeight: 130,
              resize: 'vertical',
              fontFamily: form.kind === 'notes' ? 'var(--font-mono)' : undefined,
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          />
        </div>
      )}

      <div>
        <div style={label}>What kind of page</div>
        <div
          role="radiogroup"
          aria-label="What kind of page"
          style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9, background: '#EEF3EF', flexWrap: 'wrap' }}
        >
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={form.pageKind === k}
              onClick={() => set({ pageKind: k })}
              style={{
                border: 'none',
                borderRadius: 7,
                padding: '6px 11px',
                fontSize: 12.5,
                fontWeight: form.pageKind === k ? 700 : 500,
                cursor: 'pointer',
                background: form.pageKind === k ? '#FFFFFF' : 'transparent',
                color: form.pageKind === k ? '#1E2A22' : '#5B6B60',
                boxShadow: form.pageKind === k ? '0 1px 2px rgba(30,42,34,0.12)' : 'none',
              }}
            >
              {PAGE_KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {form.kind === 'ticket' && (
        <div>
          <div style={label}>Also read</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.comments}
                onChange={(e) => set({ comments: e.target.checked })}
                style={{ accentColor: '#2E6F40', marginTop: 2 }}
              />
              <span>{commentsRowLabel(p ? p.send.comments : null)}</span>
            </label>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.linkedPages}
                onChange={(e) => set({ linkedPages: e.target.checked })}
                style={{ accentColor: '#2E6F40', marginTop: 2 }}
              />
              <span>
                {p ? `${p.send.pages.length} linked page${p.send.pages.length === 1 ? '' : 's'}` : 'Linked pages'}
                {p && p.send.pages.length > 0 && <div style={hint}>{p.send.pages.map((x) => x.title).join(', ')}</div>}
              </span>
            </label>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.codeChanges}
                onChange={(e) => set({ codeChanges: e.target.checked })}
                style={{ accentColor: '#2E6F40', marginTop: 2 }}
              />
              <span>
                The code changes on the ticket’s branch
                <div style={hint}>Adds code to what is sent. Off unless you turn it on</div>
              </span>
            </label>
          </div>
        </div>
      )}

      <div
        data-testid="what-will-be-sent"
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 28 }}
      >
        <span
          style={{ fontSize: 12, color: '#5B6B60' }}
          title="Only this goes to the AI. Pages hidden from AI are never read."
        >
          What will be sent ⓘ
        </span>
        {!ready && <span style={hint}>Pick a source first</span>}
        {ready && preview.isLoading && <span style={hint}>Checking…</span>}
        {p &&
          sendChips(p).map((c) => (
            <span
              key={c.id}
              className="mc-chip"
              style={{ background: '#F6FAF7', border: '1px solid #E3E8E5', color: '#1E2A22' }}
            >
              {c.label}
            </span>
          ))}
        {p && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#5B6B60' }}>
            {costLabel(p.cost, p.metered)} · ~{p.tokens.toLocaleString()} tokens
          </span>
        )}
      </div>
      {p && p.skipped.length > 0 && (
        <div style={{ ...hint, color: '#7A4F08' }}>
          Left out: {p.skipped.map((s) => `${s.title} (${s.reason})`).join(', ')}.
        </div>
      )}
      {p?.notes.map((n) => (
        <div key={n} style={hint}>
          {n}
        </div>
      ))}
      {p && p.injections.length > 0 && (
        <div role="note" style={{ ...hint, color: '#7A4F08' }}>
          Some text in the sources reads like instructions to an AI. It is sent as data and not followed.
        </div>
      )}
      {problem && (
        <div role="alert" style={{ fontSize: 12.5, color: '#C4432A', fontWeight: 600 }}>
          {problem.detail}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#C4432A', fontWeight: 600 }}>
          {error}
        </div>
      )}
    </div>
  );
}
