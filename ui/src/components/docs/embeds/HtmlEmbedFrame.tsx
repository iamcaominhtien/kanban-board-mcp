/**
 * The frame of an HTML embed (design "Embeds", frames 1-9, 73): the always-visible sandbox note with "What is
 * blocked?", the frame itself and its states. Scripts run as soon as the embed is shown when the embed asks for them
 * and the project's `scriptsInEmbeds` is `on` (the default); with `ask` the reader presses "Run it" first, with
 * `off` they never run and the frame gets `sandbox=""` and a fixed height. Too large (over the limit) and
 * could-not-load are shown in place of the frame.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Panel } from '../editor/blocks/ui';
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

/** What the sandbox allows (frame 3). */
const ALLOWED = [
  'HTML and CSS',
  'Scripts, also libraries from the web (CDN)',
  'Network requests, images, fonts and video from the web',
  'Forms, pop-ups, dialogs and full screen',
];
/** What the sandbox blocks (frame 3). */
const BLOCKED = [
  'Reading this board, your login or cookies',
  'Sending this board to another page',
  'Camera, microphone and location',
];

/**
 * What the sandbox allows and blocks (frame 3), opened from the note: a 320 px popover under it on a desktop, a
 * sheet on a phone.
 * @param props.anchor - The rect of the note's link, where the popover points.
 */
export function SandboxSheet({ onClose, anchor }: { onClose: () => void; anchor: DOMRect | null }) {
  return (
    <Panel title="The sandbox" anchor={anchor} onClose={onClose} width={320} testId="sandbox-sheet">
      <p className="dk-emb-sheet-lead">
        An HTML embed is a small web page that lives in its own box. It cannot see or touch anything else on the board.
      </p>
      <div className="dk-emb-sheet-group dk-emb-ok">
        <div className="dk-emb-sheet-head">Allowed</div>
        <ul className="dk-emb-sheet-list">
          {ALLOWED.map((t) => (
            <li key={t}>
              <EmbIcon name="check" size={13} sw={2.6} />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="dk-emb-sheet-group dk-emb-no">
        <div className="dk-emb-sheet-head">Blocked</div>
        <ul className="dk-emb-sheet-list">
          {BLOCKED.map((t) => (
            <li key={t}>
              <EmbIcon name="x" size={13} sw={2.6} />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/** The always-visible note above an embed: what the sandbox is, and the sheet that says what it blocks. */
export function SandboxNote() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div className="dk-emb-note" contentEditable={false}>
      <EmbIcon name="shield" size={14} sw={2.2} />
      <span>Runs in a sandbox: no access to this board.</span>
      <button type="button" className="dk-emb-link" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        What is blocked?
      </button>
      {anchor && <SandboxSheet anchor={anchor} onClose={() => setAnchor(null)} />}
    </div>
  );
}

/** Props of {@link HtmlEmbedFrame}. */
export interface HtmlEmbedFrameProps {
  /** The embed's HTML. */
  html: string;
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

  const bytes = useMemo(() => byteSize(html), [html]);
  const tooLarge = bytes > HTML_EMBED_LIMIT;
  // until the project's choice is known nothing runs, so an "ask" project never runs a script before asking
  const policy = settings.isPending && !!projectId ? 'loading' : (settings.data?.scriptsInEmbeds ?? 'on');
  const scriptsOff = policy === 'off';
  const wantsScripts = runScripts && hasScripts(html);
  const scripts = wantsScripts && !scriptsOff && (policy === 'on' || ran);
  const srcDoc = useMemo(() => buildSrcdoc(html, { scripts, frameId }), [html, scripts, frameId]);

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
  }, [srcDoc, attempt, tooLarge]);
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

  const frameHeight = scripts && height == null ? (measured ?? 150) : (height ?? DEFAULT_EMBED_HEIGHT);
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
          <span>This embed has scripts. They run inside the sandbox only.</span>
          <button type="button" className="st-btn st-btn-primary st-btn-sm dk-emb-run" onClick={() => setRan(true)}>
            Run it
          </button>
        </div>
      )}
      <iframe
        key={attempt}
        ref={ref}
        className="dk-emb-frame"
        title={title || 'HTML embed'}
        sandbox={embedSandbox(scripts)}
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        allow="fullscreen; autoplay; clipboard-write; xr-spatial-tracking"
        allowFullScreen
        style={{ height: frameHeight }}
        onLoad={() => setLoaded(true)}
        data-scripts={scripts ? 'on' : 'off'}
      />
    </div>
  );
}
