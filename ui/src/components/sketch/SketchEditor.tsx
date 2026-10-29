import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  copySketch,
  createSketch,
  fetchSketchSource,
  fetchSketch,
  sketchFailure,
  sketchPngUrl,
  sketchMarkdown,
  updateSketch,
  type Sketch,
  type SketchFailure,
  type SketchFiles,
} from '../../api/sketches';
import { resolveOrigin } from '../../api/resolveOrigin';
import { relativeTime } from '../../utils/relativeTime';
import { byteLength, parseSource, serializeSource, SourceError } from './engine/sourceFormat';
import { checkLimits, formatBytes, nearLimit, MAX_BYTES, type Problem } from './engine/limits';
import { deleteDraft, draftKey, getDraft, putDraft, type SketchDraft } from './draftStore';
import { NewSketchDialog } from './NewSketchDialog';
import { ColourPanel, LayersPanel, OptionsBar, TOOLS } from './SketchPanels';
import { SketchIcon } from './SketchIcon';
import { Sketcher, type ToolId } from './sketcher';
import type { OpenSketchRequest, SketchResult } from './SketchContext';
import { useMedia, useSketchState } from './useSketchState';
import styles from './Sketch.module.css';

const AUTOSAVE_MS = 4000;
const KIND_LABEL = { idea: 'idea', ticket: 'ticket', doc: 'page', comment: 'comment' } as const;

type Phase = 'loading' | 'new' | 'ready' | 'readonly' | 'missing' | 'broken';
type Banner =
  | { kind: 'save'; message: string }
  | { kind: 'conflict'; failure: SketchFailure }
  | { kind: 'large'; problems: Problem[] }
  | null;

interface Props {
  request: OpenSketchRequest;
  onClose: (result: SketchResult | null) => void;
}

function resultOf(s: Sketch): SketchResult {
  return {
    id: s.id,
    pngUrl: sketchPngUrl(s.id, s.version),
    title: s.title,
    version: s.version,
    markdown: sketchMarkdown(s),
    sketch: s,
  };
}

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT')
    return !['range', 'checkbox', 'radio', 'button', 'color'].includes((t as HTMLInputElement).type);
  return false;
}

/**
 * The full-screen sketch editor: tools, colour, layers and the page, with every state of saving.
 * @param props.request - What to open and where it belongs.
 * @param props.onClose - Called once with the saved drawing, or null when closed without saving.
 */
export function SketchEditor({ request, onClose }: Props) {
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef(0);
  const [sketcher, setSketcher] = useState<Sketcher | null>(null);
  const state = useSketchState(sketcher);
  const [phase, setPhase] = useState<Phase>('loading');
  const [title, setTitle] = useState(request.title ?? 'Untitled sketch');
  const [titleChanged, setTitleChanged] = useState(false);
  const [saved, setSaved] = useState<Sketch | null>(null);
  const [lastResult, setLastResult] = useState<SketchResult | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [draftFound, setDraftFound] = useState<SketchDraft | null>(null);
  const [draftStatus, setDraftStatus] = useState<'none' | 'saved' | 'failed'>('none');
  const [sourceBytes, setSourceBytes] = useState(0);
  const [sheet, setSheet] = useState<'colour' | 'layers' | null>(null);
  const narrow = useMedia('(max-width: 760px)');
  const savedTitle = saved?.title;
  const key = useMemo(
    () => draftKey({ ownerKind: request.ownerKind, ownerId: request.ownerId, sketchId: request.sketchId }),
    [request.ownerKind, request.ownerId, request.sketchId],
  );
  // the drawing's identity changes after "Save a copy": from then on Done updates the copy
  const current = useRef<{ id?: string; version: number }>({ id: request.sketchId, version: 0 });
  const lastDraftRevision = useRef(-1);
  const stateRef = useRef(state);
  stateRef.current = state;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const say = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
  }, []);

  // --- the engine ---------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = new Sketcher(canvas, {
      notice: say,
      cursor: (p) => {
        if (cursorRef.current) cursorRef.current.textContent = p ? `x ${p.x}, y ${p.y}` : '';
      },
    });
    setSketcher(s);
    return () => {
      s.dispose();
      setSketcher(null);
    };
  }, [say]);

  // --- what we start from -----------------------------------------------------------------
  const sketchId = request.sketchId;
  const baseImageUrl = request.baseImageUrl;
  const startSize = request.size;
  const restoreDraft = request.restoreDraft;
  useEffect(() => {
    if (!sketcher) return;
    let cancelled = false;
    (async () => {
      try {
        const draft = await getDraft(key);
        if (cancelled) return;
        if (sketchId) {
          let info: Sketch;
          try {
            info = await queryClient.fetchQuery({
              queryKey: ['sketch', sketchId],
              queryFn: () => fetchSketch(sketchId),
              staleTime: 0,
            });
          } catch (err) {
            if (!cancelled) setPhase(sketchFailure(err).status === 404 ? 'missing' : 'broken');
            return;
          }
          if (cancelled) return;
          setSaved(info);
          setTitle(request.title ?? info.title);
          current.current = { id: info.id, version: info.version };
          if (!info.canEdit) {
            setPhase('readonly');
            return;
          }
          if (draft && restoreDraft) {
            await sketcher.openSource(parseSource(draft.source));
            sketcher.markDirty();
            setTitle(draft.title);
            current.current = { id: info.id, version: draft.baseVersion || info.version };
          } else {
            await sketcher.openSource(parseSource(await fetchSketchSource(sketchId)));
            if (draft && draft.savedAt > Date.parse(info.updatedAt)) setDraftFound(draft);
          }
        } else if (draft && restoreDraft) {
          await sketcher.openSource(parseSource(draft.source));
          sketcher.markDirty();
          setTitle(draft.title);
        } else if (baseImageUrl) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = baseImageUrl.startsWith('/') ? `${resolveOrigin()}${baseImageUrl}` : baseImageUrl;
          await img.decode();
          if (cancelled) return;
          if (sketcher.openImage(img, 'Picture'))
            say('The picture was larger than 4096 px and was scaled down to fit.');
          if (draft) setDraftFound(draft);
        } else if (startSize) {
          sketcher.newDocument(startSize.w, startSize.h, startSize.background);
          if (draft) setDraftFound(draft);
        } else {
          if (draft) setDraftFound(draft);
          setPhase('new');
          return;
        }
        if (!cancelled) setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        say(err instanceof SourceError ? err.message : 'The drawing could not be opened.');
        setPhase('broken');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sketcher, key, sketchId, baseImageUrl, startSize, restoreDraft, request.title, queryClient, say]);

  // --- autosave: a draft on this computer every few seconds ---------------------------------------
  const writeDraft = useCallback(async () => {
    const s = sketcher;
    const st = stateRef.current;
    if (!s || !st || phase !== 'ready' || !st.dirty || s.busy) return;
    if (st.revision === lastDraftRevision.current) return;
    lastDraftRevision.current = st.revision;
    const text = serializeSource(s.exportSource());
    setSourceBytes(byteLength(text));
    const ok = await putDraft({
      key: draftKey({ ownerKind: request.ownerKind, ownerId: request.ownerId, sketchId: current.current.id }),
      ownerKind: request.ownerKind,
      ownerId: request.ownerId,
      projectId: request.projectId,
      sketchId: current.current.id,
      baseVersion: current.current.version,
      title,
      ownerLabel: request.ownerLabel,
      savedAt: Date.now(),
      source: text,
    });
    setDraftStatus(ok ? 'saved' : 'failed');
  }, [sketcher, phase, request.ownerKind, request.ownerId, request.projectId, request.ownerLabel, title]);
  const writeDraftRef = useRef(writeDraft);
  writeDraftRef.current = writeDraft;
  useEffect(() => {
    const t = window.setInterval(() => void writeDraftRef.current(), AUTOSAVE_MS);
    const flush = () => {
      if (document.visibilityState === 'hidden') void writeDraftRef.current();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // --- leaving ---------------------------------------------------------------------------------
  const dirty = !!state?.dirty || titleChanged;
  const finish = useCallback(
    (result: SketchResult | null) => {
      window.clearTimeout(noticeTimer.current);
      onClose(result);
    },
    [onClose],
  );
  const requestClose = useCallback(() => {
    if (phase === 'ready' && dirty) setConfirmClose(true);
    else finish(lastResult);
  }, [phase, dirty, finish, lastResult]);

  // --- saving ----------------------------------------------------------------------------------
  const filesNow = useCallback(async (): Promise<SketchFiles | null> => {
    const s = sketcher;
    if (!s || !state) return null;
    const png = await s.exportPng();
    const source = serializeSource(s.exportSource());
    setSourceBytes(byteLength(source));
    const problems = checkLimits({
      width: state.width,
      height: state.height,
      layers: state.layers.length,
      pngBytes: png.size,
      sourceBytes: byteLength(source),
    });
    if (problems.length) {
      setBanner({ kind: 'large', problems });
      return null;
    }
    return { png, source, title: title.trim() || 'Untitled sketch' };
  }, [sketcher, state, title]);

  const save = useCallback(
    async (mode: 'save' | 'copy' | 'replace', thenClose: boolean) => {
      if (!sketcher || saving) return;
      setSaving(true);
      setBanner(null);
      setConfirmClose(false);
      try {
        const files = await filesNow();
        if (!files) return;
        const id = current.current.id;
        let out: Sketch;
        if (!id) {
          out = await createSketch(
            { ownerKind: request.ownerKind, ownerId: request.ownerId, projectId: request.projectId },
            files,
          );
        } else if (mode === 'copy') {
          // a copy with the same name as the first would be hard to tell apart
          out = await copySketch(id, {
            ...files,
            title: files.title === savedTitle ? `${files.title} copy` : files.title,
          });
        } else {
          out = await updateSketch(id, current.current.version, files, mode === 'replace');
        }
        await deleteDraft(key);
        if (id) await deleteDraft(draftKey({ ownerKind: out.ownerKind, ownerId: out.ownerId, sketchId: id }));
        queryClient.setQueryData(['sketch', out.id], out);
        void queryClient.invalidateQueries({ queryKey: ['sketch', out.id] });
        current.current = { id: out.id, version: out.version };
        setSaved(out);
        setTitle(out.title);
        setTitleChanged(false);
        setDraftStatus('none');
        lastDraftRevision.current = -1;
        sketcher.markSaved();
        const r = resultOf(out);
        setLastResult(r);
        if (thenClose) finish(r);
        else say(mode === 'copy' ? `Saved a copy: “${out.title}”. You are now editing the copy.` : 'Saved.');
      } catch (err) {
        const f = sketchFailure(err);
        if (f.code === 'sketch_conflict') setBanner({ kind: 'conflict', failure: f });
        else if (f.code === 'sketch_too_large' || f.code === 'too_many_layers')
          setBanner({ kind: 'large', problems: [{ code: 'png', message: f.message }] });
        else if (f.code === 'read_only') setBanner({ kind: 'save', message: f.message });
        else setBanner({ kind: 'save', message: f.status ? f.message : 'Check the connection and try again.' });
      } finally {
        setSaving(false);
      }
    },
    [sketcher, saving, filesNow, request, key, queryClient, savedTitle, finish, say],
  );
  const saveRef = useRef(save);
  saveRef.current = save;
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // --- keyboard ---------------------------------------------------------------------------------
  useEffect(() => {
    if (!sketcher) return;
    const keyOf: Record<string, ToolId> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));
    const down = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // the editor sits over the page: keys used here must not reach the page behind it. A text field keeps its
      // own keys (they must reach it), so only Esc and Ctrl+S are taken from it.
      if (!isTyping(e.target) || e.key === 'Escape' || (mod && k === 's')) e.stopPropagation();
      if (mod && k === 's') {
        e.preventDefault();
        if (phaseRef.current === 'ready') void saveRef.current('save', false);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        const st = sketcher.getState();
        if (st.textEdit) sketcher.endText(false);
        else if (st.hasSelection || st.hasCropBox || st.selectedText) sketcher.cancel();
        else requestCloseRef.current();
        return;
      }
      if (isTyping(e.target) || phaseRef.current !== 'ready') return; // no drawing yet: only Esc and Ctrl+S above
      if (e.key === ' ') {
        e.preventDefault();
        sketcher.setSpace(true);
        return;
      }
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) sketcher.redo();
        else sketcher.undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        sketcher.redo();
        return;
      }
      if (mod && k === 'a') {
        e.preventDefault();
        sketcher.setTool('select');
        sketcher.selectAll();
        return;
      }
      if (mod && k === '0') {
        e.preventDefault();
        sketcher.fit();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === '[') sketcher.nudgeSize(-1);
      else if (e.key === ']') sketcher.nudgeSize(1);
      else if (e.key === '+' || e.key === '=') sketcher.zoomBy(1.25);
      else if (e.key === '-') sketcher.zoomBy(0.8);
      else if (e.key === '1') sketcher.zoomTo(1);
      else if (e.key === 'Delete' || e.key === 'Backspace') sketcher.deleteSelection();
      else if (e.key === 'Enter') {
        if (sketcher.getState().tool === 'crop') sketcher.cropToBox();
        else sketcher.commitSelection();
      } else if (keyOf[k]) sketcher.setTool(keyOf[k]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') sketcher.setSpace(false);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [sketcher]);

  // keep the page behind from scrolling
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // --- the text box -----------------------------------------------------------------------------
  const textRef = useRef<HTMLTextAreaElement>(null);
  const textKey = state?.textEdit ? `${state.textEdit.id ?? 'new'}:${state.textEdit.left}:${state.textEdit.top}` : '';
  useEffect(() => {
    const el = textRef.current;
    if (!el || !textKey) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length); // typing continues after the existing text
  }, [textKey]);
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
    el.style.width = '0px';
    el.style.width = `${Math.max(60, el.scrollWidth + 6)}px`;
  }, [state?.textEdit?.text, state?.textEdit?.px, textKey]);

  const closeDisabled = saving;
  const ownerKind = KIND_LABEL[request.ownerKind];
  const ownerName = request.ownerLabel ?? request.ownerId;
  const warnSize = nearLimit(0, sourceBytes);

  const draftBanner = draftFound && phase === 'ready' && !banner && (
    <div className={`${styles.banner} ${styles.bannerInfo}`} role="status" data-testid="sketch-draft-found">
      <SketchIcon name="refresh" size={18} />
      <div className={styles.bannerText}>
        <b>Unsaved drawing found</b>
        <span>
          You closed the app while drawing “{draftFound.title}”{' '}
          {relativeTime(new Date(draftFound.savedAt).toISOString())}.
        </span>
      </div>
      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        data-testid="sketch-draft-restore"
        onClick={async () => {
          try {
            await sketcher?.openSource(parseSource(draftFound.source));
            sketcher?.markDirty();
            setTitle(draftFound.title);
            setTitleChanged(true);
          } catch {
            say('The draft could not be opened.');
          }
          setDraftFound(null);
        }}
      >
        Restore
      </button>
      <button
        type="button"
        className={styles.btn}
        onClick={() => {
          void deleteDraft(key);
          setDraftFound(null);
        }}
      >
        Discard
      </button>
    </div>
  );

  const ready = phase === 'ready' && sketcher && state;

  return createPortal(
    <div
      className={styles.layer}
      data-testid="sketch-editor"
      data-sketch-layer
      role="dialog"
      aria-modal="true"
      aria-label={`Sketch: ${title}`}
    >
      <div className={styles.sheet}>
        <header className={styles.header}>
          <span className={`${styles.logo} ${styles.hideNarrow}`}>
            <SketchIcon name="sketch" size={20} />
          </span>
          <div className={styles.titleBlock}>
            <div className={styles.titleRow}>
              <input
                className={styles.titleInput}
                value={title}
                aria-label="Name of the sketch"
                maxLength={200}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleChanged(true);
                }}
                data-testid="sketch-title"
              />
              <span className={styles.badge}>SKETCH</span>
            </div>
            <div className={`${styles.subtitle} ${styles.hideNarrow}`}>
              in {ownerKind} “{ownerName}”
            </div>
          </div>
          <span className={styles.spacer} />
          {ready && (
            <>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => sketcher.undo()}
                disabled={!state.canUndo}
                aria-label="Undo"
                title="Undo (Ctrl+Z)"
                data-testid="sketch-undo"
              >
                <SketchIcon name="undo" />
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => sketcher.redo()}
                disabled={!state.canRedo}
                aria-label="Redo"
                title="Redo (Ctrl+Shift+Z)"
                data-testid="sketch-redo"
              >
                <SketchIcon name="redo" />
              </button>
              <span className={`${styles.divider} ${styles.hideNarrow}`} />
              <span className={`${styles.zoomGroup} ${styles.hideNarrow}`}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => sketcher.zoomBy(0.8)}
                  aria-label="Zoom out"
                  title="Zoom out (-)"
                >
                  <SketchIcon name="zoomOut" />
                </button>
                <button
                  type="button"
                  className={styles.zoomLabel}
                  onClick={() => sketcher.zoomTo(1)}
                  title="Reset to 100% (1)"
                  data-testid="sketch-zoom"
                >
                  {Math.round(state.zoom * 100)}%
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => sketcher.zoomBy(1.25)}
                  aria-label="Zoom in"
                  title="Zoom in (+)"
                >
                  <SketchIcon name="zoomIn" />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => sketcher.fit()}
                  aria-label="Fit to window"
                  title="Fit to window (Ctrl+0)"
                >
                  <SketchIcon name="fit" />
                </button>
              </span>
              <span className={styles.divider} />
              <button
                type="button"
                className={styles.btn}
                disabled={saving}
                onClick={() => void save('copy', false)}
                data-testid="sketch-save-copy"
                aria-label="Save a copy"
              >
                <span className={styles.showNarrow}>
                  <SketchIcon name="copy" size={16} />
                </span>
                <span className={styles.hideNarrow}>Save a copy</span>
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={saving}
                onClick={() => void save('save', true)}
                data-testid="sketch-done"
              >
                <SketchIcon name="check" size={15} /> {saving ? 'Saving…' : 'Done'}
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            onClick={requestClose}
            disabled={closeDisabled}
            aria-label="Close"
            title="Close (Esc)"
            data-testid="sketch-close"
          >
            <SketchIcon name="close" />
          </button>
        </header>

        {ready && <OptionsBar sketcher={sketcher} state={state} />}

        {banner?.kind === 'save' && (
          <div className={`${styles.banner} ${styles.bannerError}`} role="alert" data-testid="sketch-save-failed">
            <SketchIcon name="warning" size={18} />
            <div className={styles.bannerText}>
              <b>Could not save</b>
              <span>Your drawing is safe in a draft on this computer. {banner.message}</span>
            </div>
            <button
              type="button"
              className={styles.btn}
              onClick={() => void save('save', false)}
              data-testid="sketch-try-again"
            >
              <SketchIcon name="refresh" size={14} /> Try again
            </button>
          </div>
        )}
        {banner?.kind === 'conflict' && (
          <div className={`${styles.banner} ${styles.bannerWarn}`} role="alert" data-testid="sketch-conflict">
            <SketchIcon name="users" size={18} />
            <div className={styles.bannerText}>
              <b>{banner.failure.latestAuthor ?? 'Someone'} saved this drawing while you were drawing</b>
              <span>Your version has not been lost. Save yours as a copy, or replace theirs.</span>
            </div>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={saving}
              onClick={() => void save('copy', false)}
              data-testid="sketch-conflict-copy"
            >
              Save a copy
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={saving}
              onClick={() => void save('replace', false)}
              data-testid="sketch-conflict-replace"
            >
              Replace theirs
            </button>
          </div>
        )}
        {banner?.kind === 'large' && (
          <div className={`${styles.banner} ${styles.bannerError}`} role="alert" data-testid="sketch-too-large">
            <SketchIcon name="warning" size={18} />
            <div className={styles.bannerText}>
              <b>This drawing is too large to save</b>
              <span>
                {banner.problems.map((p) => p.message.replace(/^This drawing is too large to save\.\s*/, '')).join(' ')}
              </span>
            </div>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                setBanner(null);
                sketcher?.setTool('crop');
              }}
            >
              Crop and resize
            </button>
          </div>
        )}
        {draftBanner}

        <div className={`${styles.body} ${narrow ? styles.bodyNarrow : ''}`}>
          {ready && (
            <nav className={styles.tools} aria-label="Tools">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.tool} ${state.tool === t.id ? styles.toolOn : ''}`}
                  aria-pressed={state.tool === t.id}
                  aria-label={t.name}
                  aria-keyshortcuts={t.key}
                  title={`${t.name} (${t.key})`}
                  onClick={() => sketcher.setTool(t.id)}
                  data-testid={`sketch-tool-${t.id}`}
                >
                  <SketchIcon name={t.icon} size={20} />
                </button>
              ))}
              {narrow && (
                <>
                  <button
                    type="button"
                    className={`${styles.tool} ${sheet === 'colour' ? styles.toolOn : ''}`}
                    aria-label="Colour"
                    aria-pressed={sheet === 'colour'}
                    onClick={() => setSheet(sheet === 'colour' ? null : 'colour')}
                  >
                    <span className={styles.toolColour} style={{ background: state.colour }} />
                  </button>
                  <button
                    type="button"
                    className={`${styles.tool} ${sheet === 'layers' ? styles.toolOn : ''}`}
                    aria-label="Layers"
                    aria-pressed={sheet === 'layers'}
                    onClick={() => setSheet(sheet === 'layers' ? null : 'layers')}
                  >
                    <SketchIcon name="layers" size={20} />
                  </button>
                </>
              )}
            </nav>
          )}
          <div className={styles.stage} data-testid="sketch-stage">
            <canvas ref={canvasRef} className={styles.canvas} data-testid="sketch-canvas" aria-label="Drawing" />
            {state?.textEdit && (
              <textarea
                key={textKey}
                ref={textRef}
                className={styles.textBox}
                style={{
                  left: state.textEdit.left,
                  top: state.textEdit.top,
                  fontSize: state.textEdit.px,
                  color: state.textEdit.color,
                  fontWeight: state.textEdit.bold ? 700 : 400,
                }}
                value={state.textEdit.text}
                aria-label="Text"
                data-testid="sketch-text"
                onChange={(e) => sketcher?.setTextDraft(e.target.value)}
                onBlur={() => sketcher?.endText(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sketcher?.endText(true);
                  }
                }}
              />
            )}
            {notice && (
              <div className={styles.notice} role="status" data-testid="sketch-notice">
                {notice}
              </div>
            )}
            {phase === 'loading' && (
              <div className={styles.cover}>
                <div className={styles.card} role="status">
                  <div className={styles.spinner} />
                  <div className={styles.cardTitle}>Opening the drawing…</div>
                </div>
              </div>
            )}
            {phase === 'new' && (
              <NewSketchDialog
                onCancel={() => finish(null)}
                onStart={(size) => {
                  sketcher?.newDocument(size.w, size.h, size.background);
                  setPhase('ready');
                }}
              />
            )}
            {(phase === 'missing' || phase === 'broken') && (
              <div className={styles.cover}>
                <div className={styles.card} role="alert" data-testid="sketch-unavailable">
                  <div className={styles.cardTitle}>
                    {phase === 'missing' ? 'Sketch not found' : 'The drawing could not be opened'}
                  </div>
                  <div className={styles.cardText}>
                    {phase === 'missing'
                      ? 'It was deleted, or you do not have access.'
                      : (notice ?? 'Check the connection and try again.')}
                  </div>
                  <div className={styles.cardRow}>
                    <button type="button" className={styles.btn} onClick={() => finish(null)}>
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
            {phase === 'readonly' && saved && (
              <div className={styles.readonly} data-testid="sketch-readonly">
                <div className={styles.readonlyNote}>
                  <SketchIcon name="lock" size={16} /> Read only. Viewers see the drawing and can open it large; the
                  Edit button is shown only to people who can edit the page.
                </div>
                <img src={sketchPngUrl(saved.id, saved.version)} alt={saved.title} className={styles.readonlyImg} />
              </div>
            )}
            {confirmClose && (
              <div className={styles.cover}>
                <div
                  className={styles.dialog}
                  role="alertdialog"
                  aria-label="Save your drawing?"
                  data-testid="sketch-confirm-close"
                >
                  <div className={styles.dialogTitle}>Save your drawing?</div>
                  <div className={styles.cardText}>You have changes that are not saved to the {ownerKind}.</div>
                  <div className={styles.dialogRow}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnDanger}`}
                      onClick={() => {
                        void Promise.all([
                          deleteDraft(key),
                          deleteDraft(
                            draftKey({
                              ownerKind: request.ownerKind,
                              ownerId: request.ownerId,
                              sketchId: current.current.id,
                            }),
                          ),
                        ]).then(() => finish(lastResult));
                      }}
                      data-testid="sketch-discard"
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      autoFocus
                      onClick={() => setConfirmClose(false)}
                      data-testid="sketch-keep"
                    >
                      Keep editing
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => void save('save', true)}
                      data-testid="sketch-confirm-save"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          {ready && (
            <aside className={`${styles.side} ${narrow ? (sheet ? styles.sideSheet : styles.sideHidden) : ''}`}>
              {(!narrow || sheet === 'colour') && <ColourPanel sketcher={sketcher} state={state} />}
              {(!narrow || sheet === 'layers') && <LayersPanel sketcher={sketcher} state={state} />}
            </aside>
          )}
        </div>

        <footer className={styles.status}>
          {ready && (
            <>
              <span data-testid="sketch-dims">
                {state.width} × {state.height} px
              </span>
              <span ref={cursorRef} className={styles.cursor} />
              <span className={styles.spacer} />
              {warnSize && (
                <span className={styles.statusWarn}>
                  Getting large: {formatBytes(sourceBytes)} of {formatBytes(MAX_BYTES)}
                </span>
              )}
              {draftStatus === 'saved' && (
                <span className={styles.statusOk} data-testid="sketch-draft-status">
                  <SketchIcon name="check" size={13} /> Draft saved on this computer
                </span>
              )}
              {draftStatus === 'failed' && (
                <span className={styles.statusWarn}>Draft could not be kept on this computer</span>
              )}
              <span data-testid="sketch-saved-status">
                {dirty ? `Not yet saved to the ${ownerKind}` : saved ? 'Saved' : `Not yet saved to the ${ownerKind}`}
              </span>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
