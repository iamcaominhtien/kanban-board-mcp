import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  createDiagram,
  diagramFailure,
  fetchDiagramWithSource,
  updateDiagram,
  useDiagramSettings,
  type Diagram,
  type DiagramFailure,
} from '../../api/diagrams';
import { diagramMarkdown } from '../../api/diagrams';
import { useToast } from '../Toast';
import { DiagramIcon } from './DiagramIcon';
import type { EditorRequest } from './DiagramsContext';
import { EMPTY_DIAGRAM_XML, decodeExportData, fileStem, saveBlob, svgToPng } from './diagramFile';
import styles from './Diagrams.module.css';

const UNREACHABLE_AFTER_MS = 20_000;
const EXPORT_TIMEOUT_MS = 30_000;

type Phase = 'loading' | 'ready' | 'unreachable' | 'missing';
type Problem =
  | { kind: 'save'; message: string }
  | { kind: 'conflict'; failure: DiagramFailure }
  | { kind: 'large'; failure: DiagramFailure }
  | null;

interface Draft {
  xml: string;
  label: string;
  baseVersion: number;
}

function draftKey(req: EditorRequest): string {
  return `kanban.diagram.draft.${req.diagramId ?? `new.${req.projectId}`}`;
}

function readDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: Draft | null): void {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable or full: the draft is only a convenience */
  }
}

/** Build the embed URL of the draw.io editor. */
function editorSrc(base: string): string {
  const q = new URLSearchParams({
    embed: '1',
    proto: 'json',
    spin: '1',
    ui: 'kennedy',
    libraries: '1',
    saveAndExit: '0',
    noSaveBtn: '1',
    noExitBtn: '1',
    lang: 'en',
  });
  return `${base}/?${q.toString()}`;
}

interface Props {
  request: EditorRequest;
  onClose: () => void;
}

/**
 * The editor layer: the real draw.io editor in an iframe under our own header bar.
 * @param props.request - What to edit or create, and what to do after a save.
 * @param props.onClose - Called when the layer closes (saved or cancelled).
 */
export function DiagramEditor({ request, onClose }: Props) {
  const toast = useToast();
  const settings = useDiagramSettings();
  const key = useMemo(() => draftKey(request), [request]);
  const frame = useRef<HTMLIFrameElement>(null);
  const waiters = useRef(new Map<string, (data: string) => void>());
  const lastXml = useRef<string>('');
  const loaded = useRef<{ xml: string; baseVersion: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>('loading');
  const [label, setLabel] = useState(request.label ?? 'Untitled diagram');
  const [existing, setExisting] = useState<Diagram | null>(null);
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const pending = useRef<{ xml: string; svg: string } | null>(null);
  const baseVersion = useRef(0);

  const base = settings.data?.effectiveUrl;
  const origin = useMemo(() => {
    try {
      return base ? new URL(base).origin : '';
    } catch {
      return '';
    }
  }, [base]);

  // what we start from: the saved diagram, an imported file or a blank drawing, or a local draft of it
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let xml = request.initialXml ?? EMPTY_DIAGRAM_XML;
      let version = 0;
      if (request.diagramId) {
        try {
          const d = await fetchDiagramWithSource(request.diagramId);
          if (cancelled) return;
          setExisting(d);
          setLabel(d.label);
          xml = d.source ?? xml;
          version = d.version;
        } catch {
          if (!cancelled) setPhase('missing');
          return;
        }
      }
      const draft = readDraft(key);
      if (draft && draft.xml && draft.xml !== xml && draft.baseVersion === version) {
        xml = draft.xml;
        setLabel(draft.label || label);
        setModified(true);
        setRestoredDraft(true);
      }
      baseVersion.current = version;
      loaded.current = { xml, baseVersion: version };
      lastXml.current = xml;
      setPhase((p) => (p === 'missing' ? p : 'loading'));
      setAttempt((a) => a + 1);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.diagramId, key]);

  const post = useCallback(
    (msg: Record<string, unknown>) => {
      frame.current?.contentWindow?.postMessage(JSON.stringify(msg), origin || '*');
    },
    [origin],
  );

  const exportAs = useCallback(
    (format: 'xml' | 'svg'): Promise<string> =>
      new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          waiters.current.delete(format);
          reject(new Error('The editor did not answer'));
        }, EXPORT_TIMEOUT_MS);
        waiters.current.set(format, (data) => {
          window.clearTimeout(timer);
          waiters.current.delete(format);
          resolve(data);
        });
        post({ action: 'export', format });
      }),
    [post],
  );

  // messages from the editor
  useEffect(() => {
    if (!origin) return;
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin || typeof e.data !== 'string') return;
      let msg: { event?: string; xml?: string; data?: string; format?: string };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.event === 'init') {
        post({
          action: 'load',
          autosave: 1,
          xml: loaded.current?.xml ?? EMPTY_DIAGRAM_XML,
          title: `${fileStem(label)}.drawio`,
        });
      } else if (msg.event === 'load') {
        setPhase('ready');
      } else if (msg.event === 'autosave' || msg.event === 'save') {
        if (typeof msg.xml === 'string') {
          lastXml.current = msg.xml;
          setModified(msg.xml !== loaded.current?.xml);
        }
        if (msg.event === 'save') document.dispatchEvent(new CustomEvent('diagram-editor-save'));
      } else if (msg.event === 'export' && msg.format) {
        waiters.current.get(msg.format)?.(msg.data ?? '');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, post]);

  // the editor never answered: say so, the diagram stays viewable and downloadable
  useEffect(() => {
    if (!base || attempt === 0 || phase !== 'loading') return;
    const t = window.setTimeout(() => setPhase((p) => (p === 'loading' ? 'unreachable' : p)), UNREACHABLE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [base, attempt, phase]);

  // keep a local draft while there are unsaved edits
  useEffect(() => {
    if (!modified || phase !== 'ready') return;
    writeDraft(key, { xml: lastXml.current, label, baseVersion: baseVersion.current });
  }, [modified, label, key, phase]);

  async function currentContent(): Promise<{ xml: string; svg: string }> {
    let xml = lastXml.current;
    try {
      xml = decodeExportData(await exportAs('xml')) || xml;
    } catch {
      /* fall back to the last autosave */
    }
    const svg = decodeExportData(await exportAs('svg'));
    return { xml, svg };
  }

  async function finish(d: Diagram, created: boolean, asCopy: boolean) {
    writeDraft(key, null);
    request.onSaved(d, { created, asCopy });
    onClose();
  }

  async function save(content?: { xml: string; svg: string }) {
    if (saving || phase !== 'ready') return;
    setSaving(true);
    setProblem(null);
    try {
      const { xml, svg } = content ?? (await currentContent());
      pending.current = { xml, svg };
      const clean = label.trim() || 'Untitled diagram';
      const saved = request.diagramId
        ? await updateDiagram(request.diagramId, { baseVersion: baseVersion.current, source: xml, svg, label: clean })
        : await createDiagram(request.projectId, {
            label: clean,
            source: xml,
            svg,
            itemKind: request.itemKind,
            itemId: request.itemId,
          });
      await finish(saved, !request.diagramId, false);
    } catch (err) {
      const f = diagramFailure(err);
      if (f.code === 'diagram_conflict') setProblem({ kind: 'conflict', failure: f });
      else if (f.code === 'diagram_too_large') setProblem({ kind: 'large', failure: f });
      else setProblem({ kind: 'save', message: f.message });
    } finally {
      setSaving(false);
    }
  }

  async function saveAsCopy() {
    const content = pending.current;
    if (!content) return;
    setSaving(true);
    try {
      const copy = await createDiagram(request.projectId, {
        label: `${label.trim() || 'Untitled diagram'} (copy)`,
        source: content.xml,
        svg: content.svg,
        itemKind: request.itemKind,
        itemId: request.itemId,
      });
      writeDraft(key, null);
      request.onSaved(copy, { created: true, asCopy: true });
      if (!request.replaces) {
        navigator.clipboard?.writeText(diagramMarkdown(copy)).catch(() => undefined);
        toast.success('Saved as a copy', 'Its markdown line is on your clipboard. Paste it where it belongs.');
      }
      onClose();
    } catch (err) {
      setProblem({ kind: 'save', message: diagramFailure(err).message });
    } finally {
      setSaving(false);
    }
  }

  async function reloadTheirs() {
    if (!request.diagramId) return;
    try {
      const d = await fetchDiagramWithSource(request.diagramId);
      baseVersion.current = d.version;
      loaded.current = { xml: d.source ?? EMPTY_DIAGRAM_XML, baseVersion: d.version };
      lastXml.current = loaded.current.xml;
      setExisting(d);
      setLabel(d.label);
      setModified(false);
      setProblem(null);
      writeDraft(key, null);
      post({ action: 'load', autosave: 1, xml: loaded.current.xml, title: `${fileStem(d.label)}.drawio` });
    } catch (err) {
      setProblem({ kind: 'save', message: diagramFailure(err).message });
    }
  }

  // Ctrl+S inside the editor
  useEffect(() => {
    const on = () => void save();
    document.addEventListener('diagram-editor-save', on);
    return () => document.removeEventListener('diagram-editor-save', on);
  });

  function cancel() {
    if (modified) setConfirmClose(true);
    else {
      writeDraft(key, null);
      onClose();
    }
  }

  async function exportCurrent(kind: 'drawio' | 'svg' | 'png') {
    setExportMenu(false);
    try {
      const { xml, svg } = await currentContent();
      const stem = fileStem(label);
      if (kind === 'drawio') saveBlob(new Blob([xml], { type: 'application/xml' }), `${stem}.drawio`);
      else if (kind === 'svg') saveBlob(new Blob([svg], { type: 'image/svg+xml' }), `${stem}.svg`);
      else saveBlob(await svgToPng(svg), `${stem}.png`);
    } catch {
      toast.error("Couldn't export", 'The editor did not answer.');
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!confirmClose) cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const saveTo = request.saveTo;
  const unreachable = phase === 'unreachable';

  return createPortal(
    <div
      className={styles.layer}
      role="dialog"
      aria-modal="true"
      aria-label="Diagram editor"
      data-testid="diagram-editor"
      data-diagram-layer
    >
      <div className={styles.sheet}>
        <div className={styles.bar}>
          <span className={styles.chip}>
            <DiagramIcon name="drawio" size={13} /> draw.io
          </span>
          <input
            className={styles.titleInput}
            value={label}
            maxLength={200}
            aria-label="Diagram title"
            onChange={(e) => {
              setLabel(e.target.value);
              setModified(true);
            }}
          />
          <span className={styles.status} role="status">
            <span className={`${styles.statusDot} ${modified ? styles.statusDotWarn : ''}`} />
            {saving ? 'Saving…' : modified ? 'Draft kept in this browser' : 'No changes yet'}
          </span>
          <span className={styles.spacer} />
          {saveTo && (
            <span className={styles.saveTo}>
              Saves to: <b>{saveTo}</b>
            </span>
          )}
          <span className={styles.exportWrap}>
            <button
              type="button"
              className={styles.btn}
              disabled={phase !== 'ready' || saving}
              aria-haspopup="menu"
              aria-expanded={exportMenu}
              onClick={() => setExportMenu((m) => !m)}
            >
              <DiagramIcon name="download" /> Export
            </button>
            {exportMenu && (
              <div className={styles.exportMenu} role="menu">
                <div className={styles.menuHead}>EXPORT</div>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => void exportCurrent('drawio')}
                >
                  <DiagramIcon name="file" /> Editable file <span className={styles.menuExt}>.drawio</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => void exportCurrent('svg')}
                >
                  <DiagramIcon name="image" /> Vector image <span className={styles.menuExt}>.svg</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => void exportCurrent('png')}
                >
                  <DiagramIcon name="image" /> Image, 2× <span className={styles.menuExt}>.png</span>
                </button>
              </div>
            )}
          </span>
          <button type="button" className={styles.btn} onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={phase !== 'ready' || saving}
            onClick={() => void save()}
          >
            <DiagramIcon name="check" /> {saving ? 'Saving…' : 'Save to page'}
          </button>
        </div>

        {restoredDraft && !problem && (
          <div className={`${styles.banner} ${styles.bannerInfo}`} role="status">
            Restored your unsaved draft from this browser.
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                writeDraft(key, null);
                setRestoredDraft(false);
                setModified(false);
                const orig = existing?.source ?? request.initialXml ?? EMPTY_DIAGRAM_XML;
                loaded.current = { xml: orig, baseVersion: baseVersion.current };
                lastXml.current = orig;
                post({ action: 'load', autosave: 1, xml: orig });
              }}
            >
              Discard draft
            </button>
          </div>
        )}
        {problem?.kind === 'save' && (
          <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
            Could not save. Your edits are kept in this editor. {problem.message}
            <button type="button" className={styles.btn} onClick={() => void save(pending.current ?? undefined)}>
              Retry
            </button>
          </div>
        )}
        {problem?.kind === 'conflict' && (
          <div className={`${styles.banner} ${styles.bannerWarn}`} role="alert" data-testid="diagram-conflict">
            <b>{problem.failure.latestAuthor ?? 'Someone'} saved a newer version</b>
            Someone changed this diagram while you were editing. Save yours as a copy, or reload theirs.
            <button type="button" className={styles.btn} disabled={saving} onClick={() => void saveAsCopy()}>
              Save as copy
            </button>
            <button type="button" className={styles.btn} onClick={() => void reloadTheirs()}>
              Reload theirs
            </button>
          </div>
        )}

        <div className={styles.frameWrap}>
          {base && phase !== 'missing' && (
            <iframe
              key={attempt}
              ref={frame}
              className={styles.frame}
              title="draw.io editor"
              src={editorSrc(base)}
              allow="clipboard-read; clipboard-write"
            />
          )}
          {phase === 'loading' && (
            <div className={styles.cover}>
              <div className={styles.card} role="status">
                <div className={styles.spinner} />
                <div className={styles.cardTitle}>Opening the editor…</div>
                <div className={styles.cardText}>Your diagram loads once the editor is ready.</div>
              </div>
            </div>
          )}
          {(unreachable || phase === 'missing') && (
            <div className={styles.cover}>
              <div className={styles.card} role="alert" data-testid="diagram-editor-unreachable">
                <div className={styles.cardTitle}>
                  {phase === 'missing' ? 'Diagram not found' : 'Editor could not be reached'}
                </div>
                <div className={styles.cardText}>
                  {phase === 'missing'
                    ? 'It was deleted, or you do not have access.'
                    : 'The diagram is still shown on the page and can be downloaded. Editing needs the draw.io service. Ask an admin to check the editor address in Settings.'}
                </div>
                <div className={styles.cardRow}>
                  {request.diagramId && phase === 'unreachable' && (
                    <a
                      className={styles.btn}
                      href={`${import.meta.env.VITE_API_URL ?? ''}/diagrams/${request.diagramId}/download?format=drawio`}
                      download
                    >
                      Download .drawio
                    </a>
                  )}
                  {phase === 'unreachable' && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => {
                        setPhase('loading');
                        setAttempt((a) => a + 1);
                      }}
                    >
                      Retry
                    </button>
                  )}
                  <button type="button" className={styles.btn} onClick={onClose}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
          {problem?.kind === 'large' && (
            <div className={styles.cover}>
              <div className={styles.card} role="alert" data-testid="diagram-too-large">
                <div className={styles.cardTitle}>Too large</div>
                <div className={styles.cardText}>{problem.failure.message}</div>
                <div className={styles.cardRow}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => setProblem(null)}
                  >
                    Back to editor
                  </button>
                </div>
              </div>
            </div>
          )}
          {confirmClose && (
            <div className={styles.cover}>
              <div
                className={styles.card}
                role="alertdialog"
                aria-label="Discard your changes?"
                data-testid="diagram-discard"
              >
                <div className={styles.cardTitle}>Discard your changes?</div>
                <div className={styles.cardText}>The diagram has edits that are not saved to the page yet.</div>
                <div className={styles.cardRow}>
                  <button type="button" className={styles.btn} autoFocus onClick={() => setConfirmClose(false)}>
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => {
                      writeDraft(key, null);
                      onClose();
                    }}
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
