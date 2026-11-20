/**
 * The frame of an HTML embed (design "Embeds", frames 1-9, 73): the frame itself and its states. Scripts run as soon as the embed is shown when the embed asks for them
 * and the project's `scriptsInEmbeds` is `on` (the default); with `ask` the reader presses "Run it" first, with
 * `off` they never run and the frame gets `sandbox=""` and a fixed height. While scripts run the frame has no sandbox. Too large (over the limit) and
 * could-not-load are shown in place of the frame. An embed with a `src` (a site uploaded as a folder) opens that
 * address instead of its HTML; it always wants its scripts, and Height Auto reads the page's own height (same origin).
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmbIcon } from './embIcons';
import { useDocsSpaceSettings } from './embedApi';
import {
  DEFAULT_EMBED_HEIGHT,
  FRAME_MESSAGE,
  HTML_EMBED_LIMIT,
  buildSrcdoc,
  byteSize,
  embedSandbox,
  hasScripts,
  kbOrMb,
} from './htmlSandbox';
import '../editor/blocks/blocks.css';
import './embeds.css';

/** How long a frame may take to load before it counts as blocked (ms). */
const LOAD_TIMEOUT_MS = 10_000;

/** Props of {@link HtmlEmbedFrame}. */
export interface HtmlEmbedFrameProps {
  /** The embed's HTML (unused when `src` is set). */
  html: string;
  /** The address of the site the embed shows (`/docs/sites/<id>/<entry>`); wins over `html`. */
  src?: string | null;
  /** Its title (the frame's accessible name). */
  title: string;
  /** Fixed height in px; null follows the content (only possible while scripts run). */
  height: number | null;
  /** The embed's author wants its scripts to run (`runScripts`). */
  runScripts: boolean;
  /** The project whose `scriptsInEmbeds` setting applies. */
  projectId?: string;
  /** "View source" in the could-not-load state; unset hides it. */
  onViewSource?: () => void;
  /** Buttons of the too-large state (Edit code, Attach as a file); none for a reader. */
  tooLargeActions?: ReactNode;
}

/**
 * The embed's frame with its gate and states.
 */
export function HtmlEmbedFrame({
  html,
  src,
  title,
  height,
  runScripts,
  projectId,
  onViewSource,
  tooLargeActions,
}: HtmlEmbedFrameProps) {
  const settings = useDocsSpaceSettings(projectId);
  const frameId = useId();
  const ref = useRef<HTMLIFrameElement>(null);
  const [ran, setRan] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadedRef = useRef(false);
  loadedRef.current = loaded;

  const site = src || null;
  const bytes = useMemo(() => (site ? 0 : byteSize(html)), [html, site]);
  const tooLarge = bytes > HTML_EMBED_LIMIT;
  // until the project's choice is known nothing runs, so an "ask" project never runs a script before asking
  const policy = settings.isPending && !!projectId ? 'loading' : (settings.data?.scriptsInEmbeds ?? 'on');
  const scriptsOff = policy === 'off';
  // a site is a whole page with its own files: it runs as it would in a browser tab
  const wantsScripts = site ? true : runScripts && hasScripts(html);
  const scripts = wantsScripts && !scriptsOff && (policy === 'on' || ran);
  const srcDoc = useMemo(
    () => (site ? undefined : buildSrcdoc(html, { scripts, frameId })),
    [html, scripts, frameId, site],
  );
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), [site, attempt, scripts]);

  // a site comes from this board, so its document can be read: its height follows the content (Height: Auto)
  const measureSite = () => {
    observer.current?.disconnect();
    observer.current = null;
    if (!site || height != null) return;
    let doc: Document | null = null;
    try {
      doc = ref.current?.contentDocument ?? null;
    } catch {
      doc = null; // another origin, or sandboxed: the height stays fixed
    }
    const root = doc?.documentElement;
    if (!doc || !root) return;
    const read = () => {
      const h = Math.max(root.scrollHeight, doc?.body?.scrollHeight ?? 0);
      if (Number.isFinite(h) && h > 0) setMeasured(Math.max(40, Math.min(4000, Math.ceil(h))));
    };
    read();
    const own = (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
    const Ctor = own ?? (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver);
    if (Ctor) {
      observer.current = new Ctor(read);
      observer.current.observe(root);
      if (doc.body) observer.current.observe(doc.body);
    }
  };

  // the frame's own script reports the height; only messages from this frame count
  useEffect(() => {
    if (!scripts) return undefined;
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: string; height?: number } | null;
      if (!d || d.type !== FRAME_MESSAGE || d.id !== frameId) return;
      if (ref.current && e.source !== ref.current.contentWindow) return;
      if (typeof d.height === 'number' && Number.isFinite(d.height))
        setMeasured(Math.max(40, Math.min(4000, Math.round(d.height))));
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [scripts, frameId]);

  // a frame that never loads (offline, or the browser blocked it) shows the could-not-load card
  useEffect(() => {
    if (tooLarge) return undefined;
    setLoaded(false);
    const t = window.setTimeout(() => setFailed((f) => f || !loadedRef.current), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [srcDoc, site, attempt, tooLarge]);
  if (tooLarge) {
    return (
      <div className="dk-emb-fail dk-emb-fail-big" role="status" data-testid="html-embed-too-large">
        <EmbIcon name="warn" size={24} />
        <strong>Too large to embed</strong>
        <span>
          This HTML is {kbOrMb(bytes)}. An embed can be {kbOrMb(HTML_EMBED_LIMIT)} at most. Move images out, or attach
          the file instead.
        </span>
        {tooLargeActions && <div className="dk-emb-actions">{tooLargeActions}</div>}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="dk-emb-fail" role="status" data-testid="html-embed-failed">
        <EmbIcon name="offline" size={24} />
        <strong>This embed could not load</strong>
        <span>Your browser may be offline, or it blocked the frame. The page itself is fine.</span>
        <div className="dk-emb-actions">
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            onClick={() => {
              setFailed(false);
              setAttempt((a) => a + 1);
            }}
          >
            Retry
          </button>
          {onViewSource && (
            <button type="button" className="st-btn st-btn-sm" onClick={onViewSource}>
              View source
            </button>
          )}
        </div>
      </div>
    );
  }

  const frameHeight =
    height != null
      ? height
      : site
        ? (measured ?? DEFAULT_EMBED_HEIGHT)
        : scripts
          ? (measured ?? 150)
          : DEFAULT_EMBED_HEIGHT;
  return (
    <div className="dk-emb-frame-wrap">
      {wantsScripts && scriptsOff && (
        <div className="dk-emb-bar dk-emb-bar-muted" role="note">
          <EmbIcon name="lock" size={15} sw={2.2} />
          <span>
            Scripts are turned off for this project, so this embed shows without them. Ask a project admin to turn them
            on in Settings.
          </span>
        </div>
      )}
      {wantsScripts && policy === 'ask' && !ran && (
        <div className="dk-emb-bar" role="note">
          <EmbIcon name="code" size={15} sw={2.2} />
          <span>This embed has scripts.</span>
          <button type="button" className="st-btn st-btn-primary st-btn-sm dk-emb-run" onClick={() => setRan(true)}>
            Run it
          </button>
        </div>
      )}
      <iframe
        // a sandbox only takes effect when the frame loads, so a change of it loads the frame again
        key={`${attempt}-${scripts ? 'on' : 'off'}`}
        ref={ref}
        className="dk-emb-frame"
        title={title || 'HTML embed'}
        sandbox={embedSandbox(scripts)}
        {...(site ? { src: site } : { srcDoc })}
        referrerPolicy="no-referrer"
        allow="fullscreen; autoplay; clipboard-read; clipboard-write; camera; microphone; geolocation; xr-spatial-tracking; accelerometer; gyroscope"
        allowFullScreen
        style={{ height: frameHeight }}
        onLoad={() => {
          setLoaded(true);
          measureSite();
        }}
        data-scripts={scripts ? 'on' : 'off'}
      />
    </div>
  );
}
