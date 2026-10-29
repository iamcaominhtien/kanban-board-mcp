/** One file the viewer can show. Any place that shows a file builds these and says "open this". */
export interface PreviewItem {
  /** Stable key inside one gallery. */
  id: string;
  /** Display name, with the extension that decides how the file opens. */
  name: string;
  /** URL the viewer reads the bytes from (images, media, text, tables, PDF, archives). */
  src: string;
  /** URL that downloads the file. Defaults to `src`. */
  downloadUrl?: string;
  /** Size in bytes, when known. */
  size?: number;
  /** Alt text for an image; defaults to the name. */
  alt?: string;
  /** Who added it and when, for the header. */
  uploadedBy?: string;
  uploadedAt?: string;
  /** Where the file is used (shown in the details panel). */
  usedIn?: string[];
  /** Local path on disk (desktop app), when already known. */
  localPath?: string;
  /** Upload path (`/uploads/...`), used to ask the server for the local path. */
  uploadPath?: string;
}

/** How a file opens. */
export type PreviewKind =
  | 'image'
  | 'text'
  | 'code'
  | 'json'
  | 'markdown'
  | 'html'
  | 'table'
  | 'pdf'
  | 'archive'
  | 'media'
  | 'word'
  | 'powerpoint'
  | 'none';
