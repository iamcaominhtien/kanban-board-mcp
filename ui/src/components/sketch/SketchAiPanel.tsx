import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assistApi, assistKeys, useChat, useScopeState } from '../../api/assist';
import {
  sketchAiApi,
  sketchAiError,
  sketchFilePath,
  useKeptPicture,
  type SketchAiOwner,
  type SketchAiState,
  type SketchAttachment,
  type SketchProposal,
  type SketchTurn,
} from '../../api/sketchAi';
import type { AssistDraft, ChatMessage, CostEstimate, StartingPoint } from '../../types/assist';
import { AI_LAYER_NAME, MAX_AI_OPS, cleanAiOps, describeAiOps } from './engine/aiOps';
import { MAX_IMAGE_BYTES, SEND_SIDE, admit, scaledSize, tooLarge } from './engine/chatFiles';
import type { Sketcher, SketchState } from './sketcher';
import { SketchIcon } from './SketchIcon';
import styles from './Sketch.module.css';

/** The longest side of the picture of the drawing sent with every message; larger drawings are scaled down first. */
const CANVAS_SIDE = 1280;
const ACTIVE = ['queued', 'thinking', 'streaming', 'rate_limited'];

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

/** The answer without the block of shapes and ideas the model ends with (it shows while the answer streams). */
function wordsOf(text: string): string {
  const i = text.indexOf('```kanban-actions');
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

interface Pending {
  id: string;
  file: File;
  kind: 'image' | 'text';
  url?: string;
  width?: number;
  height?: number;
  chars?: number;
}

/** Scale a picture down when it is large; refuse one that is still too large. Small pictures go as they are. */
async function readPicture(
  file: File,
  needsScaling: boolean,
): Promise<{ file: File; width: number; height: number; url: string } | string> {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const size = scaledSize(img.naturalWidth, img.naturalHeight, SEND_SIDE);
    if (!size.scaled && !needsScaling) {
      const big = tooLarge(file.name, file.size);
      return big ?? { file, width: size.width, height: size.height, url: src };
    }
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return `“${file.name}” could not be prepared.`;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size.width, size.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
    if (!blob) return `“${file.name}” could not be prepared.`;
    const big = tooLarge(file.name, blob.size);
    if (big) return big;
    const out = new File([blob], file.name, { type });
    URL.revokeObjectURL(src);
    return { file: out, width: size.width, height: size.height, url: URL.createObjectURL(out) };
  } catch {
    URL.revokeObjectURL(src);
    return `“${file.name}” could not be read as a picture.`;
  }
}

interface Props {
  sketcher: Sketcher;
  state: SketchState;
  /** Where the sketch is (for the permission checks and the project the cost is booked on). */
  owner: SketchAiOwner;
  /** The current name of the sketch: sent as data. */
  title: string;
  ai: SketchAiState;
  /** The key the chat is kept under: the sketch id, or the draft scope id of a drawing that is not saved yet. */
  scopeId: string;
  /** Called just before the first message of a drawing without an id leaves, so its draft (and the chat key) is kept. */
  onFirstMessage?: () => void;
  onClose: () => void;
}

/** A picture attached to a sent message: a thumbnail, and "Put on the drawing". */
function SentAttachment({
  a,
  chatId,
  turn,
  sketcher,
}: {
  a: SketchAttachment;
  chatId: string;
  turn: SketchTurn;
  sketcher: Sketcher;
}) {
  const url = useKeptPicture(a.kind === 'image' ? sketchFilePath(chatId, turn.id, a.file) : undefined);
  const [busy, setBusy] = useState(false);
  if (a.kind === 'text') {
    return (
      <span className={styles.aiFileChip} data-testid="sketch-ai-attachment">
        <SketchIcon name="copy" size={12} /> {a.name}
      </span>
    );
  }
  const put = async () => {
    if (!url) return;
    setBusy(true);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      sketcher.addImageLayer(img, a.name.replace(/\.[a-z0-9]+$/i, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={styles.aiPic} data-testid="sketch-ai-attachment">
      {url ? <img src={url} alt={a.name} /> : <span className={styles.aiPicEmpty}>{a.name}</span>}
      <span className={styles.aiPicName} title={a.name}>
        {a.name}
      </span>
      <button
        type="button"
        className={styles.aiPicBtn}
        disabled={!url || busy}
        onClick={() => void put()}
        data-testid="sketch-ai-put-on"
      >
        Put on the drawing
      </button>
    </span>
  );
}

/**
 * The AI panel of the sketch editor: ONE conversation per person and sketch, kept on the server (30 days) and found again
 * when the editor or an embedded sketch is opened again. Every message goes with the current picture of the drawing and
 * can carry pictures (paste, drop, attach) and text files. The AI answers in words and, when asked to draw, with a
 * proposal in the thread: shapes shown as a preview on the drawing and put on a new layer "AI" (one undoable step) only
 * when the person presses Accept; ideas can be added as text labels. The AI only suggests.
 * @param props.sketcher - The drawing engine.
 * @param props.state - Its state.
 * @param props.owner - Where the sketch is.
 * @param props.title - The sketch's name.
 * @param props.ai - What the server says about AI here.
 * @param props.scopeId - The key the chat is kept under.
 * @param props.onFirstMessage - Called before the first message of an unsaved drawing is sent.
 * @param props.onClose - Hide the panel.
 */
export function SketchAiPanel({ sketcher, state, owner, title, ai, scopeId, onFirstMessage, onClose }: Props) {
  const qc = useQueryClient();
  const scope = useMemo(() => ({ kind: 'sketch', id: scopeId }), [scopeId]);
  const st = useScopeState(scope);
  const [chatId, setChatId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [withPicture, setWithPicture] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewDraft, setPreviewDraft] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const sentIds = useRef(new Set<string>());
  const autoShown = useRef(new Set<string>());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const sketcherRef = useRef(sketcher);
  sketcherRef.current = sketcher;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    if (!chatId && st.data?.chatId) setChatId(st.data.chatId);
  }, [chatId, st.data?.chatId]);
  const chat = useChat(chatId);
  const messages = useMemo(() => chat.data?.messages ?? [], [chat.data?.messages]);
  const drafts = chat.data?.drafts;
  const availability = st.data?.availability ?? ai.availability;
  const ok = availability.code === 'ok';
  const viewer = availability.code === 'viewer';
  const busy = sending || messages.some((m) => ACTIVE.includes(m.state));
  const points: StartingPoint[] = st.data?.scope.startingPoints ?? [];
  const reading = st.data?.scope.reading ?? [];
  const lastLen = messages.length ? (messages[messages.length - 1]?.text.length ?? 0) : 0;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLen, done, previewDraft, drafts]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // a pending preview is thrown away when the panel goes; object URLs of waiting pictures are released
  useEffect(() => {
    const s = sketcherRef.current;
    return () => {
      s.discardAiOps();
      pendingRef.current.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    };
  }, []);
  // the shapes were discarded elsewhere (Esc, a new document): the card goes back to its resting state
  useEffect(() => {
    // `state` can lag a render behind the engine, so the engine itself is asked too
    if (previewDraft && !state.aiPreview && !sketcherRef.current.hasAiPreview) setPreviewDraft(null);
  }, [previewDraft, state.aiPreview]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: assistKeys.scope(scope.kind, scope.id) });
    if (chatId) await qc.invalidateQueries({ queryKey: assistKeys.chat(chatId) });
  }, [qc, scope, chatId]);

  const showProposal = useCallback((d: AssistDraft): boolean => {
    const res = (d.payload as unknown as { result?: SketchProposal }).result;
    const s = sketcherRef.current;
    const clean = cleanAiOps(res?.ops ?? [], s.getState().width, s.getState().height);
    if (!clean.ops.length || !s.previewAiOps(clean.ops)) return false;
    setPreviewDraft(d.id);
    return true;
  }, []);

  // the newest answer of this session is previewed on the drawing as soon as it arrives
  useEffect(() => {
    for (const m of messages) {
      if (m.role !== 'ai' || m.state !== 'done' || !sentIds.current.has(m.id) || autoShown.current.has(m.id)) continue;
      const d = drafts?.find((x) => x.id === m.draftId);
      if (!d) continue;
      autoShown.current.add(m.id);
      const res = (d.payload as unknown as { result?: SketchProposal }).result;
      if (d.status === 'open' && res?.ops?.length) showProposal(d);
    }
  }, [messages, drafts, showProposal]);

  // --- attachments ------------------------------------------------------------------------------
  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const waiting = {
      images: pendingRef.current.filter((p) => p.kind === 'image').length,
      texts: pendingRef.current.filter((p) => p.kind === 'text').length,
    };
    const { accepted, refused } = admit(waiting, files);
    const problems = [...refused];
    const added: Pending[] = [];
    for (const a of accepted) {
      if (a.kind === 'image') {
        const r = await readPicture(a.file, a.needsScaling);
        if (typeof r === 'string') problems.push(r);
        else
          added.push({
            id: crypto.randomUUID(),
            file: r.file,
            kind: 'image',
            url: r.url,
            width: r.width,
            height: r.height,
          });
      } else {
        let chars = 0;
        try {
          chars = (await a.file.text()).length;
        } catch {
          /* the size is only shown */
        }
        added.push({ id: crypto.randomUUID(), file: a.file, kind: 'text', chars });
      }
    }
    setNotices(problems);
    if (added.length) setPending((p) => [...p, ...added]);
  }, []);
  const removePending = (id: string) =>
    setPending((p) => {
      const gone = p.find((x) => x.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return p.filter((x) => x.id !== id);
    });

  // --- what will be sent ------------------------------------------------------------------------
  const shown = scaledSize(state.width, state.height, CANVAS_SIDE);
  const attachments = pending.map((p) => ({
    name: p.file.name,
    kind: p.kind,
    bytes: p.file.size,
    width: p.width,
    height: p.height,
    chars: p.chars,
  }));
  const [debounced, setDebounced] = useState({ text, attachments });
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced({ text, attachments }), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, pending]);
  const preview = useQuery({
    queryKey: [
      'sketch-ai',
      'preview',
      scopeId,
      debounced,
      withPicture,
      title,
      shown.width,
      shown.height,
      chatId,
      messages.length,
    ],
    queryFn: () =>
      sketchAiApi.preview(
        {
          ...owner,
          sketchId: owner.sketchId,
          prompt: debounced.text.trim(),
          title,
          width: state.width,
          height: state.height,
          chatId,
          attachments: debounced.attachments,
        },
        withPicture ? { ...shown, bytes: 0 } : null,
      ),
    enabled: showSent && ok,
    retry: false,
    staleTime: 5000,
  });

  // --- sending ---------------------------------------------------------------------------------
  const send = async (raw: string = text) => {
    const q = raw.trim();
    if (!q || busy || !ok) return;
    setError(null);
    setDone(null);
    setNotices([]);
    sketcher.discardAiOps();
    setPreviewDraft(null);
    setSending(true);
    try {
      onFirstMessage?.();
      let id = chatId;
      if (!id) {
        id = (await assistApi.scopeChat(scope)).id;
        setChatId(id);
      }
      const picture = withPicture ? (await sketcher.exportForAi(CANVAS_SIDE)).blob : null;
      const sent = await sketchAiApi.send(id, {
        text: q,
        title,
        width: state.width,
        height: state.height,
        picture,
        files: pending.map((p) => p.file),
        memberId: st.data?.memberId,
      });
      sentIds.current.add(sent.ai.id);
      setText('');
      pending.forEach((p) => p.url && URL.revokeObjectURL(p.url));
      setPending([]);
      await qc.invalidateQueries({ queryKey: assistKeys.chat(id) });
      await qc.invalidateQueries({ queryKey: assistKeys.scope(scope.kind, scope.id) });
    } catch (err) {
      const e = sketchAiError(err);
      setError(e.message);
      if (['viewer', 'ai_off', 'over_budget', 'not_configured', 'unavailable', 'feature_off'].includes(e.code))
        void refresh();
    } finally {
      setSending(false);
    }
  };

  const stop = (m: ChatMessage) => void assistApi.stop(m.id).then(refresh);
  const again = (m: ChatMessage) => void assistApi.retry(m.id).then(refresh);

  // --- the proposal card -----------------------------------------------------------------------
  const accept = (d: AssistDraft) => {
    if (sketcher.acceptAiOps()) {
      void sketchAiApi.accept(d.id).then(refresh);
      setDone(`Added to a new layer “${AI_LAYER_NAME}”. Ctrl+Z takes it back in one step.`);
      setPreviewDraft(null);
    }
  };
  const discard = (d: AssistDraft) => {
    sketcher.discardAiOps();
    setPreviewDraft(null);
    void sketchAiApi.discard(d.id).then(refresh);
  };
  const tryAgain = (d: AssistDraft, question: string) => {
    discard(d);
    void send(question);
  };
  const addLabel = (d: AssistDraft, i: number, idea: string) => {
    if (sketcher.addTextLabel(idea)) void sketchAiApi.ideaAdded(d.id, i).then(refresh);
  };

  const cost = costText(preview.data?.estimate ?? ai.estimates?.answer, 'answer');
  const drawCost = preview.data?.drawEstimate ?? ai.estimates?.draw;
  const waitingImages = pending.filter((p) => p.kind === 'image').length;

  const proposalOf = (m: ChatMessage) => {
    const d = drafts?.find((x) => x.id === m.draftId);
    if (!d) return null;
    const res = (d.payload as unknown as { result?: SketchProposal }).result;
    return res ? { d, res } : null;
  };

  const renderAi = (m: ChatMessage, i: number) => {
    const prop = proposalOf(m);
    const words = wordsOf(m.text);
    const question =
      messages
        .slice(0, i)
        .reverse()
        .find((x) => x.role === 'user')?.text ?? '';
    const live = ACTIVE.includes(m.state);
    const problems = m.error?.problems ?? [];
    const clean = prop ? cleanAiOps(prop.res.ops, state.width, state.height) : null;
    return (
      <div key={m.id} className={styles.aiA} data-testid="sketch-ai-answer" data-state={m.state}>
        {live && !words && (
          <div className={styles.aiBusy} role="status" data-testid="sketch-ai-busy">
            <span className={styles.spinner} />
            <span>{m.steps.length ? m.steps[m.steps.length - 1].text : 'The AI is looking at the drawing…'}</span>
            <button type="button" className={styles.btn} onClick={() => stop(m)}>
              Stop
            </button>
          </div>
        )}
        {words && <div className={styles.aiText}>{words}</div>}
        {live && words && (
          <button type="button" className={styles.aiLink} onClick={() => stop(m)}>
            Stop
          </button>
        )}
        {m.state === 'error' && (
          <div className={styles.aiError} role="alert" data-testid="sketch-ai-error">
            {m.error?.message ?? 'The AI did not answer.'} Nothing was changed.
            <button type="button" className={styles.btn} onClick={() => again(m)}>
              <SketchIcon name="refresh" size={14} /> Try again
            </button>
          </div>
        )}
        {m.state === 'over_budget' && (
          <div className={styles.aiNote} role="status">
            <b>AI help is paused</b>
            <span>{m.error?.message ?? 'A cap was reached.'} Nothing was sent.</span>
          </div>
        )}
        {m.state === 'stopped' && <span className={styles.aiMuted}>Stopped. Nothing was changed.</span>}
        {problems.map((p) => (
          <span key={p} className={styles.aiMuted}>
            {p}
          </span>
        ))}
        {(m.context.injections?.length ?? 0) > 0 && (
          <span className={styles.aiMuted} data-testid="sketch-ai-injection">
            Some text sent to the AI reads like instructions. It was treated as data, not obeyed.
          </span>
        )}

        {prop && clean && clean.ops.length > 0 && (
          <div
            className={styles.aiCard}
            role="group"
            aria-label="Shapes from the AI"
            data-testid="sketch-ai-card"
            data-status={prop.d.status}
          >
            <b>
              {describeAiOps(clean.ops).replace(/^./, (c) => c.toUpperCase())} on a new layer “{AI_LAYER_NAME}”
            </b>
            {prop.res.note && <span className={styles.aiNoteText}>{prop.res.note}</span>}
            {prop.res.dropped + clean.dropped > 0 && (
              <span className={styles.aiMuted}>
                {prop.res.dropped + clean.dropped} shape{prop.res.dropped + clean.dropped === 1 ? '' : 's'} could not be
                drawn and {prop.res.dropped + clean.dropped === 1 ? 'was' : 'were'} left out (at most {MAX_AI_OPS} are
                kept).
              </span>
            )}
            {prop.d.status === 'applied' && (
              <span className={styles.aiStatusOk} data-testid="sketch-ai-accepted">
                <SketchIcon name="check" size={13} /> Accepted · on the layer “{AI_LAYER_NAME}”
              </span>
            )}
            {prop.d.status === 'discarded' && (
              <span className={styles.aiMuted} data-testid="sketch-ai-discarded">
                Discarded
              </span>
            )}
            {prop.d.status === 'open' && previewDraft === prop.d.id && (
              <>
                <span>Shown on the drawing now. Nothing is added until you accept.</span>
                <div className={styles.aiRow}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => accept(prop.d)}
                    data-testid="sketch-ai-accept"
                  >
                    <SketchIcon name="check" size={14} /> Accept
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => discard(prop.d)}
                    data-testid="sketch-ai-discard"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => tryAgain(prop.d, question)}
                    disabled={busy || !question}
                    data-testid="sketch-ai-retry"
                  >
                    <SketchIcon name="refresh" size={14} /> Try again
                  </button>
                </div>
              </>
            )}
            {prop.d.status === 'open' && previewDraft !== prop.d.id && (
              <div className={styles.aiRow}>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => {
                    if (!showProposal(prop.d)) setError('The shapes could not be shown on this drawing.');
                  }}
                  data-testid="sketch-ai-show"
                >
                  Show on the drawing
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => discard(prop.d)}
                  data-testid="sketch-ai-discard"
                >
                  Discard
                </button>
              </div>
            )}
          </div>
        )}

        {prop && prop.res.ideas?.length > 0 && (
          <ul className={styles.aiIdeas} aria-label="Ideas" data-testid="sketch-ai-ideas">
            {prop.res.ideas.map((idea, j) => {
              const added = prop.res.added?.includes(j);
              return (
                <li key={j}>
                  <span>{idea}</span>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={added}
                    onClick={() => addLabel(prop.d, j, idea)}
                    data-testid="sketch-ai-add-label"
                  >
                    {added ? 'Added' : 'Add as label'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  const renderUser = (m: ChatMessage) => {
    const turn = (m.context as unknown as { turn?: SketchTurn }).turn;
    return (
      <div key={m.id} className={styles.aiQ} data-testid="sketch-ai-question">
        <div>{m.text}</div>
        {turn && chatId && (
          <div className={styles.aiAttachments}>
            {turn.picture && (
              <span className={styles.aiFileChip} title="The picture of the drawing went along with this message">
                <SketchIcon name="sketch" size={12} /> Drawing {turn.picture.width} × {turn.picture.height}
              </span>
            )}
            {turn.attachments.map((a) => (
              <SentAttachment key={a.id} a={a} chatId={chatId} turn={turn} sketcher={sketcher} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className={`${styles.ai} ${dragging ? styles.aiDrag : ''}`}
      aria-label="AI help"
      data-testid="sketch-ai-panel"
      onDragOver={(e) => {
        if (!ok || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!ok || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className={styles.aiHead}>
        <SketchIcon name="spark" size={16} />
        <b>AI help</b>
        <span className={styles.aiMuted} data-testid="sketch-ai-member">
          {st.data?.members.find((m) => m.id === st.data?.memberId)?.name ?? ''}
        </span>
        <span className={styles.spacer} />
        {!viewer && (
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="New chat"
            title="New chat: start a fresh conversation about this drawing"
            data-testid="sketch-ai-new-chat"
            onClick={async () => {
              try {
                const c = await assistApi.scopeChat(scope, true);
                setChatId(c.id);
                sketcher.discardAiOps();
                setPreviewDraft(null);
                await refresh();
              } catch (err) {
                setError(sketchAiError(err).message);
              }
            }}
          >
            <SketchIcon name="plus" size={16} />
          </button>
        )}
        <button type="button" className={styles.iconBtn} aria-label="Close AI help" onClick={onClose}>
          <SketchIcon name="close" size={16} />
        </button>
      </header>
      <div className={styles.aiReading} data-testid="sketch-ai-reading">
        <span className={styles.aiMuted}>Reading</span>
        {reading.map((r) => (
          <span key={r.label} className={`${styles.aiChip} ${r.skipped ? styles.aiChipSkip : ''}`}>
            {r.label}
          </span>
        ))}
      </div>
      <div className={styles.aiBody} ref={bodyRef}>
        {!ok && (
          <div className={styles.aiNote} role="status" data-testid="sketch-ai-unavailable">
            <b>{viewer ? 'You can read, not ask' : 'AI help is not available right now'}</b>
            <span>{availability.message ?? 'Try again later.'}</span>
          </div>
        )}
        {messages.length === 0 && ok && (
          <div className={styles.aiWelcome} data-testid="sketch-ai-welcome">
            <p className={styles.aiHint}>
              One conversation about this drawing. Ask a question, or say what to draw (“draw a retry button next to the
              error”). Paste a picture or attach a file to show what you mean. The AI sees the drawing as it is now with
              every message, and only suggests: you accept every drawing.
            </p>
            <div className={styles.aiChips}>
              {points.map((p, i) => (
                <button
                  key={p.label}
                  type="button"
                  className={styles.aiStart}
                  data-testid={`sketch-ai-start-${i}`}
                  onClick={() => {
                    if (p.prefill) {
                      setText(p.request);
                      inputRef.current?.focus();
                    } else void send(p.request);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.length > 0 && (
          <div className={styles.aiThread} aria-label="Conversation about this drawing" data-testid="sketch-ai-thread">
            {messages.map((m, i) => (m.role === 'user' ? renderUser(m) : renderAi(m, i)))}
          </div>
        )}
        {done && (
          <div className={styles.aiDone} role="status" data-testid="sketch-ai-done">
            {done}
          </div>
        )}
        {sending && (
          <div className={styles.aiBusy} role="status">
            <span className={styles.spinner} />
            <span>Preparing the picture…</span>
          </div>
        )}
        {error && (
          <div className={styles.aiError} role="alert" data-testid="sketch-ai-error-send">
            {error} Nothing was changed.
          </div>
        )}
      </div>

      {viewer ? null : (
        <footer className={styles.aiForm}>
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
                {preview.data ? (
                  preview.data.pieces.map((p, i) => <li key={i}>{p.label}</li>)
                ) : (
                  <>
                    {text.trim() && <li>Your message</li>}
                    <li>The title of the sketch: “{title}”</li>
                    <li>
                      {withPicture
                        ? `The picture, flattened (${shown.width} × ${shown.height} px)`
                        : 'No picture: only the words'}
                    </li>
                    {pending.map((p) => (
                      <li key={p.id}>
                        {p.kind === 'image' ? 'Attached picture' : 'Attached file'}: {p.file.name}
                      </li>
                    ))}
                  </>
                )}
                {messages.length > 0 && !preview.data && <li>The earlier messages of this chat</li>}
              </ul>
              {preview.data && (
                <span className={styles.aiMuted}>About {preview.data.tokens.toLocaleString()} tokens in total.</span>
              )}
              <span className={styles.aiMuted}>
                Never sent: {(preview.data?.neverSent ?? ai.neverSent).join('; ').toLowerCase()}. Text inside pictures
                and files is treated as data, not as instructions.
              </span>
            </div>
          )}
          {(pending.length > 0 || notices.length > 0) && (
            <div className={styles.aiTray} data-testid="sketch-ai-tray">
              {pending.map((p) => (
                <span key={p.id} className={styles.aiPending} data-testid="sketch-ai-pending">
                  {p.kind === 'image' && p.url ? <img src={p.url} alt="" /> : <SketchIcon name="copy" size={14} />}
                  <span className={styles.aiPendingName} title={p.file.name}>
                    {p.file.name}
                  </span>
                  <button type="button" aria-label={`Remove ${p.file.name}`} onClick={() => removePending(p.id)}>
                    <SketchIcon name="close" size={12} />
                  </button>
                </span>
              ))}
              {notices.map((n) => (
                <span key={n} className={styles.aiError} role="alert" data-testid="sketch-ai-refused">
                  {n}
                </span>
              ))}
            </div>
          )}
          <div className={styles.aiBox}>
            <textarea
              ref={inputRef}
              className={styles.aiInput}
              value={text}
              rows={2}
              placeholder="Ask, or say what to draw…"
              aria-label="Message to the AI"
              disabled={!ok}
              maxLength={ai.limits.maxPrompt}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  void addFiles(
                    files.map((f) =>
                      f.name && f.name !== 'image.png'
                        ? f
                        : new File([f], `pasted-${Date.now().toString(36)}.png`, { type: f.type }),
                    ),
                  );
                }
              }}
              data-testid="sketch-ai-input"
            />
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.log,.xml,.yaml,.yml,.py,.js,.ts,.tsx,.jsx,.html,.css,.sql,.sh"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
              data-testid="sketch-ai-file"
            />
            <div className={styles.aiRow}>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Attach a picture or a text file"
                title="Attach a picture or a text file (or paste or drop one)"
                disabled={!ok}
                onClick={() => fileInput.current?.click()}
                data-testid="sketch-ai-attach"
              >
                <SketchIcon name="clip" size={16} />
              </button>
              <label className={styles.aiCheck}>
                <input type="checkbox" checked={withPicture} onChange={(e) => setWithPicture(e.target.checked)} /> Send
                the drawing
              </label>
              <span className={styles.spacer} />
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={!ok || busy || !text.trim()}
                onClick={() => void send()}
                data-testid="sketch-ai-send"
              >
                <SketchIcon name="send" size={14} /> Send
              </button>
            </div>
          </div>
          <div className={styles.aiRow}>
            <span className={styles.aiCost} data-testid="sketch-ai-cost">
              {cost}
              {waitingImages > 0 && cost ? ` · ${waitingImages} picture${waitingImages === 1 ? '' : 's'} attached` : ''}
              {drawCost?.metered && drawCost.usd != null && cost
                ? ` · a drawing about $${drawCost.usd.toFixed(2)}`
                : ''}
            </span>
            <span className={styles.spacer} />
            <span className={styles.aiMuted}>Private to you</span>
          </div>
          <span className={styles.aiMuted}>
            Pictures up to {MAX_IMAGE_BYTES / 1024 / 1024} MB and text files up to 200 KB.
          </span>
        </footer>
      )}
    </aside>
  );
}
