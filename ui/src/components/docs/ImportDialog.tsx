import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './docs.css';
import { Icon } from './Icon';
import { useToast } from '../Toast';
import { importDryRun, importFiles, importResolve } from '../../api/docsFx';
import { docsErrorDetail } from '../../api/docs';
import type { DocsTreeNode } from '../../types/docs';
import type { DocsImportConflict, DocsImportDryFile, DocsImportDryRun, DocsImportEntry } from '../../types/docsFx';

export const IMPORT_MAX_FILES = 200;
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

const isMd = (name: string) => /\.(md|markdown)$/i.test(name);

// ─── collecting files (inputs and drag-and-drop, recursive) ───────────────────

function stripSharedRoot(entries: DocsImportEntry[]): DocsImportEntry[] {
  if (entries.length === 0) return entries;
  const first = entries[0].path.split('/')[0];
  if (entries.every((e) => e.path.includes('/') && e.path.split('/')[0] === first)) {
    return entries.map((e) => ({ ...e, path: e.path.slice(first.length + 1) }));
  }
  return entries;
}

/** Entries from an `<input type=file>` (webkitRelativePath is set for folder picks). */
export function entriesFromFileList(files: FileList | File[], fromFolder = false): DocsImportEntry[] {
  const list = Array.from(files).filter((f) => isMd(f.name));
  const entries = list.map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }));
  return fromFolder ? stripSharedRoot(entries) : entries;
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next(); // readEntries returns at most ~100 per call: loop until it comes back empty
        }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, out: DocsImportEntry[]): Promise<void> {
  if (entry.isFile) {
    if (!isMd(entry.name)) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\/+/, '') });
  } else if (entry.isDirectory) {
    const kids = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const k of kids) await walk(k, out);
  }
}

/** Entries (with relative paths) from a drop; walks folders recursively. */
export async function entriesFromDataTransfer(dt: DataTransfer): Promise<DocsImportEntry[]> {
  // the DataTransfer is only valid synchronously: grab the entries first
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const fsEntries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const out: DocsImportEntry[] = [];
  if (fsEntries.some(Boolean)) {
    const dirs = fsEntries.filter((e): e is FileSystemEntry => !!e && e.isDirectory);
    const files = fsEntries.filter((e): e is FileSystemEntry => !!e && e.isFile);
    for (const e of files) await walk(e, out);
    const folderOut: DocsImportEntry[] = [];
    for (const d of dirs) {
      const part: DocsImportEntry[] = [];
      await walk(d, part);
      // a single dropped folder: its own name is not a page (the folder's children become the tree)
      folderOut.push(...(dirs.length === 1 && files.length === 0 ? stripSharedRoot(part) : part));
    }
    out.push(...folderOut);
  } else {
    out.push(...entriesFromFileList(Array.from(dt.files)));
  }
  return out;
}

/**
 * Window-level drag and drop of .md files or folders. `enabled` should be false while an ImportDialog is open
 * (the dialog has its own drop handling). Render `<DocsDropOverlay {...state} />` to show the "Drop to add N files" zone.
 */
export function useDocsFileDrop({ enabled, onFiles }: { enabled: boolean; onFiles: (entries: DocsImportEntry[]) => void }) {
  const [state, setState] = useState<{ dragging: boolean; names: string[]; count: number }>({ dragging: false, names: [], count: 0 });
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const namesOf = (e: DragEvent) => {
      const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file');
      return { count: items.length, names: [] as string[] };
    };
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      e.preventDefault();
      const n = namesOf(e);
      setState({ dragging: true, names: n.names, count: n.count });
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setState({ dragging: false, names: [], count: 0 });
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setState({ dragging: false, names: [], count: 0 });
      if (!e.dataTransfer) return;
      const entries = await entriesFromDataTransfer(e.dataTransfer);
      if (entries.length) cb.current(entries);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return state;
}

/** The "Drop to add N files" zone (Empty C6) shown while files are dragged over the page or dialog. */
export function DocsDropOverlay({ dragging, count, names }: { dragging: boolean; count: number; names: string[] }) {
  if (!dragging) return null;
  return (
    <div className="docs-root" style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(37,61,44,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{ width: 390, boxSizing: 'border-box', border: '1px solid #E3E8E5', borderRadius: 12, background: '#FFFFFF', padding: 16, boxShadow: '0 10px 28px rgba(30,42,34,0.08)' }}>
        <div style={{ width: '100%', height: 178, borderRadius: 12, border: '2px dashed #2E6F40', background: '#F1F8F3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, boxSizing: 'border-box' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#DCEEE1', color: '#2E6F40', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="i26" size={22} strokeWidth={1.9} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>{count > 0 ? `Drop to add ${count} ${count === 1 ? 'file' : 'files'}` : 'Drop to import'}</div>
          {names.length > 0 && <div style={{ fontSize: 12, color: '#2E6F40' }}>{names.slice(0, 3).join(', ')}</div>}
        </div>
      </div>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function treeOrder(entries: DocsImportEntry[]): DocsImportEntry[] {
  // parents/folders first: shallower paths first, then folder index pages before their siblings
  const isIndex = (p: string) => /(^|\/)(index|readme)\.(md|markdown)$/i.test(p);
  return [...entries].sort((a, b) => {
    const da = a.path.split('/').length;
    const db = b.path.split('/').length;
    if (da !== db) return da - db;
    if (isIndex(a.path) !== isIndex(b.path)) return isIndex(a.path) ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

type RowState = 'waiting' | 'importing' | 'done' | 'failed';

interface RunHandle {
  cancel: () => void;
}

// ─── component ────────────────────────────────────────────────────────────────

export interface ImportDialogProps {
  projectId: string;
  projectName: string;
  nodes: DocsTreeNode[];
  initialFiles?: File[];
  /** Entries with relative paths (from `useDocsFileDrop` / folder drops). */
  initialEntries?: DocsImportEntry[];
  /** Page to place the imported pages under (default: top level). */
  initialParentId?: string | null;
  onClose: () => void;
  /** Called with the created page ids when the import has finished (also after the dialog was closed). */
  onDone: (created: string[]) => void;
  /** Shows the "Review links" action on the result toast when pages with unresolved links were created. */
  onReviewLinks?: (pageId: string) => void;
}

export function ImportDialog({ projectId, projectName, nodes, initialFiles, initialEntries, initialParentId = null, onClose, onDone, onReviewLinks }: ImportDialogProps) {
  const toast = useToast();
  const [entries, setEntries] = useState<DocsImportEntry[]>(() => initialEntries ?? entriesFromFileList(initialFiles ?? []));
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [conflict, setConflict] = useState<DocsImportConflict>('copy');
  const [dry, setDry] = useState<DocsImportDryRun | null>(null);
  const [dryError, setDryError] = useState<string | null>(null);
  const [dryLoading, setDryLoading] = useState(false);
  const [phase, setPhase] = useState<'review' | 'importing'>('review');
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);
  const run = useRef<RunHandle | null>(null);
  const mounted = useRef(true);
  const filesInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const addEntries = useCallback((more: DocsImportEntry[]) => {
    setEntries((cur) => {
      const byPath = new Map(cur.map((e) => [e.path, e]));
      more.forEach((e) => byPath.set(e.path, e));
      return Array.from(byPath.values());
    });
  }, []);

  // drops while the dialog is open add to this import
  const drag = useDocsFileDrop({ enabled: phase === 'review', onFiles: addEntries });

  const tooMany = entries.length > IMPORT_MAX_FILES;
  const oversize = useMemo(() => new Set(entries.filter((e) => e.file.size > IMPORT_MAX_BYTES).map((e) => e.path)), [entries]);
  const sendable = useMemo(() => treeOrder(entries.filter((e) => !oversize.has(e.path)).slice(0, IMPORT_MAX_FILES)), [entries, oversize]);
  const totalBytes = entries.reduce((n, e) => n + e.file.size, 0);

  // dry run whenever the file set or the options change
  useEffect(() => {
    if (!sendable.length) {
      setDry(null);
      return;
    }
    const id = ++seq.current;
    setDryLoading(true);
    setDryError(null);
    importDryRun(projectId, sendable, parentId, conflict)
      .then((r) => {
        if (id === seq.current) setDry(r);
      })
      .catch((err) => {
        if (id !== seq.current) return;
        const d = docsErrorDetail(err);
        setDry(null);
        setDryError(d?.message ?? (err as Error)?.message ?? 'Could not read the files');
      })
      .finally(() => {
        if (id === seq.current) setDryLoading(false);
      });
  }, [sendable, projectId, parentId, conflict]);

  const rows: DocsImportDryFile[] = useMemo(() => {
    const byPath = new Map((dry?.files ?? []).map((f) => [f.path, f]));
    return treeOrder(entries).map((e) => {
      if (oversize.has(e.path)) {
        return { path: e.path, pagePath: null, title: null, status: 'error', linksResolved: 0, linksUnresolved: [], message: 'File is larger than 2 MB' } satisfies DocsImportDryFile;
      }
      return (
        byPath.get(e.path) ?? ({ path: e.path, pagePath: null, title: null, status: 'ok', linksResolved: 0, linksUnresolved: [], message: null } satisfies DocsImportDryFile)
      );
    });
  }, [entries, dry, oversize]);

  const importable = rows.filter((r) => r.status !== 'error');
  const nImport = dry ? dry.pages : importable.length;

  // ── the import itself: one request per file in tree order; independent of the dialog's lifetime ──
  const start = (items: DocsImportEntry[], dryFiles: DocsImportDryFile[], priorCreated: string[] = [], priorTotal = 0) => {
    let cancelled = false;
    const handle: RunHandle = { cancel: () => (cancelled = true) };
    run.current = handle;
    setPhase('importing');
    setStopping(false);
    const total = priorTotal || items.length;
    const created: string[] = [...priorCreated];
    const createdByPath: Record<string, string> = {};
    const failedList: { path: string; message: string }[] = [];
    const remaining: DocsImportEntry[] = [];
    let skipped = 0;
    const set = (path: string, s: RowState) => mounted.current && setRowState((r) => ({ ...r, [path]: s }));

    (async () => {
      let serverDown: string | null = null;
      for (let i = 0; i < items.length; i++) {
        if (cancelled || serverDown) {
          remaining.push(...items.slice(i));
          break;
        }
        const e = items[i];
        set(e.path, 'importing');
        try {
          const res = await importFiles(projectId, [e], parentId, conflict);
          res.created.forEach((c) => {
            created.push(c.pageId);
            createdByPath[c.path] = c.pageId;
          });
          if (res.failed.length) {
            failedList.push(...res.failed);
            set(e.path, 'failed');
          } else if (res.created.length === 0) {
            skipped += 1;
            set(e.path, 'done');
          } else {
            set(e.path, 'done');
          }
        } catch (err) {
          serverDown = docsErrorDetail(err)?.message ?? 'The server stopped responding';
          set(e.path, 'failed');
          remaining.push(e);
          remaining.push(...items.slice(i + 1));
          break;
        }
      }
      // links are resolved after the last page is saved
      if (created.length) {
        try {
          await importResolve(projectId, created);
        } catch {
          /* the next publish re-indexes the links anyway */
        }
      }
      const doneCount = created.length - priorCreated.length;
      const t = toastRef.current;
      const unresolvedFile = dryFiles.find((f) => f.linksUnresolved.length > 0 && createdByPath[f.path]);
      if (serverDown) {
        t.error('Import failed', `${serverDown} after ${priorCreated.length + doneCount} of ${total} pages. The ${priorCreated.length + doneCount} imported pages were kept.`, 12000, {
          label: 'Retry rest',
          onClick: () => start(remaining, dryFiles, created, total),
        });
      } else if (failedList.length) {
        t.warning(`Imported ${created.length} of ${total} pages`, `${failedList.length} failed: ${failedList.map((f) => f.path).slice(0, 2).join(', ')}${failedList.length > 2 ? '…' : ''}`, 12000);
      } else if (cancelled && remaining.length) {
        t.info('Import stopped', `${created.length} of ${total} pages were imported and kept.`, 8000, {
          label: 'Retry rest',
          onClick: () => start(remaining, dryFiles, created, total),
        });
      } else {
        const resolved = dryFiles.reduce((n, f) => n + f.linksResolved, 0);
        const unresolved = dryFiles.reduce((n, f) => n + f.linksUnresolved.length, 0);
        const skippedFiles = dryFiles.filter((f) => f.status === 'error').length + skipped;
        t.success(
          `Imported ${created.length} ${created.length === 1 ? 'page' : 'pages'}`,
          `${resolved} links resolved, ${unresolved} unresolved.${skippedFiles ? ` ${skippedFiles} ${skippedFiles === 1 ? 'file was' : 'files were'} skipped.` : ''}`,
          10000,
          unresolved > 0 && onReviewLinks && unresolvedFile ? { label: 'Review links', onClick: () => onReviewLinks(createdByPath[unresolvedFile.path]) } : undefined,
        );
      }
      onDone(created);
      run.current = null;
      if (mounted.current) onClose();
    })();
  };

  const begin = () => {
    if (!dry || nImport === 0) return;
    const okPaths = new Set(dry.files.filter((f) => f.status !== 'error').map((f) => f.path));
    const items = sendable.filter((e) => okPaths.has(e.path));
    setRowState(Object.fromEntries(items.map((e) => [e.path, 'waiting'])));
    start(items, dry.files);
  };

  const cancel = () => {
    if (phase === 'importing') {
      run.current?.cancel();
      setStopping(true);
    } else onClose();
  };

  // Esc closes (the import keeps running once started)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doneN = Object.values(rowState).filter((s) => s === 'done' || s === 'failed').length;
  const totalN = Object.keys(rowState).length;
  const pct = totalN ? Math.floor((doneN / totalN) * 100) : 0;
  const curN = Math.min(totalN, doneN + 1);

  const idle = entries.length === 0;
  const importing = phase === 'importing';

  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>, folder: boolean) => {
    if (e.target.files) {
      const list = entriesFromFileList(e.target.files, folder);
      if (!list.length) setNotice('No .md or .markdown files found in that selection.');
      else (setNotice(null), addEntries(list));
    }
    e.target.value = '';
  };

  const sel = (label: string, icon: string | null, value: string, onChange: (v: string) => void, options: { value: string; label: string }[], disabled: boolean) => (
    <div style={{ position: 'relative' }}>
      <div className="st-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {icon && (
          <span style={{ display: 'flex', color: '#2E6F40' }}>
            <Icon name={icon} size={15} strokeWidth={1.9} />
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{options.find((o) => o.value === value)?.label}</span>
        <Icon name="i06" size={12} strokeWidth={2} style={{ color: '#9AA8A0' }} />
      </div>
      <select aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer' }}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );

  const depthOf = (n: DocsTreeNode) => {
    let d = 0;
    let c: DocsTreeNode | undefined = n;
    while (c?.parentId) {
      d += 1;
      c = nodes.find((x) => x.id === c!.parentId);
    }
    return d;
  };
  const placeOptions = [{ value: '', label: 'Top level' }, ...nodes.map((n) => ({ value: n.id, label: ' '.repeat(depthOf(n)) + n.title }))];
  const placeLabel = parentId ? nodes.find((n) => n.id === parentId)?.title ?? 'Top level' : 'Top level';
  placeOptions.forEach((o) => o.value === (parentId ?? '') && (o.label = o.value ? placeLabel : 'Top level'));

  const resultOf = (r: DocsImportDryFile) => {
    if (r.status === 'error') return { text: r.message ?? 'Could not be read', color: '#A5321E', icon: <Icon name="i22" size={16} strokeWidth={1.9} style={{ color: '#C4432A' }} /> };
    if (r.linksUnresolved.length) {
      return {
        text: (
          <>
            {r.linksResolved} resolved, {r.linksUnresolved.length} unresolved: <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }}>{r.linksUnresolved.map((l) => `[[${l.replace(/^\[\[|\]\]$/g, '')}]]`).join(', ')}</span>
          </>
        ),
        color: '#7A4F08',
        icon: <Icon name="i14" size={16} strokeWidth={1.9} style={{ color: '#B4791E' }} />,
      };
    }
    return {
      text: `${r.linksResolved} ${r.linksResolved === 1 ? 'link' : 'links'} resolved`,
      color: '#5B6B60',
      icon: <Icon name="i17" size={16} strokeWidth={1.9} style={{ color: '#2E6F40' }} />,
    };
  };

  const progressOf = (r: DocsImportDryFile) => {
    if (r.status === 'error') return resultOf(r);
    const s = rowState[r.path] ?? 'waiting';
    if (s === 'done') return { text: 'Imported', color: '#5B6B60', icon: <Icon name="i17" size={16} strokeWidth={1.9} style={{ color: '#2E6F40' }} /> };
    if (s === 'importing') return { text: 'Importing…', color: '#1E2A22', icon: <span className="mc-spin" /> };
    if (s === 'failed') return { text: 'Failed', color: '#A5321E', icon: <Icon name="i22" size={16} strokeWidth={1.9} style={{ color: '#C4432A' }} /> };
    return { text: 'Waiting', color: '#9AA8A0', icon: <Icon name="i20" size={16} strokeWidth={1.9} style={{ color: '#9AA8A0' }} /> };
  };

  const fileRow = (r: DocsImportDryFile, last: boolean) => {
    const res = importing ? progressOf(r) : resultOf(r);
    return (
      <div key={r.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: last ? 'none' : '1px solid #EEF3EF' }}>
        <span style={{ display: 'flex', color: '#9AA8A0' }}>
          <Icon name="i00" size={16} strokeWidth={1.8} />
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, opacity: r.status === 'error' ? 0.6 : 1 }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 500, color: '#1E2A22', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.path}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#9AA8A0' }}>
            <Icon name="i00" size={12} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
            {r.status === 'error' ? 'Not imported' : r.pagePath ? r.pagePath.join(' › ') : dryLoading ? 'Reading…' : r.title ?? ''}
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: res.color, textAlign: 'right', maxWidth: 236, lineHeight: 1.4 }}>{res.text}</div>
        <span style={{ display: 'flex' }}>{res.icon}</span>
      </div>
    );
  };

  const shell = (children: React.ReactNode) => (
    <div
      className="docs-root"
      role="dialog"
      aria-modal="true"
      aria-label="Import Markdown"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(37,61,44,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}
    >
      <div style={{ position: 'relative', width: 612, maxWidth: '100%', maxHeight: '100%', display: 'flex', flexDirection: 'column', borderRadius: 12, border: '1px solid #E3E8E5', boxShadow: '0 24px 64px rgba(30,42,34,0.28)', background: '#FFFFFF', overflow: 'hidden', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 22px', borderBottom: '1px solid #E3E8E5' }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#DCEEE1', color: '#2E6F40', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="i26" size={16} strokeWidth={1.9} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Import Markdown</div>
            <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>
              {projectName}
              {entries.length > 0 && ` · ${entries.length} ${entries.length === 1 ? 'file' : 'files'}, ${fmtSize(totalBytes)}`}
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#9AA8A0' }}>
            <Icon name="i08" size={16} strokeWidth={1.9} />
          </button>
        </div>
        {children}
        <input ref={filesInput} type="file" multiple accept=".md,.markdown" hidden onChange={(e) => pickFiles(e, false)} />
        <input
          ref={(el) => {
            dirInput.current = el;
            if (el) el.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          hidden
          onChange={(e) => pickFiles(e, true)}
        />
      </div>
      {drag.dragging && phase === 'review' && null}
    </div>
  );

  // C5 idle drop zone (and C6 dragging state)
  if (idle) {
    return shell(
      <>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              width: '100%',
              height: 178,
              borderRadius: 12,
              border: drag.dragging ? '2px dashed #2E6F40' : '1.5px dashed #C7D2CB',
              background: drag.dragging ? '#F1F8F3' : '#FBFCFB',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              boxSizing: 'border-box',
            }}
          >
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: drag.dragging ? '#DCEEE1' : '#EEF3EF', color: drag.dragging ? '#2E6F40' : '#5B6B60', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name="i26" size={22} strokeWidth={1.9} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>{drag.dragging ? (drag.count ? `Drop to add ${drag.count} ${drag.count === 1 ? 'file' : 'files'}` : 'Drop to add files') : 'Drag .md files or a folder here'}</div>
            {!drag.dragging && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60' }}>
                or
                <button type="button" className="st-btn st-btn-sm" onClick={() => filesInput.current?.click()}>
                  Choose files…
                </button>
                <button type="button" className="st-btn st-btn-sm" onClick={() => dirInput.current?.click()}>
                  Choose folder…
                </button>
              </div>
            )}
            <div style={{ fontSize: drag.dragging ? 12 : 11.5, color: drag.dragging ? '#2E6F40' : '#9AA8A0' }}>
              {drag.dragging ? '' : `.md and .markdown, up to ${IMPORT_MAX_FILES} files, 2 MB each`}
            </div>
          </div>
          {notice && <div style={{ fontSize: 12, color: '#A5321E' }}>{notice}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 22px', borderTop: '1px solid #E3E8E5', background: '#FBFCFB' }}>
          <span style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45 }}>Imported pages start as drafts for you to review.</span>
          <div style={{ flex: 1 }} />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </>,
    );
  }

  const parsed = dry?.pages ?? 0;
  const skippedN = rows.filter((r) => r.status === 'error').length;
  const unresolvedN = dry?.linksUnresolvedTotal ?? 0;
  return shell(
    <>
      <div className="fx-scroll" style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', minHeight: 0 }}>
        {importing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>
              Importing page {curN} of {totalN}
              <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 500, color: '#5B6B60' }}>{pct}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: '#E3E8E5', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: '#2E6F40', transition: 'width .2s' }} />
            </div>
            <div style={{ fontSize: 12, color: '#5B6B60' }}>Links are resolved after the last page is saved. You can close this window; the import keeps running.</div>
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '11px 14px',
                borderRadius: 10,
                border: drag.dragging ? '1.5px dashed #2E6F40' : '1.5px dashed #C7D2CB',
                background: drag.dragging ? '#F1F8F3' : '#FBFCFB',
              }}
            >
              <span style={{ color: drag.dragging ? '#2E6F40' : '#9AA8A0', display: 'flex' }}>
                <Icon name="i26" size={20} strokeWidth={1.9} />
              </span>
              <span style={{ flex: 1, fontSize: 12.5, color: '#5B6B60' }}>
                <b style={{ color: '#1E2A22', fontWeight: 700 }}>Drop more files or a folder</b> to add them to this import.
              </span>
              <button type="button" className="st-btn st-btn-sm" onClick={() => filesInput.current?.click()}>
                Files…
              </button>
              <button type="button" className="st-btn st-btn-sm" onClick={() => dirInput.current?.click()}>
                Folder…
              </button>
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="st-field-label" style={{ fontSize: 11 }}>Place under</span>
                {sel('Place under', 'i27', parentId ?? '', (v) => setParentId(v || null), placeOptions, false)}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="st-field-label" style={{ fontSize: 11 }}>If a title already exists</span>
                {sel(
                  'If a title already exists',
                  null,
                  conflict,
                  (v) => setConflict(v as DocsImportConflict),
                  [
                    { value: 'copy', label: 'Add as a copy, e.g. “API (2)”' },
                    { value: 'skip', label: 'Skip that file' },
                  ],
                  false,
                )}
              </div>
            </div>
          </>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!importing && (
            <div style={{ display: 'flex', alignItems: 'baseline' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#5B6B60' }}>
                {rows.length} {rows.length === 1 ? 'file' : 'files'} found
              </div>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#9AA8A0' }}>Folder names become the page tree</span>
            </div>
          )}
          <div style={{ border: '1px solid #E3E8E5', borderRadius: 8, overflow: 'hidden' }}>{rows.map((r, i) => fileRow(r, i === rows.length - 1))}</div>
          {tooMany && <div style={{ fontSize: 12, color: '#A5321E' }}>Only the first {IMPORT_MAX_FILES} files are imported; the rest are skipped.</div>}
          {dryError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#A5321E' }}>
              <Icon name="i22" size={14} strokeWidth={1.9} />
              {dryError}
              <button type="button" className="st-btn st-btn-sm" onClick={() => setEntries((e) => [...e])}>
                Try again
              </button>
            </div>
          )}
        </div>
        {!importing && dry && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 8, background: '#F6FAF7', border: '1px solid #E3E8E5', fontSize: 12.5, color: '#3A4A3E' }}>
              <span>
                <b style={{ color: '#1E2A22', fontWeight: 700 }}>{parsed} {parsed === 1 ? 'page' : 'pages'}</b> parsed
              </span>
              <span>
                <b style={{ color: '#1E2A22', fontWeight: 700 }}>{dry.linksResolved}</b> <span className="st-code">[[links]]</span> resolved
              </span>
              {unresolvedN > 0 && (
                <span style={{ color: '#7A4F08' }}>
                  <b style={{ color: '#1E2A22', fontWeight: 700 }}>{unresolvedN}</b> unresolved
                </span>
              )}
              {skippedN + dry.skipped > 0 && (
                <span style={{ color: '#A5321E' }}>
                  <b style={{ color: '#1E2A22', fontWeight: 700 }}>{Math.max(skippedN, dry.skipped)}</b> {Math.max(skippedN, dry.skipped) === 1 ? 'file' : 'files'} skipped
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.5 }}>Unresolved links are kept as written and shown in red until a page with that title exists.</div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 22px', borderTop: '1px solid #E3E8E5', background: '#FBFCFB' }}>
        <span style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45 }}>
          {importing ? 'Cancel stops after the current page. Pages already imported are kept.' : 'Imported pages start as drafts for you to review.'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="st-btn" onClick={cancel} disabled={importing && stopping}>
          {importing && stopping ? 'Stopping…' : 'Cancel'}
        </button>
        {importing ? (
          <button type="button" className="st-btn st-btn-primary" disabled style={{ opacity: 0.7 }}>
            <span className="mc-spin mc-spin-w" />
            Importing…
          </button>
        ) : (
          <button type="button" className="st-btn st-btn-primary" disabled={dryLoading || !dry || nImport === 0} onClick={begin}>
            {dryLoading ? <span className="mc-spin mc-spin-w" /> : <Icon name="i26" size={14} strokeWidth={1.9} />}
            Import {nImport} {nImport === 1 ? 'page' : 'pages'}
          </button>
        )}
      </div>
    </>,
  );
}
