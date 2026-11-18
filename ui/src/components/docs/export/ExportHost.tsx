/**
 * Export in the Docs area (design board "Rich Docs — export"): answers the export requests of the page header, More,
 * the page menu (`docs:open-export`) and the tree's "Export as a book" (`docs:export`) with the export dialog; starts
 * exports, follows them (polling, and the `docs_export` event on /events), downloads the file when it is ready, and
 * keeps the exports that run without the dialog as cards at the bottom left of the Docs area.
 *
 * The bell only lists server notifications, so a finished or failed background export is told by its card (ready
 * goes away by itself after a minute, did not finish stays until acted on), not under Updates or Needs you.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { docsErrorDetail, useDocsPage } from '../../../api/docs';
import { extractError } from '../../../api/extractError';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import { useOnline } from '../../../hooks/useOnline';
import { subscribeSSE } from '../../../hooks/sseEvents';
import type { DocsPage, DocsTreeNode } from '../../../types/docs';
import { useToast } from '../../Toast';
import { OPEN_EXPORT_EVENT, type ExportFormat } from '../docsExport';
import { draftDoc, publishedDoc } from '../richPage';
import { DOCS_EXPORT_EVENT } from '../tree/useTreeActions';
import { BookDialog, newBook, type BookState } from './BookExport';
import {
  cancelExport,
  deleteExport,
  downloadExport,
  exportKeys,
  exportLink,
  fetchExport,
  openExportFile,
  requestOf,
  startExport,
  type ExportRow,
} from './exportApi';
import { ExportFormBody } from './ExportForm';
import { ExportFrame } from './ExportFrame';
import { ExportHistory } from './ExportHistory';
import { ExportCards, JobDialog, TooBigDialog, type ExportJob } from './ExportJob';
import {
  FORMAT_LABEL,
  buildBookBody,
  buildExportBody,
  checkFileName,
  countEmbeds,
  defaultFileName,
  descendantsInOrder,
  extensionFor,
  lastOptions,
  reduceChoices,
  rememberOptions,
  type ExportBody,
  type ExportForm,
  type ReduceChoice,
} from './exportModel';

/** How often a running export is asked about (ms); the `docs_export` event usually answers first. */
export const POLL_MS = 1500;
/** How long the card of a ready background export stays (ms). */
export const READY_CARD_MS = 60_000;

type View =
  | { kind: 'form'; tab: 'new' | 'history' }
  | { kind: 'book' }
  | { kind: 'job'; id: string }
  | { kind: 'tooBig'; size: number; limit: number; from: 'form' | 'book' };

interface OpenState {
  pageId: string | null;
  view: View;
  /** Why the last start was refused (shown in the form); null for none. */
  refused: string | null;
}

const OFFLINE =
  'You are offline. Export needs a connection. Your choices are kept, and the button works again when you are back.';
const EMPTY = 'This page is empty, so there is nothing to export yet. Add something to the page first.';

interface Props {
  projectId: string;
  projectName: string;
  /** The page tree. */
  nodes: readonly DocsTreeNode[];
  /** The person can edit pages (the published or draft choice). */
  canEdit: boolean;
  layout: DocsLayout;
  /** The page on screen, when there is one (saves a fetch). */
  currentPage: DocsPage | null;
}

/**
 * The export dialog, its history, book mode and the background cards of a Docs space.
 * @param props.projectId - The project.
 * @param props.projectName - Its name (the subtitle, the whole-space file name).
 * @param props.nodes - The page tree.
 * @param props.canEdit - Editors choose between the published version and their draft.
 * @param props.layout - Desktop, tablet or phone.
 * @param props.currentPage - The page on screen.
 */
export function ExportHost({ projectId, projectName, nodes, canEdit, layout, currentPage }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const online = useOnline();
  const [open, setOpen] = useState<OpenState | null>(null);
  const [form, setForm] = useState<ExportForm>(() => ({
    format: 'md',
    scope: 'page',
    pageId: null,
    unticked: [],
    draft: false,
    fileName: '',
    nameEdited: false,
    options: lastOptions(),
  }));
  const [book, setBook] = useState<BookState | null>(null);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [busy, setBusy] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const pageId = open?.pageId ?? null;
  const fetched = useDocsPage(pageId && currentPage?.id !== pageId ? pageId : null);
  const page: DocsPage | null = pageId ? (currentPage?.id === pageId ? currentPage : (fetched.data ?? null)) : null;
  const node = nodes.find((n) => n.id === pageId);
  const pageTitle = page?.title ?? node?.title ?? 'Page';
  const children = useMemo(() => (pageId ? descendantsInOrder(nodes, pageId) : []), [nodes, pageId]);

  // ---------- opening ----------
  const openForm = useCallback(
    (id: string | null, format: ExportFormat | null) => {
      const n = id ? nodes.find((x) => x.id === id) : undefined;
      const title = (id && currentPage?.id === id ? currentPage.title : n?.title) ?? 'Page';
      setForm((f) => ({
        format: format ?? f.format,
        scope: id ? 'page' : 'space',
        pageId: id,
        unticked: [],
        draft: canEdit && n?.status === 'draft',
        fileName: defaultFileName(id ? 'page' : 'space', title, projectName),
        nameEdited: false,
        options: lastOptions(),
      }));
      setOpen({ pageId: id, view: { kind: 'form', tab: 'new' }, refused: null });
    },
    [nodes, currentPage, canEdit, projectName],
  );
  const openBook = useCallback(
    (ids: readonly string[], fromId: string | null) => {
      setBook(newBook(ids, nodes, form.format, form.options));
      setOpen({ pageId: fromId, view: { kind: 'book' }, refused: null });
    },
    [nodes, form.format, form.options],
  );
  const handlers = useRef({ openForm, openBook });
  handlers.current = { openForm, openBook };
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ pageId: string; format: ExportFormat | null }>).detail;
      e.preventDefault();
      handlers.current.openForm(d?.pageId ?? null, d?.format ?? null);
    };
    const onBook = (e: Event) => {
      const d = (e as CustomEvent<{ scope?: string; pageIds?: string[] }>).detail;
      e.preventDefault();
      handlers.current.openBook(d?.pageIds ?? [], null);
    };
    window.addEventListener(OPEN_EXPORT_EVENT, onOpen);
    window.addEventListener(DOCS_EXPORT_EVENT, onBook);
    return () => {
      window.removeEventListener(OPEN_EXPORT_EVENT, onOpen);
      window.removeEventListener(DOCS_EXPORT_EVENT, onBook);
    };
  }, []);

  // ---------- following the exports ----------
  const setRow = useCallback((row: ExportRow) => {
    setJobs((js) => js.map((j) => (j.row.id === row.id ? { ...j, row } : j)));
  }, []);
  const refresh = useCallback(
    async (id: string) => {
      try {
        setRow(await fetchExport(id));
      } catch {
        /* the next poll tries again */
      }
    },
    [setRow],
  );
  const runningIds = jobs
    .filter((j) => j.row.state === 'running')
    .map((j) => j.row.id)
    .join(',');
  useEffect(() => {
    if (!runningIds) return undefined;
    const t = setInterval(() => runningIds.split(',').forEach((id) => void refresh(id)), POLL_MS);
    return () => clearInterval(t);
  }, [runningIds, refresh]);
  useEffect(
    () =>
      subscribeSSE((data) => {
        let ev: { type?: string; id?: string };
        try {
          ev = JSON.parse(data) as { type?: string; id?: string };
        } catch {
          return;
        }
        if (ev.type !== 'docs_export') return;
        void qc.invalidateQueries({ queryKey: exportKeys.history(projectId) });
        if (ev.id && jobsRef.current.some((j) => j.row.id === ev.id)) void refresh(ev.id);
      }),
    [qc, projectId, refresh],
  );

  const download = useCallback(
    async (row: ExportRow) => {
      try {
        await downloadExport(row);
      } catch (e) {
        const d = docsErrorDetail(e);
        toast.error('Couldn’t download the export', d?.message ?? extractError(e));
      }
    },
    [toast],
  );

  // a ready export downloads by itself when the dialog shows it; a ready card goes away after a minute
  const handled = useRef(new Set<string>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    for (const j of jobs) {
      if (j.row.state === 'running' || handled.current.has(j.row.id)) continue;
      handled.current.add(j.row.id);
      void qc.invalidateQueries({ queryKey: exportKeys.history(projectId) });
      const shown = openRef.current?.view.kind === 'job' && openRef.current.view.id === j.row.id;
      if (j.row.state === 'ready' && shown) void download(j.row);
      if (j.row.state === 'ready' && j.background) {
        const id = j.row.id;
        timers.current.push(setTimeout(() => setJobs((js) => js.filter((x) => x.row.id !== id)), READY_CARD_MS));
      }
      if (j.row.state === 'cancelled' && j.background) setJobs((js) => js.filter((x) => x.row.id !== j.row.id));
    }
  }, [jobs, download, qc, projectId]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // ---------- starting ----------
  const start = useCallback(
    async (body: ExportBody, meta: { pages: number; title: string; embeds: number }, from: 'form' | 'book') => {
      if (busy) return;
      setBusy(true);
      try {
        const row = await startExport(projectId, body);
        const dialog = !!openRef.current;
        const background = body.scope === 'space' || !dialog;
        setJobs((js) => [
          ...js,
          { row, body, pages: meta.pages, title: meta.title, embeds: meta.embeds, startedAt: Date.now(), background },
        ]);
        if (dialog)
          setOpen((o) => (o && !background ? { ...o, view: { kind: 'job', id: row.id }, refused: null } : null));
        void qc.invalidateQueries({ queryKey: exportKeys.history(projectId) });
      } catch (e) {
        const d = docsErrorDetail(e) as { code: string; message: string; size?: number; limit?: number } | null;
        const text =
          d?.code === 'empty_page'
            ? EMPTY
            : d?.code === 'export_running'
              ? 'A whole-space export is already running. It is one at a time: wait for it, or stop it in History.'
              : !navigator.onLine
                ? OFFLINE
                : (d?.message ?? extractError(e));
        if (!openRef.current) {
          toast.error('Couldn’t start the export', d?.code === 'export_too_big' ? d.message : text);
        } else if (d?.code === 'export_too_big') {
          setOpen((o) => o && { ...o, view: { kind: 'tooBig', size: d.size ?? 0, limit: d.limit ?? 0, from } });
        } else {
          setOpen(
            (o) =>
              o && { ...o, view: from === 'book' ? { kind: 'book' } : { kind: 'form', tab: 'new' }, refused: text },
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, projectId, qc, toast],
  );

  // what the form knows about the page
  const draftOn = form.draft && canEdit;
  const doc = page ? (draftOn ? (draftDoc(page.draft) ?? publishedDoc(page)) : publishedDoc(page)) : null;
  const text = page ? (draftOn ? (page.draft?.markdown ?? page.markdown) : page.markdown) : null;
  const empty = form.scope === 'page' && text != null && !text.trim();
  const embeds = form.scope === 'page' ? countEmbeds(doc) : 0;
  const pagesOf = (f: ExportForm) =>
    f.scope === 'page' ? 1 : f.scope === 'space' ? nodes.length : children.length + 1 - f.unticked.length;
  const formPages = pagesOf(form);
  const ext = extensionFor(form.format, form.scope, formPages);
  const anyDraft =
    form.scope === 'space'
      ? nodes.some((n) => n.hasDraft)
      : form.scope === 'children'
        ? [node, ...children].some((n) => n?.hasDraft || n?.status === 'draft')
        : !!(node?.hasDraft || node?.status === 'draft' || page?.draft);
  const blocked = !online
    ? { text: OFFLINE, tone: 'off' as const }
    : empty
      ? { text: EMPTY, tone: 'warn' as const }
      : open?.refused
        ? { text: open.refused, tone: 'err' as const }
        : null;

  const changeForm = (f: ExportForm) => {
    // the file name follows the scope until it is typed
    const next =
      !f.nameEdited && f.scope !== form.scope
        ? { ...f, fileName: defaultFileName(f.scope, pageTitle, projectName) }
        : f;
    setForm(next);
    if (open?.refused) setOpen({ ...open, refused: null });
  };

  const submitForm = (f: ExportForm = form) => {
    if (checkFileName(f.fileName).error) return;
    rememberOptions(f.options);
    const ids = [pageId ?? '', ...children.map((c) => c.id)];
    const title = f.scope === 'space' ? `${projectName} docs` : pageTitle;
    void start(buildExportBody(f, ids), { pages: pagesOf(f), title, embeds: f.scope === 'page' ? embeds : 0 }, 'form');
  };
  const submitBook = (b: BookState = book!) => {
    rememberOptions(b.options);
    void start(
      buildBookBody(b.ids, b.format, b.options, b.settings, b.draft && canEdit),
      { pages: b.ids.length, title: b.settings.title || 'Book', embeds: 0 },
      'book',
    );
  };

  // ---------- job and history actions ----------
  const copyLink = (row: ExportRow) => {
    void navigator.clipboard
      ?.writeText(exportLink(row))
      .then(() => toast.success('Link copied', 'It works for 7 days.'))
      .catch(() => toast.error('Couldn’t copy the link'));
  };
  const stop = async (id: string) => {
    try {
      setRow(await cancelExport(id));
    } catch (e) {
      toast.error('Couldn’t stop the export', docsErrorDetail(e)?.message ?? extractError(e));
    }
    void qc.invalidateQueries({ queryKey: exportKeys.history(projectId) });
  };
  const dropJob = (id: string) => setJobs((js) => js.filter((j) => j.row.id !== id));
  const again = (job: ExportJob) => {
    dropJob(job.row.id);
    void start(
      job.body,
      { pages: job.pages, title: job.title, embeds: job.embeds },
      job.body.scope === 'book' ? 'book' : 'form',
    );
  };
  const againFromHistory = (row: ExportRow) => {
    const body = requestOf(row.id);
    if (body) {
      const title = body.scope === 'space' ? `${projectName} docs` : (row.fileName ?? 'Export');
      const pages = body.pageIds?.length ?? (body.scope === 'space' ? nodes.length : 1);
      void start(body, { pages, title, embeds: 0 }, body.scope === 'book' ? 'book' : 'form');
      return;
    }
    // not started on this device: the form, with what the row says
    openForm(row.pageId, row.format);
    setForm((f) => ({
      ...f,
      scope: row.scope === 'book' ? 'page' : row.scope,
      fileName: (row.fileName ?? f.fileName).replace(/\.[a-z]+$/i, ''),
      nameEdited: true,
    }));
  };
  const remove = async (row: ExportRow) => {
    try {
      await deleteExport(row.id);
      toast.success('File deleted', 'Your pages are not changed.');
    } catch (e) {
      toast.error('Couldn’t delete the file', docsErrorDetail(e)?.message ?? extractError(e));
    }
    void qc.invalidateQueries({ queryKey: exportKeys.history(projectId) });
  };

  const close = () => {
    const v = open?.view;
    if (v?.kind === 'job') {
      const j = jobs.find((x) => x.row.id === v.id);
      if (j?.row.state === 'running')
        setJobs((js) => js.map((x) => (x.row.id === v.id ? { ...x, background: true } : x)));
      else dropJob(v.id);
    }
    setOpen(null);
  };

  const cards = jobs.filter((j) => j.background && j.row.state !== 'cancelled');
  const cardEl = (
    <ExportCards
      jobs={cards}
      phone={layout === 'phone'}
      onStop={(j) => void stop(j.row.id).then(() => dropJob(j.row.id))}
      onDownload={(j) => void download(j.row)}
      onExportAgain={again}
      onDismiss={(j) => dropJob(j.row.id)}
    />
  );
  if (!open) return cardEl;

  const view = open.view;
  let dialog: ReactNode = null;
  if (view.kind === 'job') {
    const job = jobs.find((j) => j.row.id === view.id);
    if (job) {
      dialog = (
        <JobDialog
          job={job}
          layout={layout}
          actions={{
            onCancel: () => void stop(job.row.id),
            onKeepWorking: close,
            onDownload: () => void download(job.row),
            onOpen: () =>
              void openExportFile(job.row).catch((e) =>
                toast.error('Couldn’t open the export', docsErrorDetail(e)?.message ?? extractError(e)),
              ),
            onCopyLink: () => copyLink(job.row),
            onExportAgain: () => {
              dropJob(job.row.id);
              if (job.body.scope === 'book') submitBook();
              else void start(job.body, { pages: job.pages, title: job.title, embeds: job.embeds }, 'form');
            },
            onOtherOptions: () => {
              dropJob(job.row.id);
              setOpen({
                ...open,
                view: job.body.scope === 'book' && book ? { kind: 'book' } : { kind: 'form', tab: 'new' },
              });
            },
            onClose: close,
          }}
        />
      );
    }
  } else if (view.kind === 'tooBig') {
    const isBook = view.from === 'book' && book;
    const base: ExportForm = isBook ? { ...form, format: book.format, options: book.options, scope: 'children' } : form;
    const choices = reduceChoices(base).map((c) =>
      isBook && c.id === 'fewer'
        ? { ...c, title: 'Fewer pages', hint: 'Go back and leave some pages out of the book.', disabled: false }
        : c,
    );
    dialog = (
      <TooBigDialog
        layout={layout}
        title={isBook ? book.settings.title : pageTitle}
        size={view.size}
        limit={view.limit}
        choices={choices}
        onCancel={() => setOpen({ ...open, view: isBook ? { kind: 'book' } : { kind: 'form', tab: 'new' } })}
        onPick={(c: ReduceChoice) => {
          if (isBook) {
            if (c.id === 'fewer') {
              setBook({ ...book, step: 'pages' });
              setOpen({ ...open, view: { kind: 'book' } });
              return;
            }
            const applied = c.apply(base);
            const next = { ...book, format: applied.format, options: applied.options };
            setBook(next);
            submitBook(next);
            return;
          }
          const next = c.apply(form);
          const named = next.nameEdited
            ? next
            : { ...next, fileName: defaultFileName(next.scope, pageTitle, projectName) };
          setForm(named);
          submitForm(named);
        }}
      />
    );
  } else if (view.kind === 'book' && book) {
    dialog = (
      <BookDialog
        book={book}
        onChange={(b) => {
          setBook(b);
          if (open.refused) setOpen({ ...open, refused: null });
        }}
        nodes={nodes}
        layout={layout}
        canEdit={canEdit}
        blocked={!online ? OFFLINE : open.refused}
        busy={busy}
        onExport={() => submitBook()}
        onClose={close}
      />
    );
  } else if (view.kind === 'form') {
    const tab = view.tab;
    const nameErr = checkFileName(form.fileName).error;
    const space = form.scope === 'space';
    const tabs = (
      <div className="dx-tabs" role="tablist" aria-label="Export">
        {(
          [
            ['new', 'New export'],
            ['history', 'History'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            className="dx-tab"
            aria-selected={tab === k}
            data-testid={`export-tab-${k}`}
            onClick={() => setOpen({ ...open, view: { kind: 'form', tab: k } })}
          >
            {label}
          </button>
        ))}
      </div>
    );
    dialog = (
      <ExportFrame
        layout={layout}
        label="Export"
        title="Export"
        subtitle={
          tab === 'history'
            ? `Your exports from ${projectName}`
            : space
              ? `${projectName} · whole space`
              : `${pageTitle} · ${projectName}`
        }
        tabs={tabs}
        onClose={close}
        footer={
          tab === 'new' ? (
            <>
              {pageId && layout !== 'phone' && (
                <button
                  type="button"
                  className="dx-link"
                  data-testid="export-combine"
                  onClick={() => openBook([pageId, ...children.map((c) => c.id)], pageId)}
                >
                  Combine pages into one document…
                </button>
              )}
              <span className="dx-spacer" />
              {layout !== 'phone' && (
                <button type="button" className="st-btn" onClick={close}>
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="st-btn st-btn-primary"
                disabled={!!blocked || !!nameErr || busy || (form.scope === 'page' && !pageId)}
                onClick={() => submitForm()}
                data-testid="export-go"
              >
                {space ? 'Start export' : `Export ${FORMAT_LABEL[form.format]}`}
              </button>
            </>
          ) : undefined
        }
      >
        {tab === 'new' ? (
          <ExportFormBody
            form={form}
            onChange={changeForm}
            ctx={{
              pageTitle,
              projectName,
              children,
              spacePages: nodes.length,
              canEdit,
              anyDraft,
              extension: ext,
              embeds,
              blocked,
            }}
          />
        ) : (
          <ExportHistory
            projectId={projectId}
            layout={layout}
            actions={{
              onDownload: (r) => void download(r),
              onCopyLink: copyLink,
              onStop: (r) => void stop(r.id),
              onExportAgain: againFromHistory,
              onRemove: (r) => void remove(r),
              onNewExport: () => setOpen({ ...open, view: { kind: 'form', tab: 'new' } }),
            }}
          />
        )}
      </ExportFrame>
    );
  }
  return (
    <>
      {cardEl}
      {dialog}
    </>
  );
}
