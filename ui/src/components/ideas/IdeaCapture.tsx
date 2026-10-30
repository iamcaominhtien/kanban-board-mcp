import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { extractError } from '../../api/extractError';
import { ideaKeys, useAddComment, useCreateIdea, useSimilar, useTagSuggestions, useVote } from '../../api/ideas';
import { uploadDescriptionImage } from '../../api/tickets';
import type { IdeaSource, IdeaSourceRef } from '../../types/idea';
import { FooterNote, ModalShell, Spacer } from '../docs/docsShared';
import { useSketchStarter } from '../sketch/useSketchStarter';
import { useToast } from '../Toast';
import { BulbIcon, Kbd } from './ideaShared';
import { ProjectSelect, TagInput } from './TriageDialogs';
import { useQueryClient } from '@tanstack/react-query';

export interface CapturePrefill {
  title?: string;
  description?: string;
  /** undefined: the project you are in; null: no project. */
  projectId?: string | null;
  source?: IdeaSource;
  sourceRef?: IdeaSourceRef;
}

interface CaptureApi {
  /** Open Quick add, optionally filled in (a highlighted text, a picture). */
  open: (prefill?: CapturePrefill) => void;
}

const Ctx = createContext<CaptureApi | null>(null);

/** Quick add from anywhere. Without a provider (tests, previews) it does nothing. */
export function useIdeaCapture(): CaptureApi {
  return useContext(Ctx) ?? { open: () => undefined };
}

/**
 * One-line capture: Alt+N on any screen, "Make idea" on highlighted text. Every route ends in the Inbox.
 * @param props.projectId - The project you are in; Quick add starts with it.
 * @param props.onOpenIdea - Called from the toast of a new idea.
 */
export function IdeaCaptureProvider({
  projectId,
  onOpenIdea,
  children,
}: {
  projectId: string | null;
  onOpenIdea: (id: string) => void;
  children: ReactNode;
}) {
  const [prefill, setPrefill] = useState<CapturePrefill | null>(null);
  const open = useCallback((p?: CapturePrefill) => setPrefill(p ?? {}), []);
  const api = useMemo(() => ({ open }), [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN') {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <SelectionIdeaButton onPick={open} />
      {prefill && (
        <QuickAdd
          prefill={prefill}
          defaultProjectId={projectId}
          onClose={() => setPrefill(null)}
          onOpenIdea={onOpenIdea}
        />
      )}
    </Ctx.Provider>
  );
}

/** The "Make idea" button that follows a text selection made inside an element marked with `data-idea-source`. */
function SelectionIdeaButton({ onPick }: { onPick: (p: CapturePrefill) => void }) {
  const [state, setState] = useState<{
    x: number;
    y: number;
    text: string;
    ref: IdeaSourceRef;
    source: IdeaSource;
  } | null>(null);

  useEffect(() => {
    function check() {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!sel || sel.rangeCount === 0 || text.length < 8) return setState(null);
      const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      const holder = node?.closest<HTMLElement>('[data-idea-source]');
      if (!holder) return setState(null);
      let meta: { source?: IdeaSource; id?: string; label?: string; url?: string } = {};
      try {
        meta = JSON.parse(holder.dataset.ideaSource ?? '{}');
      } catch {
        /* a broken attribute only loses the back link */
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setState({
        x: Math.min(window.innerWidth - 120, Math.max(8, rect.right - 40)),
        y: rect.bottom + 6,
        text,
        source: meta.source ?? 'selection',
        ref: {
          kind: meta.source ?? 'selection',
          id: meta.id,
          label: meta.label,
          url: meta.url,
          quote: text.slice(0, 600),
        },
      });
    }
    const onUp = () => window.setTimeout(check, 0);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
    };
  }, []);

  if (!state) return null;
  return (
    <button
      type="button"
      className="is-make-idea"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onPick({
          title: state.text.split(/[.\n]/)[0].slice(0, 90),
          description: `> ${state.text.replace(/\n/g, '\n> ')}`,
          source: state.source,
          sourceRef: state.ref,
        });
        window.getSelection()?.removeAllRanges();
        setState(null);
      }}
    >
      <BulbIcon size={14} /> Make idea
    </button>
  );
}

function QuickAdd({
  prefill,
  defaultProjectId,
  onClose,
  onOpenIdea,
}: {
  prefill: CapturePrefill;
  defaultProjectId: string | null;
  onClose: () => void;
  onOpenIdea: (id: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const create = useCreateIdea();
  const vote = useVote();
  const comment = useAddComment();
  const [title, setTitle] = useState(prefill.title ?? '');
  const [description, setDescription] = useState(prefill.description ?? '');
  const [moreOpen, setMoreOpen] = useState(!!prefill.description);
  const [projectId, setProjectId] = useState<string | null>(
    prefill.projectId === undefined ? defaultProjectId : prefill.projectId,
  );
  const [tags, setTags] = useState<string[]>([]);
  const [source, setSource] = useState<IdeaSource>(prefill.source ?? 'manual');
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const text = `${title} ${description}`;
  const similar = useSimilar(text, { projectId }).data ?? [];
  const tagHints = useTagSuggestions(text).data ?? [];
  const match = similar.find((s) => s.kind === 'idea' && s.score >= 0.4);
  const related = similar.find((s) => s.kind === 'ticket' && s.score >= 0.4);

  useEffect(() => titleRef.current?.focus(), []);

  // a drawing made here belongs to the idea only once it exists, so it is kept by its id and put in the page
  const sketch = useSketchStarter({
    ownerKind: 'idea',
    ownerId: 'new-idea',
    projectId: projectId ?? undefined,
    ownerLabel: title.trim() || 'a new idea',
    onInsert: (md) => {
      setDescription((d) => `${d ? `${d}\n\n` : ''}${md}`);
      setMoreOpen(true);
      setSource((s) => (s === 'manual' ? 'picture' : s));
    },
  });

  async function add() {
    if (!title.trim()) return;
    setError(null);
    try {
      const idea = await create.mutateAsync({
        title: title.trim(),
        description: description.trim(),
        projectId,
        tags,
        source,
        sourceRef: prefill.sourceRef,
      });
      toast.success(`Added ${idea.id} to the Inbox`, title.trim(), 6000, {
        label: 'Open',
        onClick: () => onOpenIdea(idea.id),
      });
      onClose();
    } catch (e) {
      setError(extractError(e));
    }
  }

  async function addToExisting() {
    if (!match) return;
    try {
      await comment.mutateAsync({
        id: match.id,
        body: [title.trim(), description.trim()].filter(Boolean).join('\n\n'),
      });
      await vote.mutateAsync({ id: match.id });
      qc.invalidateQueries({ queryKey: ideaKeys.all });
      toast.success(`Added to ${match.id}`, 'Your text is a comment there and you count as +1.');
      onClose();
    } catch (e) {
      setError(extractError(e));
    }
  }

  async function onPaste(e: React.ClipboardEvent) {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    try {
      const up = await uploadDescriptionImage(file);
      setDescription((d) => `${d ? `${d}\n\n` : ''}${up.markdown}`);
      setMoreOpen(true);
      setSource((s) => (s === 'manual' ? 'picture' : s));
    } catch (err) {
      setError(extractError(err));
    }
  }

  return (
    <ModalShell
      width={520}
      ariaLabel="Quick idea"
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <BulbIcon size={16} /> Quick idea
        </span>
      }
      onClose={onClose}
      zIndex={1300}
      testId="quick-add"
      footer={
        <>
          {error ? (
            <FooterNote>{error}</FooterNote>
          ) : (
            <FooterNote>One line is enough. Similar ideas show up as you type.</FooterNote>
          )}
          <Spacer />
          <span className="is-muted" style={{ fontSize: 12 }}>
            <Kbd>Enter</Kbd> adds
          </span>
          <button type="button" className="is-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="is-btn is-btn-primary"
            onClick={add}
            disabled={!title.trim() || create.isPending}
          >
            Add to Inbox
          </button>
        </>
      }
    >
      <div className="is-root is-dlg-body" style={{ flex: 'none', background: 'transparent' }} onPaste={onPaste}>
        <div className="is-field">
          <input
            ref={titleRef}
            className="is-input"
            placeholder="What if…"
            value={title}
            aria-label="Idea title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        {match && (
          <div className="is-banner is-banner-warn" role="status" style={{ marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              Looks like “{match.title}” ({Math.round(match.score * 100)}% similar).{' '}
              <button type="button" className="is-link" onClick={addToExisting}>
                Add to it instead
              </button>
            </div>
          </div>
        )}
        {related && (
          <div className="is-muted" style={{ marginBottom: 10 }}>
            Related ticket: <span className="is-mono">{related.id}</span> {related.title}
          </div>
        )}
        {prefill.sourceRef?.quote && (
          <div className="is-quote" title="The idea keeps a link back to this text">
            “{prefill.sourceRef.quote.slice(0, 220)}”
            <div className="is-muted">
              {prefill.sourceRef.label ? `from ${prefill.sourceRef.label}` : 'highlighted text'}
            </div>
          </div>
        )}
        <div className="is-field">
          <span className="is-label">Project</span>
          <ProjectSelect value={projectId} onChange={setProjectId} />
        </div>
        <div className="is-field">
          <span className="is-label">Tags</span>
          <TagInput tags={tags} onChange={setTags} suggestions={tagHints} />
        </div>
        {moreOpen ? (
          <div className="is-field">
            <span className="is-label">Details</span>
            <textarea
              className="is-textarea"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Markdown. Paste a screenshot with Ctrl+V."
            />
          </div>
        ) : (
          <button type="button" className="is-link" onClick={() => setMoreOpen(true)}>
            Add details or paste a picture
          </button>
        )}
        {sketch.available && (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="is-link"
              data-testid="quick-add-sketch"
              onClick={() => void sketch.start()}
            >
              Start with a sketch
            </button>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
