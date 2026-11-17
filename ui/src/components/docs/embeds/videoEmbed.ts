/**
 * Video addresses: the player of a YouTube, Vimeo or Loom link (the same rules as the server's link preview;
 * YouTube through youtube-nocookie.com) and whether a browser can play a video file.
 */

/** A video site's player for a link. */
export interface VideoEmbed {
  provider: 'youtube' | 'vimeo' | 'loom';
  /** The player's address, without autoplay. */
  embedUrl: string;
  /** The video id on its site. */
  id: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The player of a video link, or null when the link is not a YouTube, Vimeo or Loom video.
 * @param url - The link as written.
 */
export function videoEmbedOf(url: string): VideoEmbed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const yt = (id: string | null | undefined) =>
    id && ID.test(id)
      ? { provider: 'youtube' as const, id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` }
      : null;
  switch (host) {
    case 'youtube.com':
    case 'm.youtube.com':
    case 'music.youtube.com':
    case 'youtube-nocookie.com':
      if (seg[0] === 'watch') return yt(u.searchParams.get('v'));
      if (['shorts', 'embed', 'live', 'v'].includes(seg[0] ?? '')) return yt(seg[1]);
      return null;
    case 'youtu.be':
      return yt(seg[0]);
    case 'vimeo.com':
    case 'player.vimeo.com': {
      const id = seg.find((s) => /^\d+$/.test(s));
      return id ? { provider: 'vimeo', id, embedUrl: `https://player.vimeo.com/video/${id}` } : null;
    }
    case 'loom.com':
      return (seg[0] === 'share' || seg[0] === 'embed') && seg[1] && ID.test(seg[1])
        ? { provider: 'loom', id: seg[1], embedUrl: `https://www.loom.com/embed/${seg[1]}` }
        : null;
    default:
      return null;
  }
}

/** The name of a video site as the page shows it. */
export function providerName(provider: string): string {
  return provider === 'youtube' ? 'YouTube' : provider === 'vimeo' ? 'Vimeo' : provider === 'loom' ? 'Loom' : provider;
}

/** The poster of a YouTube video, from its id. */
export function youtubePoster(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** The video types the design accepts (MP4, WebM, MOV). */
export const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v';

const PLAYABLE = ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg'];

/** The file name at the end of an address ("demo.mp4"). */
export function fileNameOf(src: string): string {
  const path = src.split(/[?#]/)[0];
  const last = path.split('/').filter(Boolean).pop() ?? src;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Whether a browser can play the video at `src`: by its extension (an address without one is tried).
 * @param src - The video's address or file name.
 */
export function playableInBrowser(src: string): boolean {
  const name = fileNameOf(src).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true;
  return PLAYABLE.includes(name.slice(dot + 1));
}
