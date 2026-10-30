import { useEffect, useMemo, useState } from 'react';
import { Notice, StatePanel } from './StatePanel';
import { AsyncBody, TextBody } from './TextReader';
import { decodeText, looksLikeText, useFileData } from './useFileData';
import { ENTRY_LIMIT, ENTRY_PREVIEW_LIMIT, ArchiveError, listArchive, type Listing } from './archives';
import { previewKind, languageLabel } from './kinds';
import { formatFileSize } from '../../utils/fileIcons';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

const ARCHIVE_LIMIT = 64 * 1024 * 1024;

function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}

/** The file open inside the archive. */
function Inside({ path, listing }: { path: string; listing: Listing }) {
  const name = path.split('/').pop() ?? path;
  const kind = previewKind(name);
  const bytes = useMemo(() => listing.read(path), [listing, path]);
  const blobUrl = useMemo(
    () =>
      bytes
        ? URL.createObjectURL(new Blob([bytes.slice()], kind === 'image' ? { type: mimeOf(name) } : undefined))
        : null,
    [bytes, kind, name],
  );
  useEffect(() => () => void (blobUrl && URL.revokeObjectURL(blobUrl)), [blobUrl]);

  const download = blobUrl && (
    <a className={styles.btn} href={blobUrl} download={name}>
      Download this file
    </a>
  );
  if (!bytes)
    return (
      <StatePanel tone="warn" title="Too large to open here">
        This file is bigger than {formatFileSize(ENTRY_PREVIEW_LIMIT)} unpacked. Download the archive to see it.
      </StatePanel>
    );
  if (kind === 'image' && blobUrl)
    return (
      <div className={styles.archiveImage}>
        <img src={blobUrl} alt={name} />
        <div className={styles.stateActions}>{download}</div>
      </div>
    );
  if (
    (kind === 'text' || kind === 'code' || kind === 'json' || kind === 'markdown' || kind === 'html') &&
    looksLikeText(bytes)
  ) {
    // HTML inside an archive is shown as source only: it is never rendered
    return (
      <>
        <div className={styles.readerBar}>{download}</div>
        <TextBody
          text={decodeText(bytes)}
          lang={languageLabel(name)}
          label={`${languageLabel(name)} · ${formatFileSize(bytes.length)}`}
        />
      </>
    );
  }
  return (
    <StatePanel tone="warn" title="No preview available" actions={download}>
      This kind of file cannot be shown inside an archive. You can download it.
    </StatePanel>
  );
}

/** Archive reader: browse the files inside and preview one right there. Nothing is unpacked to disk or run. */
export default function ArchiveReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, ARCHIVE_LIMIT);
  const [dir, setDir] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const result = useMemo(() => {
    if (state.status !== 'ready') return null;
    if (state.truncated) return { ok: false as const, error: 'too-large' as const };
    try {
      return { ok: true as const, listing: listArchive(state.bytes, item.name) };
    } catch (err) {
      return { ok: false as const, error: err instanceof ArchiveError ? err.reason : ('damaged' as const) };
    }
  }, [state, item.name]);

  useEffect(() => {
    setDir('');
    setOpen(null);
  }, [item.src]);

  useEffect(() => {
    if (result?.ok) onFacts({ Files: String(result.listing.entries.filter((e) => !e.dir).length) });
  }, [result, onFacts]);

  const rows = useMemo(() => {
    if (!result?.ok) return [];
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map<string, { name: string; dir: boolean; size: number; modified: Date | null; path: string }>();
    for (const e of result.listing.entries) {
      if (!e.path.startsWith(prefix) || e.path === dir) continue;
      const rest = e.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        seen.set(rest, { name: rest, dir: e.dir, size: e.size, modified: e.modified, path: e.path });
      } else {
        const folder = rest.slice(0, slash);
        if (!seen.has(folder))
          seen.set(folder, { name: folder, dir: true, size: 0, modified: null, path: `${prefix}${folder}` });
      }
    }
    return [...seen.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }, [result, dir]);

  function body() {
    if (!result) return null;
    if (!result.ok) {
      const [title, text] =
        result.error === 'too-large'
          ? ['Too large to preview', `${item.name} is too large to open here. Download it to see everything.`]
          : result.error === 'protected'
            ? ['This file needs a password', 'Previews cannot open protected files. Download it and open it in an app.']
            : [
                'Could not make a preview',
                'The file may be damaged or in a format we cannot read. Nothing was changed.',
              ];
      return (
        <StatePanel tone={result.error === 'damaged' ? 'error' : 'warn'} title={title} actions={actions}>
          {text}
        </StatePanel>
      );
    }
    const { listing } = result;
    const files = listing.entries.filter((e) => !e.dir).length;
    const hasDates = listing.entries.some((e) => e.modified);
    const crumbs = dir ? dir.split('/') : [];
    return (
      <div className={styles.archiveReader}>
        <div className={styles.readerBar}>
          <nav className={styles.crumbs} aria-label="Location in archive">
            <button
              type="button"
              onClick={() => {
                setDir('');
                setOpen(null);
              }}
            >
              {item.name}
            </button>
            {crumbs.map((c, i) => (
              <span key={i}>
                ›{' '}
                <button
                  type="button"
                  onClick={() => {
                    setDir(crumbs.slice(0, i + 1).join('/'));
                    setOpen(null);
                  }}
                >
                  {c}
                </button>
              </span>
            ))}
            {open && (
              <span>
                › <strong>{open.split('/').pop()}</strong>
              </span>
            )}
          </nav>
          <span className={styles.readerBarSpacer} />
          <span className={styles.readerLabel}>
            {listing.totalEntries} {listing.totalEntries === 1 ? 'file' : 'files'}
            {item.size ? ` · ${formatFileSize(item.size)}` : ''} ({formatFileSize(listing.unpackedBytes)} unpacked)
          </span>
        </div>
        {listing.totalEntries > ENTRY_LIMIT && (
          <Notice actions={actions}>
            Showing the first {ENTRY_LIMIT.toLocaleString()} of {listing.totalEntries.toLocaleString()} entries.
          </Notice>
        )}
        {open ? (
          <Inside path={open} listing={listing} />
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table} aria-label={`Contents of ${dir || item.name}`}>
              <thead>
                <tr>
                  <th scope="col">NAME</th>
                  <th scope="col">SIZE</th>
                  {hasDates && <th scope="col">MODIFIED</th>}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={hasDates ? 3 : 2}>{files === 0 ? 'This archive is empty.' : 'Nothing here.'}</td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.path}>
                    <td>
                      <button
                        type="button"
                        className={styles.entryBtn}
                        onClick={() => (r.dir ? setDir(r.path) : setOpen(r.path))}
                      >
                        <span aria-hidden="true">{r.dir ? '📁' : '📄'}</span> {r.name}
                      </button>
                    </td>
                    <td>{r.dir ? '' : formatFileSize(r.size)}</td>
                    {hasDates && (
                      <td>
                        {r.modified
                          ? r.modified.toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : ''}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {body()}
    </AsyncBody>
  );
}
