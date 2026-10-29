import { Gunzip, gunzipSync, unzipSync } from 'fflate';

/** Most entries listed; the rest are counted but not shown. */
export const ENTRY_LIMIT = 2000;
/** Largest single entry that can be opened inside the viewer (declared and real). */
export const ENTRY_PREVIEW_LIMIT = 5 * 1024 * 1024;
/** A gzip that unpacks to more than this is not read, so a zip bomb cannot hang the page. */
const GUNZIP_LIMIT = 64 * 1024 * 1024;

/** One file or folder in an archive. */
export interface ArchiveEntry {
  path: string;
  dir: boolean;
  size: number;
  modified: Date | null;
}

/** What an archive holds, without unpacking anything to disk. */
export interface Listing {
  format: 'zip' | 'tar' | 'gz';
  entries: ArchiveEntry[];
  /** Entries in the archive, including the ones past the limit. */
  totalEntries: number;
  /** Sum of the declared sizes of all entries. */
  unpackedBytes: number;
  /** Read one entry's bytes. Refuses entries over the preview limit. */
  read: (path: string) => Uint8Array | null;
}

/** Thrown when the archive cannot be read. */
export class ArchiveError extends Error {
  reason: 'damaged' | 'too-large' | 'protected';
  constructor(reason: 'damaged' | 'too-large' | 'protected') {
    super(reason);
    this.reason = reason;
  }
}

function readString(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  while (end < start + len && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(start, end));
}

function readOctal(buf: Uint8Array, start: number, len: number): number {
  const s = readString(buf, start, len).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

function listTar(buf: Uint8Array): Listing {
  const entries: ArchiveEntry[] = [];
  const offsets = new Map<string, { at: number; size: number }>();
  let total = 0;
  let unpacked = 0;
  let pos = 0;
  let longName: string | null = null;
  while (pos + 512 <= buf.length) {
    if (buf.subarray(pos, pos + 512).every((b) => b === 0)) break;
    let name = readString(buf, pos, 100);
    const prefix = readString(buf, pos + 345, 155);
    if (prefix && readString(buf, pos + 257, 5) === 'ustar') name = `${prefix}/${name}`;
    const size = readOctal(buf, pos + 124, 12);
    const type = String.fromCharCode(buf[pos + 156] || 48);
    const mtime = readOctal(buf, pos + 136, 12);
    const dataAt = pos + 512;
    pos = dataAt + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = readString(buf, dataAt, size);
      continue;
    }
    if (type === 'x' || type === 'g') continue;
    if (longName) {
      name = longName;
      longName = null;
    }
    const dir = type === '5' || name.endsWith('/');
    if (!dir && type !== '0' && type !== '\0') continue;
    total++;
    unpacked += size;
    if (entries.length < ENTRY_LIMIT) {
      const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
      if (!clean) continue;
      entries.push({ path: clean, dir, size, modified: mtime ? new Date(mtime * 1000) : null });
      if (!dir) offsets.set(clean, { at: dataAt, size });
    }
  }
  return {
    format: 'tar',
    entries,
    totalEntries: total,
    unpackedBytes: unpacked,
    read: (path) => {
      const o = offsets.get(path);
      return o && o.size <= ENTRY_PREVIEW_LIMIT ? buf.slice(o.at, o.at + o.size) : null;
    },
  };
}

function listZip(bytes: Uint8Array): Listing {
  const entries: ArchiveEntry[] = [];
  let total = 0;
  let unpacked = 0;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        total++;
        unpacked += f.originalSize;
        if (entries.length < ENTRY_LIMIT) {
          const dir = f.name.endsWith('/');
          entries.push({ path: f.name.replace(/\/$/, ''), dir, size: f.originalSize, modified: null });
        }
        return false;
      },
    });
  } catch {
    throw new ArchiveError('damaged');
  }
  return {
    format: 'zip',
    entries,
    totalEntries: total,
    unpackedBytes: unpacked,
    read: (path) => {
      let found: Uint8Array | null = null;
      try {
        const out = unzipSync(bytes, {
          filter: (f) =>
            f.name.replace(/\/$/, '') === path &&
            f.originalSize <= ENTRY_PREVIEW_LIMIT &&
            f.size <= ENTRY_PREVIEW_LIMIT,
        });
        found = out[path] ?? null;
      } catch {
        found = null;
      }
      return found;
    },
  };
}

function gunzipCapped(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let tooLarge = false;
  const gz = new Gunzip((chunk) => {
    size += chunk.length;
    if (size > GUNZIP_LIMIT) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  try {
    const step = 256 * 1024;
    for (let i = 0; i < bytes.length && !tooLarge; i += step)
      gz.push(bytes.subarray(i, i + step), i + step >= bytes.length);
  } catch {
    throw new ArchiveError('damaged');
  }
  if (tooLarge) throw new ArchiveError('too-large');
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * List a zip, tar, gz or tgz file. Nothing is run and nothing is written to disk; the listing is capped.
 * @param bytes - The archive.
 * @param name - File name, used to name the single file inside a plain .gz.
 */
export function listArchive(bytes: Uint8Array, name: string): Listing {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return listZip(bytes);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const inner = gunzipCapped(bytes);
    if (readString(inner, 257, 5) === 'ustar') {
      const t = listTar(inner);
      return { ...t, format: 'gz' };
    }
    const single = name.replace(/\.gz$/i, '') || 'file';
    return {
      format: 'gz',
      entries: [{ path: single, dir: false, size: inner.length, modified: null }],
      totalEntries: 1,
      unpackedBytes: inner.length,
      read: (path) => (path === single && inner.length <= ENTRY_PREVIEW_LIMIT ? inner : null),
    };
  }
  if (readString(bytes, 257, 5) === 'ustar') return listTar(bytes);
  throw new ArchiveError('damaged');
}

/** Re-export so callers can unpack small gzip files that are not archives. */
export { gunzipSync };
