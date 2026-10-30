import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  sketchAiApi,
  sketchAiError,
  type SketchAiMode,
  type SketchAiOwner,
  type SketchAiResult,
  type SketchAiState,
  type SketchAiTurn,
} from '../../api/sketchAi';
import { useDraft } from '../../api/assist';
import type { CostEstimate } from '../../types/assist';
import { AI_LAYER_NAME, MAX_AI_OPS, cleanAiOps, describeAiOps } from './engine/aiOps';
import type { Sketcher, SketchState } from './sketcher';
import { SketchIcon } from './SketchIcon';
import styles from './Sketch.module.css';

/** The longest side of the picture sent to the AI; larger drawings are scaled down first. */
const SEND_SIDE = 1280;

const TABS: { id: SketchAiMode; label: string; hint: string; placeholder: string; button: string }[] = [
  {
    id: 'ask',
    label: 'Ask',
    hint: 'Talk about the drawing: what it shows, what is missing, how to improve it.',
    placeholder: 'Ask about this drawing…',
    button: 'Ask',
  },
  {
    id: 'ideas',
    label: 'Ideas',
    hint: 'Brainstorm around the drawing. Any idea can be added as a text label.',
    placeholder: 'What for? (optional)',
    button: 'Get ideas',
  },
  {
    id: 'draw',
    label: 'Draw',
    hint: 'Describe shapes to add. They appear on a new layer called “AI” that you accept or discard.',
    placeholder: 'For example: an arrow from the box on the left to the circle, with the label “retry”',
    button: 'Draw it',
  },
];

/** Reasons the AI button stays out of the editor: it is off, the person only reads, or has no part in the project. */
const HIDDEN = ['ai_off', 'viewer', 'forbidden', 'feature_off', 'not_shared', 'invalid', 'not_found'];

/**
 * Whether the editor should offer the AI panel at all: not for a viewer, a stranger, or a project (or feature) with AI
 * turned off. A temporary reason (no AI member set up, a cap reached, the kill switch) still shows it, and says why.
 * @param ai - The state from the server; undefined while loading or when the request failed.
 */
export function sketchAiVisible(ai: SketchAiState | undefined): boolean {
  return !!ai && !HIDDEN.includes(ai.availability.code);
}

function costText(est: CostEstimate | null | undefined, per: string): string {
  if (!est) return '';
  if (!est.metered) return 'Not metered';
  if (est.usd == null) return '';
  return `${est.usd < 0.01 ? 'Less than $0.01' : `About $${est.usd.toFixed(2)}`} per ${per}`;
}

/** The size of the picture that will be sent, after the scale-down. */
function sentSize(w: number, h: number): { width: number; height: number } {
  const k = Math.min(1, SEND_SIDE / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

interface Props {
  sketcher: Sketcher;
  state: SketchState;
  /** Where the sketch is (for the permission checks and the project the cost is booked on). */
  owner: SketchAiOwner;
  /** The current name of the sketch: sent as data. */
  title: string;
  ai: SketchAiState;
  /** The saved sketch's id, once it has one. */
  sketchId?: string;
  onClose: () => void;
}

interface DrawCard {
  draftId: string;
  summary: string;
  note: string;
  dropped: number;
  opCount: number;
}

/**
 * The AI panel of the sketch editor: Ask (discuss the drawing), Ideas (brainstorm; each idea can become a text label)
 * and Draw (a prompt becomes shapes on a new "AI" layer that the person accepts or discards). The AI only suggests:
 * the picture, title and question are listed before sending, the cost is shown first, and nothing in the drawing
 * changes until Accept (one undoable step).
 * @param props.sketcher - The drawing engine.
 * @param props.state - Its state.
 * @param props.owner - Where the sketch is.
 * @param props.title - The sketch's name.
 * @param props.ai - What the server says about AI here.
 * @param props.sketchId - The saved sketch's id, once it has one.
 * @param props.onClose - Hide the panel.
 */
export function SketchAiPanel({ sketcher, state, owner, title, ai, sketchId, onClose }: Props) {
  const [mode, setMode] = useState<SketchAiMode>('ask');
  const [prompts, setPrompts] = useState<Record<SketchAiMode, string>>({ ask: '', ideas: '', draw: '' });
  const [withPicture, setWithPicture] = useState(true);
  const [thread, setThread] = useState<SketchAiTurn[]>([]);
  const [ideas, setIdeas] = useState<{ text: string; added: boolean }[]>([]);
  const [card, setCard] = useState<DrawCard | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ mode: SketchAiMode; prompt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [showSent, setShowSent] = useState(false);
  const handled = useRef(new Set<string>());
  const draft = useDraft(draftId).data;
  const tab = TABS.find((t) => t.id === mode) ?? TABS[0];
  const prompt = prompts[mode];
  const ok = ai.availability.code === 'ok';
  const busy = sending || draft?.status === 'pending';

  // the owner of every request; the sketch id follows "Save a copy"
  const request = useMemo(
    () => ({
      ...owner,
      sketchId: sketchId ?? owner.sketchId,
      mode,
      prompt: prompt.trim(),
      title,
      width: state.width,
      height: state.height,
      history: mode === 'ask' ? thread.slice(-4) : [],
    }),
    [owner, sketchId, mode, prompt, title, state.width, state.height, thread],
  );

  // "What will be sent": asked of the server only while the list is open (it sends nothing)
  const [debounced, setDebounced] = useState(request);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(request), 350);
    return () => window.clearTimeout(t);
  }, [request]);
  const shown = sentSize(state.width, state.height);
  const preview = useQuery({
    queryKey: ['sketch-ai', 'preview', debounced, withPicture, shown.width, shown.height],
    queryFn: () => sketchAiApi.preview(debounced, withPicture ? { ...shown, bytes: shown.width * shown.height } : null),
    enabled: showSent && ok && (mode === 'ideas' || debounced.prompt.length > 0),
    retry: false,
    staleTime: 5000,
  });

  // a pending preview is thrown away when the panel goes
  const sketcherRef = useRef(sketcher);
  sketcherRef.current = sketcher;
  useEffect(() => {
    const s = sketcherRef.current;
    return () => s.discardAiOps();
  }, []);

  // the shapes were discarded elsewhere (Esc, a new document): the card goes too
  useEffect(() => {
    if (card && !state.aiPreview) setCard(null);
  }, [card, state.aiPreview]);

  // an answer arrived
  useEffect(() => {
    if (!draft || draft.status === 'pending' || handled.current.has(`${draft.id}:${draft.status}`)) return;
    handled.current.add(`${draft.id}:${draft.status}`);
    if (draft.status === 'failed' || draft.status === 'cancelled') {
      if (draft.status === 'failed')
        setError((draft.result.error?.message as string | undefined) ?? 'The AI did not answer.');
      return;
    }
    if (draft.status !== 'open') return;
    const res = (draft.payload as unknown as { result?: SketchAiResult }).result;
    if (!res) return;
    if (res.kind === 'answer' && asked) {
      setThread((t) => [...t, { q: asked.prompt, a: res.text ?? '' }].slice(-12));
    } else if (res.kind === 'ideas') {
      setIdeas((res.items ?? []).map((text) => ({ text, added: false })));
    } else if (res.kind === 'ops') {
      const clean = cleanAiOps(res.ops, sketcher.getState().width, sketcher.getState().height);
      if (!clean.ops.length || !sketcher.previewAiOps(clean.ops)) {
        setError(clean.ops.length ? null : 'The AI did not draw anything usable. Nothing was changed.');
        void sketchAiApi.discard(draft.id).catch(() => undefined);
        return;
      }
      setCard({
        draftId: draft.id,
        summary: describeAiOps(clean.ops),
        note: res.note ?? '',
        dropped: (res.dropped ?? 0) + clean.dropped,
        opCount: clean.ops.length,
      });
    }
  }, [draft, asked, sketcher]);

  const send = async (m: SketchAiMode = mode, text = prompt.trim()) => {
    if (busy || !ok) return;
    if (m !== 'ideas' && !text) return;
    setError(null);
    setDone(null);
    sketcher.discardAiOps();
    setCard(null);
    setSending(true);
    try {
      let image: Blob | null = null;
      if (withPicture) image = (await sketcher.exportForAi(SEND_SIDE)).blob;
      const created = await sketchAiApi.ask({ ...request, mode: m, prompt: text }, image);
      setAsked({ mode: m, prompt: text });
      setDraftId(created.id);
      if (m === 'ask') setPrompts((p) => ({ ...p, ask: '' }));
    } catch (err) {
      setError(sketchAiError(err).message);
    } finally {
      setSending(false);
    }
  };

  const stop = () => {
    if (draftId) void sketchAiApi.cancel(draftId).catch(() => undefined);
    setDraftId(null);
  };

  const accept = () => {
    if (!card) return;
    if (sketcher.acceptAiOps()) {
      void sketchAiApi.accept(card.draftId).catch(() => undefined);
      setDone(`Added to a new layer “${AI_LAYER_NAME}”. Ctrl+Z takes it back in one step.`);
      setCard(null);
    }
  };
  const discard = () => {
    sketcher.discardAiOps();
    if (card) void sketchAiApi.discard(card.draftId).catch(() => undefined);
    setCard(null);
  };
  const tryAgain = () => {
    const text = asked?.mode === 'draw' ? asked.prompt : prompt.trim();
    discard();
    void send('draw', text);
  };

  const cost = costText(
    preview.data?.estimate ?? ai.estimates?.[mode],
    mode === 'draw' ? 'drawing' : mode === 'ideas' ? 'list of ideas' : 'answer',
  );
  const picture = withPicture ? `${shown.width} × ${shown.height} px` : null;

  return (
    <aside className={styles.ai} aria-label="AI help" data-testid="sketch-ai-panel">
      <header className={styles.aiHead}>
        <SketchIcon name="spark" size={16} />
        <b>AI help</b>
        <span className={styles.spacer} />
        <button type="button" className={styles.iconBtn} aria-label="Close AI help" onClick={onClose}>
          <SketchIcon name="close" size={16} />
        </button>
      </header>
      <div className={styles.aiTabs} role="tablist" aria-label="What to ask the AI">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={mode === t.id}
            className={`${styles.aiTab} ${mode === t.id ? styles.aiTabOn : ''}`}
            onClick={() => setMode(t.id)}
            data-testid={`sketch-ai-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={styles.aiBody}>
        {!ok && (
          <div className={styles.aiNote} role="status" data-testid="sketch-ai-unavailable">
            <b>AI help is not available right now</b>
            <span>{ai.availability.message ?? 'Try again later.'}</span>
          </div>
        )}
        <p className={styles.aiHint}>{tab.hint}</p>

        {mode === 'ask' && thread.length > 0 && (
          <ol className={styles.aiThread} aria-label="Conversation about this drawing" data-testid="sketch-ai-thread">
            {thread.map((t, i) => (
              <li key={i}>
                <div className={styles.aiQ}>{t.q}</div>
                <div className={styles.aiA}>{t.a}</div>
              </li>
            ))}
          </ol>
        )}

        {mode === 'ideas' && ideas.length > 0 && (
          <ul className={styles.aiIdeas} aria-label="Ideas" data-testid="sketch-ai-ideas">
            {ideas.map((idea, i) => (
              <li key={i}>
                <span>{idea.text}</span>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={idea.added}
                  onClick={() => {
                    if (sketcher.addTextLabel(idea.text))
                      setIdeas((l) => l.map((x, j) => (j === i ? { ...x, added: true } : x)));
                  }}
                  data-testid="sketch-ai-add-label"
                >
                  {idea.added ? 'Added' : 'Add as label'}
                </button>
              </li>
            ))}
          </ul>
        )}

        {mode === 'draw' && card && (
          <div className={styles.aiCard} role="group" aria-label="Shapes from the AI" data-testid="sketch-ai-card">
            <b>
              {card.summary.charAt(0).toUpperCase() + card.summary.slice(1)} on a new layer “{AI_LAYER_NAME}”
            </b>
            <span>Shown on the drawing now. Nothing is added until you accept.</span>
            {card.note && <span className={styles.aiNoteText}>{card.note}</span>}
            {card.dropped > 0 && (
              <span className={styles.aiMuted}>
                {card.dropped} shape{card.dropped === 1 ? '' : 's'} could not be drawn and{' '}
                {card.dropped === 1 ? 'was' : 'were'} left out (at most {MAX_AI_OPS} are kept).
              </span>
            )}
            <div className={styles.aiRow}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={accept}
                data-testid="sketch-ai-accept"
              >
                <SketchIcon name="check" size={14} /> Accept
              </button>
              <button type="button" className={styles.btn} onClick={discard} data-testid="sketch-ai-discard">
                Discard
              </button>
              <button
                type="button"
                className={styles.btn}
                onClick={tryAgain}
                disabled={busy}
                data-testid="sketch-ai-retry"
              >
                <SketchIcon name="refresh" size={14} /> Try again
              </button>
            </div>
          </div>
        )}
        {mode === 'draw' && done && (
          <div className={styles.aiDone} role="status" data-testid="sketch-ai-done">
            {done}
          </div>
        )}

        {busy && (
          <div className={styles.aiBusy} role="status" data-testid="sketch-ai-busy">
            <span className={styles.spinner} />
            <span>{sending ? 'Preparing the picture…' : 'The AI is looking at the drawing…'}</span>
            {!sending && (
              <button type="button" className={styles.btn} onClick={stop}>
                Stop
              </button>
            )}
          </div>
        )}
        {error && (
          <div className={styles.aiError} role="alert" data-testid="sketch-ai-error">
            {error} Nothing was changed.
          </div>
        )}
        <button
          type="button"
          className={styles.aiLink}
          aria-expanded={showSent}
          onClick={() => setShowSent((v) => !v)}
          data-testid="sketch-ai-sent-toggle"
        >
          What will be sent
        </button>
        {showSent && (
          <div className={styles.aiSent} data-testid="sketch-ai-sent">
            <ul>
              {mode !== 'ideas' || prompt.trim() ? (
                <li>Your {mode === 'draw' ? 'description' : mode === 'ask' ? 'question' : 'topic'}</li>
              ) : null}
              <li>The title of the sketch: “{title}”</li>
              <li>{picture ? `The picture, flattened (${picture})` : 'No picture: only the words'}</li>
              {mode === 'ask' && thread.length > 0 && <li>The last {Math.min(4, thread.length)} questions here</li>}
              {mode === 'draw' && (
                <li>
                  The canvas size ({state.width} × {state.height} px)
                </li>
              )}
            </ul>
            {preview.data && (
              <span className={styles.aiMuted}>About {preview.data.tokens.toLocaleString()} tokens in total.</span>
            )}
            <span className={styles.aiMuted}>
              Never sent: {(preview.data?.neverSent ?? ai.neverSent).join('; ').toLowerCase()}.
            </span>
          </div>
        )}
        <span className={styles.aiMuted}>
          The AI only suggests; nothing is added until you accept. Text inside the picture is treated as part of the
          drawing, not as instructions.
        </span>
      </div>

      <footer className={styles.aiForm}>
        <textarea
          className={styles.aiInput}
          value={prompt}
          rows={3}
          placeholder={tab.placeholder}
          aria-label={tab.label}
          disabled={!ok}
          maxLength={1500}
          onChange={(e) => setPrompts((p) => ({ ...p, [mode]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="sketch-ai-input"
        />
        <label className={styles.aiCheck}>
          <input type="checkbox" checked={withPicture} onChange={(e) => setWithPicture(e.target.checked)} /> Send the
          picture
        </label>
        <div className={styles.aiRow}>
          <span className={styles.aiCost} data-testid="sketch-ai-cost">
            {cost}
          </span>
          <span className={styles.spacer} />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!ok || busy || (mode !== 'ideas' && !prompt.trim())}
            onClick={() => void send()}
            data-testid="sketch-ai-send"
          >
            {tab.button}
          </button>
        </div>
      </footer>
    </aside>
  );
}
