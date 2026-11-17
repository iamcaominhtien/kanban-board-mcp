/**
 * The frame of an HTML embed (design "Embeds", frames 1-9, 73): the always-visible sandbox note with "What is
 * blocked?", the frame itself and its states. Scripts run only when the embed asks for them, the project allows them
 * (`scriptsInEmbeds` is not `off`) and the reader pressed "Run it" in this view; otherwise the frame gets
 * `sandbox=""` and a fixed height. Too large (over 512 KB) and could-not-load are shown in place of the frame.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../editor/blocks/ui';
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
  listWords,
} from './htmlSandbox';
import '../editor/blocks/blocks.css';
import './embeds.css';

/** How long a frame may take to load before it counts as blocked (ms). */
const LOAD_TIMEOUT_MS = 10_000;

/** What the sandbox allows and blocks (frame 3), opened from the note. */
export function SandboxSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="The sandbox"
      onClose={onClose}
      width={440}
      testId="sandbox-sheet"
      footer={
        <button type="button" className="dk-btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="dk-emb-sheet-lead">
        An HTML embed is a small web page that lives in its own box. It cannot see or touch anything else on the board.
      </p>
      <div className="dk-emb-sheet-head">Allowed</div>
      <ul className="dk-emb-sheet-list dk-emb-ok">
        <li>HTML and CSS</li>
        <li>Scripts that change this embed only</li>
        <li>Images and fonts the page links to (loaded, never sent anything)</li>
        <li>Forms that stay inside the embed</li>
      </ul>
      <div className="dk-emb-sheet-head">Blocked</div>
      <ul className="dk-emb-sheet-list dk-emb-no">
        <li>Reading this board, your login or cookies</li>
        <li>Network requests from scripts</li>
        <li>Pop-ups and new windows</li>
        <li>Sending you to another page</li>
        <li>Camera, microphone and location</li>
      </ul>
    </Dialog>
  );
}

/** The always-visible note above an embed: what the sandbox is, and the sheet that says what it blocks. */
export function SandboxNote() {
  const [open, setOpen] = useState(false);
  return (
    <div className="dk-emb-note" contentEditable={false}>
      <span>Runs in a sandbox: no access to this board.</span>
      <button type="button" className="dk-emb-link" onClick={() => setOpen(true)}>
        What is blocked?
      </button>
      {open && <SandboxSheet onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Words for one thing the sandbox blocked. */
function blockedWords(raw: string): string {
  if (raw === 'popup') return 'a pop-up window';
  const [directive, uri] = raw.split(' ');
  let host = '';
  try {
    host = uri ? new URL(uri).hostname : '';
  } catch {
    host = '';
  }
  if (directive?.startsWith('connect')) return host ? `a network request to ${host}` : 'a network request';
  if (directive?.startsWith('form')) return 'sending a form';
  if (directive?.startsWith('frame') || directive?.startsWith('child')) return 'a frame';
  return host ? `something from ${host}` : 'something the page asked for';
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
  const [blocked, setBlocked] = useState<string[]>([]);
  const [details, setDetails] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadedRef = useRef(false);
  loadedRef.current = loaded;

  const bytes = useMemo(() => byteSize(html), [html]);
  const tooLarge = bytes > HTML_EMBED_LIMIT;
  const scriptsOff = settings.data?.scriptsInEmbeds === 'off';
  const wantsScripts = runScripts && hasScripts(html);
  const scripts = wantsScripts && !scriptsOff && ran;
  const srcDoc = useMemo(() => buildSrcdoc(html, { scripts, frameId }), [html, scripts, frameId]);

  // the frame's own script reports the height and what was blocked; only messages from this frame count
  useEffect(() => {
    if (!scripts) return undefined;
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: string; height?: number; blocked?: string } | null;
      if (!d || d.type !== FRAME_MESSAGE || d.id !== frameId) return;
      if (ref.current && e.source !== ref.current.contentWindow) return;
      if (typeof d.height === 'number' && Number.isFinite(d.height))
        setMeasured(Math.max(40, Math.min(4000, Math.round(d.height))));
      if (typeof d.blocked === 'string') {
        const words = blockedWords(d.blocked);
        setBlocked((list) => (list.includes(words) ? list : [...list, words]));
      }
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
      <div className="dk-emb-state" role="status" data-testid="html-embed-too-large">
        <strong>Too large to embed</strong>
        <span>
          This HTML is {kbOrMb(bytes)}. An embed can be 512 KB at most. Move images out, or attach the file instead.
        </span>
        {tooLargeActions && <div className="dk-emb-actions">{tooLargeActions}</div>}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="dk-emb-state" role="status" data-testid="html-embed-failed">
        <strong>This embed could not load</strong>
        <span>Your browser may be offline, or it blocked the frame. The page itself is fine.</span>
        <div className="dk-emb-actions">
          <button
            type="button"
            className="dk-btn-ghost"
            onClick={() => {
              setFailed(false);
              setAttempt((a) => a + 1);
            }}
          >
            Retry
          </button>
          {onViewSource && (
            <button type="button" className="dk-btn-ghost" onClick={onViewSource}>
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
          Scripts are turned off for this project, so this embed shows without them. Ask a project admin to turn them on
          in Settings.
        </div>
      )}
      {wantsScripts && !scriptsOff && !ran && (
        <div className="dk-emb-bar" role="note">
          <span>This embed has scripts. They run inside the sandbox only.</span>
          <button type="button" className="dk-btn-primary dk-emb-run" onClick={() => setRan(true)}>
            Run it
          </button>
        </div>
      )}
      {blocked.length > 0 && (
        <div className="dk-emb-bar dk-emb-bar-warn" role="status">
          <span>
            <strong>{blocked.length === 1 ? '1 thing was blocked.' : `${blocked.length} things were blocked.`}</strong>{' '}
            {details ? `${listWords(blocked).replace(/^./, (c) => c.toUpperCase())}. ` : ''}The rest ran.
          </span>
          <button type="button" className="dk-emb-link" onClick={() => setDetails((v) => !v)}>
            {details ? 'Hide details' : 'Details'}
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
        style={{ height: frameHeight }}
        onLoad={() => setLoaded(true)}
        data-scripts={scripts ? 'on' : 'off'}
      />
    </div>
  );
}
