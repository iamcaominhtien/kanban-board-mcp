/**
 * Video in a page (design "Embeds", section B and frame 60): a poster (or the file's first frame) with Play and the
 * player's bar; nothing plays, and no player of another site loads, until Play is pressed. A file then plays in the
 * browser's own player (44 px controls on touch); a YouTube, Vimeo or Loom video loads its player (YouTube through
 * youtube-nocookie.com) only after Play.
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

/** What the browser learnt of a video file once its metadata loaded. */
export interface VideoMeta {
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
}

/** "2:14", "1:02:05". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Props of {@link VideoPlayer}. */
export interface VideoPlayerProps {
  src: string;
  poster?: string;
  /** Names the Play button ("Play Sprint demo"). */
  title?: string;
  loop?: boolean;
  muted?: boolean;
  /** Read by screen readers (the block's description). */
  description?: string;
  /** Editor: Replace in the failed state. */
  onReplace?: () => void;
  /** Editor: the unsupported state's "Attach as a file". */
  onAttachAsFile?: () => void;
  /** Editor: the unsupported state's "Choose another". */
  onChooseAnother?: () => void;
  /** Called once the file's length and size are known (the properties panel shows them). */
  onMeta?: (meta: VideoMeta) => void;
}

/**
 * A video file (frames 12 and 19): its poster, or else its first frame, with Play and the player's bar (time and
 * length, volume, speed, full screen) over it. The file's metadata loads so the length and the first frame show and
 * a missing file says so at once, but nothing plays until Play is pressed: never `autoplay`, and the browser's own
 * controls take over only then.
 */
export function VideoPlayer({
  src,
  poster,
  title,
  loop,
  muted,
  description,
  onReplace,
  onAttachAsFile,
  onChooseAnother,
  onMeta,
}: VideoPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
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
  const play = () => setPlaying(true);
  const fullScreen = () => {
    play();
    const v = ref.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    try {
      void v?.requestFullscreen?.()?.catch?.(() => undefined);
    } catch {
      /* the player's own button is there */
    }
  };
  return (
    <div
      className={`dk-vid-frame dk-vid-file${playing ? ' dk-vid-playing' : ''}`}
      data-testid={playing ? 'video-playing' : 'video-poster'}
    >
      <video
        key={attempt}
        ref={ref}
        className="dk-vid"
        // without a poster the first frame stands in for it (a media fragment just past the start)
        src={poster || playing ? src : `${src}#t=0.1`}
        poster={poster || undefined}
        controls={playing}
        preload="metadata"
        playsInline
        loop={!!loop}
        muted={!!muted}
        aria-label={title || 'Video'}
        aria-description={description || undefined}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDuration(v.duration);
          onMeta?.({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
        }}
        onError={() => setFailed(true)}
      />
      {!playing && (
        <>
          <span className="dk-vid-shade" aria-hidden="true" />
          <PlayButton label={`Play ${title || 'video'}`} onClick={play} />
          <div className="dk-vid-bar">
            <button type="button" className="dk-vid-bar-btn" aria-label="Play" tabIndex={-1} onClick={play}>
              <EmbIcon name="play" size={14} />
            </button>
            <span className="dk-vid-time">0:00 / {duration != null ? formatDuration(duration) : '–:––'}</span>
            <span className="dk-vid-track" aria-hidden="true" />
            <span className="dk-vid-bar-flex" />
            <span className="dk-vid-bar-btn" aria-hidden="true">
              <EmbIcon name={muted ? 'mute' : 'volume'} size={15} />
            </span>
            <span className="dk-vid-speed" aria-hidden="true">
              1x
            </span>
            <button
              type="button"
              className="dk-vid-bar-btn"
              aria-label="Full screen"
              tabIndex={-1}
              onClick={fullScreen}
            >
              <EmbIcon name="fullscreen" size={14} />
            </button>
          </div>
        </>
      )}
    </div>
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

/**
 * The caption under a video (frame 12: one italic line). The description is for screen readers only ("Read by
 * screen readers", frame 15), so it is in the caption but not shown.
 */
export function VideoCaption({ title, description }: { title?: string; description?: string }) {
  if (!title && !description) return null;
  return (
    <figcaption>
      {title && <span className="dk-vid-cap">{title}</span>}
      {description && <span className="dk-sr-only">{description}</span>}
    </figcaption>
  );
}
