// Pure rules of the pictures and files a person attaches to a message of the sketch AI chat. The server checks the same
// things again from the bytes (`services/ai/assist/attachments.py`); these checks only save a round trip and say why.

/** Pictures per message. */
export const MAX_IMAGES = 4;
/** Text files per message. */
export const MAX_TEXT_FILES = 4;
/** One picture, in bytes (after it was scaled down). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** One text file, in bytes. */
export const MAX_TEXT_BYTES = 200 * 1024;
/** A picture larger than this on its longest side is scaled down before it is sent. */
export const SEND_SIDE = 1600;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown csv tsv json jsonl log xml yaml yml toml ini cfg conf env html htm css scss svg js mjs jsx ts tsx py rb ' +
    'go rs java kt swift c h cpp hpp cs php sh bash ps1 bat sql graphql diff patch tex rst'
  ).split(' '),
);

/** The sentence every refusal ends with. */
export const ACCEPTED =
  'Pictures (PNG, JPEG, WebP or GIF, 5 MB at most) and text files (txt, md, csv, json, log or source code, 200 KB at most) can be attached.';

/** What a file is, as far as the browser can tell. */
export interface FileFacts {
  name: string;
  type: string;
  size: number;
}

/** The verdict on one file. */
export type Verdict = { kind: 'image' | 'text'; needsScaling?: boolean } | { kind: 'refused'; message: string };

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether a file can be attached, and as what.
 * @param f - Its name, the type the browser reports and its size.
 */
export function classifyFile(f: FileFacts): Verdict {
  const name = f.name || 'file';
  if (f.size <= 0) return { kind: 'refused', message: `“${name}” is empty.` };
  if (IMAGE_TYPES.includes(f.type.toLowerCase())) {
    return { kind: 'image', needsScaling: f.size > MAX_IMAGE_BYTES / 2 };
  }
  if (TEXT_EXTENSIONS.has(extensionOf(name)) && !f.type.startsWith('image/') && !f.type.startsWith('video/')) {
    if (f.size > MAX_TEXT_BYTES) {
      return {
        kind: 'refused',
        message: `“${name}” is ${Math.ceil(f.size / 1024)} KB. A text file can be 200 KB at most.`,
      };
    }
    return { kind: 'text' };
  }
  const word =
    f.type === 'application/pdf' || extensionOf(name) === 'pdf'
      ? 'a PDF'
      : /\.(docx?|xlsx?|pptx?)$/i.test(name)
        ? 'an office file'
        : /\.(zip|gz|tar|rar|7z)$/i.test(name)
          ? 'an archive'
          : null;
  const first = word ? `“${name}” is ${word}, which cannot be read here.` : `“${name}” cannot be read here.`;
  return { kind: 'refused', message: `${first} ${ACCEPTED}` };
}

/** What is already waiting in the message, by kind. */
export interface Waiting {
  images: number;
  texts: number;
}

/**
 * Sort new files into those that can join the message and the reasons for the others.
 * @param waiting - How many pictures and text files the message already has.
 * @param files - The new files.
 * @returns The files that fit, with their kind, and one plain sentence per refused file.
 */
export function admit<T extends FileFacts>(
  waiting: Waiting,
  files: readonly T[],
): { accepted: { file: T; kind: 'image' | 'text'; needsScaling: boolean }[]; refused: string[] } {
  const accepted: { file: T; kind: 'image' | 'text'; needsScaling: boolean }[] = [];
  const refused: string[] = [];
  let images = waiting.images;
  let texts = waiting.texts;
  for (const file of files) {
    const v = classifyFile(file);
    if (v.kind === 'refused') {
      refused.push(v.message);
    } else if (v.kind === 'image') {
      if (images >= MAX_IMAGES) refused.push(`At most ${MAX_IMAGES} pictures can be attached to one message.`);
      else {
        images++;
        accepted.push({ file, kind: 'image', needsScaling: !!v.needsScaling });
      }
    } else if (texts >= MAX_TEXT_FILES) {
      refused.push(`At most ${MAX_TEXT_FILES} text files can be attached to one message.`);
    } else {
      texts++;
      accepted.push({ file, kind: 'text', needsScaling: false });
    }
  }
  return { accepted, refused };
}

/**
 * Whether a picture, after scaling, can still be sent.
 * @param name - Its name, for the message.
 * @param bytes - Its size.
 * @returns A sentence when it is too large; null when it is fine.
 */
export function tooLarge(name: string, bytes: number): string | null {
  return bytes > MAX_IMAGE_BYTES
    ? `“${name}” is ${megabytes(bytes)}. A picture can be ${megabytes(MAX_IMAGE_BYTES)} at most.`
    : null;
}

/**
 * The size a picture is sent at: scaled down to fit `maxSide` on its longest side, never up.
 * @param w - Width.
 * @param h - Height.
 * @param maxSide - Longest side allowed.
 */
export function scaledSize(
  w: number,
  h: number,
  maxSide = SEND_SIDE,
): { width: number; height: number; scaled: boolean } {
  const k = Math.min(1, maxSide / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: k < 1 };
}

/**
 * Where a picture goes on the drawing: centred, as large as it can be without leaving the canvas, never enlarged.
 * @param w - Picture width.
 * @param h - Picture height.
 * @param cw - Canvas width.
 * @param ch - Canvas height.
 */
export function fitInside(
  w: number,
  h: number,
  cw: number,
  ch: number,
): { x: number; y: number; w: number; h: number } {
  const k = Math.min(1, cw / Math.max(w, 1), ch / Math.max(h, 1));
  const fw = Math.max(1, Math.round(w * k));
  const fh = Math.max(1, Math.round(h * k));
  return { x: Math.round((cw - fw) / 2), y: Math.round((ch - fh) / 2), w: fw, h: fh };
}

const SEP = '~';

/**
 * A new key for the chat of a sketch that is not saved yet (kept in its draft).
 * @param random - A source of numbers in [0, 1); `Math.random` by default.
 */
export function newChatKey(random: () => number = Math.random): string {
  let key = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) key += chars[Math.floor(random() * chars.length)];
  return key;
}

/**
 * The scope id the AI chat of a sketch is kept under: the sketch id once it has one, else a draft scope id made of the
 * browser's key and the place the sketch is in (the server moves the chat to the real id when the sketch is first saved).
 * @param s - The sketch id, the draft key and the owner.
 */
export function chatScopeId(s: {
  sketchId?: string;
  chatKey: string;
  ownerKind: string;
  ownerId: string;
  projectId?: string;
}): string {
  if (s.sketchId) return s.sketchId;
  return ['new', s.chatKey, s.ownerKind, s.ownerId, s.projectId || '-'].join(SEP);
}
