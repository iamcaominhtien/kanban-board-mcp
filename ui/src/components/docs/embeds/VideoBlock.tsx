/**
 * Video in a page (design "Embeds", section B and frame 60): a poster and a Play button; nothing plays, and no player
 * of another site loads, until Play is pressed. A file plays in the browser's own player (controls always shown, 44 px
 * on touch); a YouTube, Vimeo or Loom video loads its player (YouTube through youtube-nocookie.com) only after Play.
 * Also the states of a file that cannot play: failed (missing or damaged) and a format the browser cannot play.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { uploadUrl } from '../../../api/tickets';
import { EmbIcon } from './embIcons';
import { fileNameOf, playableInBrowser, providerName, type VideoEmbed } from './videoEmbed';
import './embeds.css';

/** The round Play button over a poster. */
function PlayButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="dk-vid-play" aria-label={label} onClick={onClick}>
      <svg
        width="23"
        height="23"
        viewBox="0 0 24 24"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ marginLeft: 3 }}
      >
        <path d="M7 5L19 12L7 19Z" />
      </svg>
    </button>
  );
}

/** A dark 16:9 panel in the place of a video that cannot play (frames 17-18). */
function VideoState({
  title,
  text,
  icon,
  children,
}: {
  title: string;
  text: string;
  icon: 'warn' | 'film';
  children?: ReactNode;
}) {
  return (
    <div className="dk-vid-state" role="status">
      <EmbIcon name={icon} size={26} />
      <strong>{title}</strong>
      <span>{text}</span>
      {children && <div className="dk-emb-actions">{children}</div>}
    </div>
  );
}

/** The address a stored file downloads from. */
function downloadHref(src: string): string {
  return src.startsWith('/uploads/') ? uploadUrl(src, fileNameOf(src), true) : src;
}

/** Props of {@link VideoPlayer}. */
export interface VideoPlayerProps {
  src: string;
  poster?: string;
  /** Names the Play button ("Play Sprint demo"). */
  title?: string;
  loop?: boolean;
  muted?: boolean;
  /** Editor: Replace in the failed state. */
  onReplace?: () => void;
  /** Editor: the unsupported state's "Attach as a file". */
  onAttachAsFile?: () => void;
  /** Editor: the unsupported state's "Choose another". */
  onChooseAnother?: () => void;
}

/**
 * A video file: the poster until Play, then the browser's player. Never `autoplay`: the player starts because Play
 * was pressed.
 */
export function VideoPlayer({
  src,
  poster,
  title,
  loop,
  muted,
  onReplace,
  onAttachAsFile,
  onChooseAnother,
}: VideoPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!playing) return;
    const v = ref.current;
    // the press on our Play button is the person's choice to play; the browser may still refuse
    try {
      const p = v?.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    } catch {
      /* the controls are there to press */
    }
  }, [playing, attempt]);

  if (!playableInBrowser(src)) {
    const name = fileNameOf(src);
    return (
      <VideoState
        icon="film"
        title={`${name} cannot play in a browser`}
        text="Convert it to MP4 or WebM, or keep it as a file."
      >
        {onAttachAsFile && (
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onAttachAsFile}>
            Attach as a file
          </button>
        )}
        {onChooseAnother && (
          <button type="button" className="st-btn st-btn-sm" onClick={onChooseAnother}>
            Choose another
          </button>
        )}
        {!onAttachAsFile && (
          <a className="st-btn st-btn-sm" href={downloadHref(src)} download>
            Download
          </a>
        )}
      </VideoState>
    );
  }
  if (failed) {
    return (
      <VideoState icon="warn" title="This video could not be played" text="The file may be missing or damaged.">
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
        <a className="st-btn st-btn-sm" href={downloadHref(src)} download>
          Download
        </a>
        {onReplace && (
          <button type="button" className="st-btn st-btn-sm" onClick={onReplace}>
            Replace
          </button>
        )}
      </VideoState>
    );
  }
  if (!playing) {
    return (
      <div
        className="dk-vid-frame"
        style={poster ? ({ backgroundImage: `url("${poster}")` } as CSSProperties) : undefined}
        data-testid="video-poster"
      >
        <PlayButton label={`Play ${title || 'video'}`} onClick={() => setPlaying(true)} />
      </div>
    );
  }
  return (
    <video
      key={attempt}
      ref={ref}
      className="dk-vid"
      src={src}
      poster={poster || undefined}
      controls
      preload="metadata"
      playsInline
      loop={!!loop}
      muted={!!muted}
      onError={() => setFailed(true)}
    />
  );
}

/** The board's colour of each site's mark (frame 61). */
const MARK: Record<string, string> = { youtube: '#D93025', vimeo: '#0B6F96', loom: '#625DF5' };

/**
 * The square mark of a site: its first letter on its colour.
 * @param props.size - Width and height in px (20 in a footer, 30 in a menu).
 */
export function ProviderMark({ provider, name, size }: { provider?: string; name: string; size: number }) {
  return (
    <span
      className="dk-vid-mark"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size >= 30 ? 15 : size >= 26 ? 13 : 10,
        background: (provider && MARK[provider]) || '#5B6B60',
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Props of {@link ProviderPlayer}. */
export interface ProviderPlayerProps {
  embed: VideoEmbed;
  poster?: string;
  title?: string;
  /** "youtube.com · 6:12" at the end of the footer. */
  site?: string;
}

/**
 * A YouTube, Vimeo or Loom video (frame 60): a card with a picture until Play, then the site's player in a 16:9
 * frame, and a footer with the site's mark, the title and the site. Nothing is loaded from the site before Play.
 */
export function ProviderPlayer({ embed, poster, title, site }: ProviderPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const name = providerName(embed.provider);
  const color = MARK[embed.provider] || '#1E2A22';
  return (
    <div className="dk-vid-pcard">
      {playing ? (
        <div className="dk-vid-ratio">
          <iframe
            className="dk-vid-iframe"
            src={`${embed.embedUrl}?autoplay=1`}
            title={title || `${name} video`}
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            data-testid="video-player-frame"
          />
        </div>
      ) : (
        <div
          className="dk-vid-frame dk-vid-frame-site"
          style={poster ? ({ backgroundImage: `url("${poster}")` } as CSSProperties) : undefined}
          data-testid="video-poster"
        >
          <button
            type="button"
            className="dk-vid-play-site"
            style={{ background: color }}
            aria-label={`Play ${title || `${name} video`}`}
            onClick={() => setPlaying(true)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="#fff"
              stroke="#fff"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M7 5L19 12L7 19Z" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
      <div className="dk-vid-pfoot">
        <ProviderMark provider={embed.provider} name={name} size={20} />
        {title && <span className="dk-vid-ptitle">{title}</span>}
        <span className="dk-vid-psite">{site || name}</span>
      </div>
    </div>
  );
}

/** The caption under a video: its title and description. */
export function VideoCaption({ title, description }: { title?: string; description?: string }) {
  if (!title && !description) return null;
  return (
    <figcaption>
      {title && <strong>{title}</strong>}
      {description && <span>{description}</span>}
    </figcaption>
  );
}
