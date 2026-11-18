/**
 * Restore a version, or copy it as a new page (design "History and comments on rich pages", C 14–17). Restore asks
 * first: the page as it was, what it changes against today's page (in blocks), and what happens to comments (those
 * on blocks the version lacks stay as orphaned threads; nothing is deleted). "Copy as a new page" makes a draft page
 * from the version's content, next to the page.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDocsDiff } from '../../../api/docs';
import type { DocsCommentThread, DocsPage, DocsVersionDetail, DocsVersionSummary, RichDoc } from '../../../types/docs';
import { orphanedByRestore } from '../comments/blockAnchor';
import { Icon } from '../Icon';
import { RichDocView } from '../RichDocView';
import { DOCS_SCRIM, displayName, fmtDateTime, plural, useEscape } from '../docsShared';
import { useCopyVersionAsPage } from './api';
import { isRich, orphanSentence, restoreCounts } from './versionInfo';
import './history.css';

/** Props of {@link HxDialog}. */
interface HxDialogProps {
  ariaLabel: string;
  testId: string;
  /** The icon in the purple square of the head. */
  icon: string;
  title: string;
  subtitle: ReactNode;
  /** Desktop width in px. */
  width: number;
  /** On a phone: a sheet from the bottom with a grab handle, no close button and no rule under the head. */
  sheet?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}

/**
 * The restore and copy dialogs' frame (design C 14, 15, 17): a 14 px card with a purple icon, the title and the
 * version's line in the head, the body, and a footer with a note and the buttons; on a phone a sheet from the bottom.
 */
function HxDialog({
  ariaLabel,
  testId,
  icon,
  title,
  subtitle,
  width,
  sheet,
  onClose,
  footer,
  children,
}: HxDialogProps) {
  useEscape(onClose);
  return (
    <div
      className={`docs-root hx-dlg-scrim${sheet ? ' is-sheet' : ''}`}
      style={{ background: DOCS_SCRIM }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        className="hx-dlg"
        style={sheet ? undefined : { width }}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="hx-dlg-grab" aria-hidden="true" />}
        <div className="hx-dlg-head">
          {!sheet && (
            <span className="hx-dlg-ico">
              <Icon name={icon} size={17} strokeWidth={2} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hx-dlg-title">{title}</div>
            <div className="hx-dlg-sub">{subtitle}</div>
          </div>
          {!sheet && (
            <button type="button" className="hx-close" aria-label="Close" onClick={onClose}>
              <Icon name="i08" size={16} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="hx-dlg-body">{children}</div>
        <div className="hx-dlg-foot">{footer}</div>
      </div>
    </div>
  );
}

/** The page as a version had it, as a small read-only thumbnail. */
function Preview({ projectId, title, detail }: { projectId: string; title: string; detail?: DocsVersionDetail }) {
  return (
    <div className="hx-preview" aria-label={`${title}, as it was`} data-testid="hx-preview">
      <div className="hx-preview-title">{title}</div>
      {!detail && <div className="skel" style={{ width: '80%', height: 5 }} />}
      {detail && isRich(detail) && (
        <div className="hx-preview-doc">
          <RichDocView doc={detail.content} projectId={projectId} />
        </div>
      )}
      {detail && !isRich(detail) && <div className="hx-preview-md">{detail.markdown.slice(0, 600)}</div>}
    </div>
  );
}

/** A number and its words, on one line ("5 blocks changed"). */
function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="hx-count">
      <b className={`hx-c-${tone}`}>{n}</b>
      <span className="hx-count-word">{label}</span>
    </div>
  );
}

/** Props of {@link RestoreDialog}. */
export interface RestoreDialogProps {
  projectId: string;
  page: DocsPage;
  target: DocsVersionSummary;
  /** The version's content (undefined while it loads). */
  detail?: DocsVersionDetail;
  /** The page's comment threads (for what happens to them). */
  threads: DocsCommentThread[];
  busy: boolean;
  error: string | null;
  /** On a phone: a sheet with the same facts, no preview of the whole page. */
  compact?: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}

/**
 * Asks before a restore: the page as it was, what it changes, what happens to comments, and the version note.
 * @param props - See {@link RestoreDialogProps}.
 */
export function RestoreDialog({
  projectId,
  page,
  target,
  detail,
  threads,
  busy,
  error,
  compact,
  onCancel,
  onConfirm,
}: RestoreDialogProps) {
  const [note, setNote] = useState(`Restored from v${target.version}`);
  const noteRef = useRef<HTMLInputElement>(null);
  useEffect(() => noteRef.current?.focus(), []);
  const current: RichDoc | null = page.format === 'rich' ? (page.content ?? null) : null;
  const blocks = current && detail && isRich(detail) ? restoreCounts(current, detail.content) : null;
  // a Markdown page or version: say it in lines, as before
  const lineQ = useDocsDiff(
    page.id,
    detail && !blocks ? target.version : null,
    detail && !blocks ? page.version : null,
  );
  const orphans = current && detail && isRich(detail) ? orphanedByRestore(threads, current, detail.content) : 0;
  const next = page.version + 1;
  const draft = page.draft;
  const sentence = orphanSentence(orphans, target.version);

  return (
    <HxDialog
      width={580}
      sheet={compact}
      ariaLabel={`Restore v${target.version}`}
      testId="hx-restore"
      icon="i19"
      title={`Restore v${target.version}?`}
      subtitle={
        <>
          {displayName(target.author)} · {fmtDateTime(target.createdAt)}
          {target.note && !compact ? ` · “${target.note}”` : ''}
        </>
      }
      onClose={onCancel}
      footer={
        <>
          {!compact && <span className="hx-dlg-note">Everyone sees v{next} right away.</span>}
          {!compact && <span style={{ flex: 1 }} />}
          <button type="button" className="st-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary hx-dlg-go"
            onClick={() => onConfirm(note.trim())}
            disabled={busy}
            data-testid="hx-restore-confirm"
          >
            <Icon name="i19" size={compact ? 15.5 : 14} strokeWidth={2.4} />
            {busy ? 'Restoring…' : `Restore as v${next}`}
          </button>
        </>
      }
    >
      <div className="hx-info">
        <Icon name="i28" size={14} strokeWidth={2.2} />
        <span data-testid="hx-restore-what">
          <b>Restoring creates v{next}.</b>{' '}
          {compact ? (
            <>v{page.version} stays in the history.</>
          ) : (
            <>
              {page.title} is set back to the content of v{target.version} and published as a new version. v
              {page.version} stays in the history, so you can go back at any time.
            </>
          )}
        </span>
      </div>
      <div className="hx-facts">
        <Preview projectId={projectId} title={detail?.title ?? page.title} detail={detail} />
        <div className="hx-facts-text">
          {!compact && <b>Compared with today’s page</b>}
          {blocks && (
            <div className="hx-stats" data-testid="hx-restore-counts">
              <Stat
                n={blocks.changed}
                label={blocks.changed === 1 ? 'block changed' : 'blocks changed'}
                tone="changed"
              />
              <Stat n={blocks.addedBack} label="added back" tone="added" />
              <Stat n={blocks.removed} label="removed" tone="removed" />
            </div>
          )}
          {!blocks && lineQ.data && (
            <div className="hx-stats" data-testid="hx-restore-lines">
              <Stat n={lineQ.data.removed} label="lines back" tone="added" />
              <Stat n={lineQ.data.added} label="lines removed" tone="removed" />
            </div>
          )}
          {!compact && (
            <div className="hx-facts-muted" data-testid="hx-restore-comments">
              <span>Comments stay with the page, not with a version.</span>
            </div>
          )}
        </div>
      </div>
      {sentence && (
        <div className="hx-warn" data-testid="hx-restore-orphans">
          <Icon name="i14" size={14} strokeWidth={2.2} />
          <span>
            {compact ? (
              <>
                {orphans === 1 ? '1 comment is' : `${orphans} comments are`} on blocks v{target.version} does not have.
                They stay as orphaned threads.
              </>
            ) : (
              <>
                <b>{sentence.slice(0, sentence.indexOf('.') + 1)}</b>
                {sentence.slice(sentence.indexOf('.') + 1)}
              </>
            )}
          </span>
        </div>
      )}
      {!compact && (
        <div className="hx-field">
          <label className="hx-field-label" htmlFor="restore-note">
            Version note
          </label>
          <input
            id="restore-note"
            ref={noteRef}
            className="hx-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {draft && (
        <div className="hx-warn">
          <Icon name="i14" size={14} strokeWidth={2.2} />
          <span>
            {displayName(draft.author)} {displayName(draft.author) === 'You' ? 'have' : 'has'} an unpublished draft (
            {plural(draft.saves ?? 1, 'autosave')}). It is kept, and will now be based on v{next}.
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="hx-dlg-error">
          {error}
        </div>
      )}
    </HxDialog>
  );
}

/** Where a copy goes: next to the page, under its parent. */
export function placeOf(page: DocsPage): string {
  if (!page.parentId) return 'Top level';
  return page.path.find((p) => p.id === page.parentId)?.title ?? 'Next to this page';
}

/** Props of {@link CopyPageDialog}. */
export interface CopyPageDialogProps {
  projectId: string;
  page: DocsPage;
  target: DocsVersionSummary;
  detail?: DocsVersionDetail;
  onCancel: () => void;
  /** Called with the new draft page, its title and its place. */
  onCreated: (created: DocsPage, title: string, place: string) => void;
}

/**
 * "Copy vN as a new page": a title, the place (next to the page), the page as it was; creates a draft.
 * @param props - See {@link CopyPageDialogProps}.
 */
export function CopyPageDialog({ projectId, page, target, detail, onCancel, onCreated }: CopyPageDialogProps) {
  const [title, setTitle] = useState(`${detail?.title ?? target.title ?? page.title} (v${target.version})`);
  const [error, setError] = useState<string | null>(null);
  const copy = useCopyVersionAsPage(projectId);
  const place = placeOf(page);
  const create = async () => {
    if (!detail || !title.trim()) return;
    setError(null);
    try {
      const created = await copy.mutateAsync({
        title: title.trim(),
        parentId: page.parentId,
        content: isRich(detail) ? detail.content : null,
        markdown: detail.markdown,
      });
      onCreated(created, title.trim(), place);
    } catch {
      setError(`Couldn’t copy v${target.version}. Check your connection and try again.`);
    }
  };
  return (
    <HxDialog
      width={520}
      ariaLabel={`Copy v${target.version} as a new page`}
      testId="hx-copy"
      icon="i24"
      title={`Copy v${target.version} as a new page`}
      subtitle={`${displayName(target.author)} · ${fmtDateTime(target.createdAt)}`}
      onClose={onCancel}
      footer={
        <>
          <span className="hx-dlg-note">The copy is created as a draft.</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary hx-dlg-go"
            disabled={!detail || !title.trim() || copy.isPending}
            onClick={() => void create()}
            data-testid="hx-copy-confirm"
          >
            <Icon name="i24" size={14} strokeWidth={2.4} />
            {copy.isPending ? 'Creating…' : 'Create draft'}
          </button>
        </>
      }
    >
      <div className="hx-field">
        <label className="hx-field-label" htmlFor="copy-title">
          Title
        </label>
        <input id="copy-title" className="hx-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="hx-field">
        <span className="hx-field-label">Place</span>
        <span className="hx-input hx-place">
          <Icon name="folder" size={14} strokeWidth={2} />
          <span style={{ flex: 1 }}>{place}</span>
        </span>
      </div>
      <div className="hx-facts">
        <Preview projectId={projectId} title={detail?.title ?? page.title} detail={detail} />
        <div className="hx-facts-text">
          <span>
            The copy has the blocks of v{target.version}: formatting, images and embeds. Its history starts at v1.
          </span>
          <div className="hx-facts-muted">Comments and versions stay on the original page.</div>
        </div>
      </div>
      {error && (
        <div role="alert" className="hx-dlg-error">
          {error}
        </div>
      )}
    </HxDialog>
  );
}
