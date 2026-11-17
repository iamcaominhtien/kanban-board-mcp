/**
 * Restore a version, or copy it as a new page (design "History and comments on rich pages", C 14–17). Restore asks
 * first: the page as it was, what it changes against today's page (in blocks), and what happens to comments (those
 * on blocks the version lacks stay as orphaned threads; nothing is deleted). "Copy as a new page" makes a draft page
 * from the version's content, next to the page.
 */

import { useEffect, useRef, useState } from 'react';
import { useDocsDiff } from '../../../api/docs';
import type { DocsCommentThread, DocsPage, DocsVersionDetail, DocsVersionSummary, RichDoc } from '../../../types/docs';
import { orphanedByRestore } from '../comments/blockAnchor';
import { Icon } from '../Icon';
import { RichDocView } from '../RichDocView';
import { FooterNote, ModalShell, Spacer, blueInfoBox, displayName, fmtDateTime, plural } from '../docsShared';
import { useCopyVersionAsPage } from './api';
import { isRich, orphanSentence, restoreCounts } from './versionInfo';
import './history.css';

/** The page as a version had it, small and read-only, faded at the bottom. */
function Preview({ projectId, title, detail }: { projectId: string; title: string; detail?: DocsVersionDetail }) {
  return (
    <div className="hx-preview" aria-label={`${title}, as it was`} data-testid="hx-preview">
      <div className="hx-preview-title">{title}</div>
      {!detail && <div className="skel" style={{ width: '80%', height: 10 }} />}
      {detail && isRich(detail) && <RichDocView doc={detail.content} projectId={projectId} />}
      {detail && !isRich(detail) && <div className="hx-preview-md">{detail.markdown.slice(0, 1200)}</div>}
    </div>
  );
}

/** A number with its words under it ("5 / blocks changed"). */
function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className={`hx-stat hx-stat-${tone}`}>
      <b>{n}</b>
      <span>{label}</span>
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
    <ModalShell
      width={compact ? 420 : 560}
      zIndex={1200}
      ariaLabel={`Restore v${target.version}`}
      testId="hx-restore"
      icon="i19"
      title={`Restore v${target.version}?`}
      subtitle={
        <>
          {displayName(target.author)} · {fmtDateTime(target.createdAt)}
          {target.note ? ` · “${target.note}”` : ''}
        </>
      }
      onClose={onCancel}
      bodyStyle={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={
        <>
          <FooterNote>Everyone sees v{next} right away.</FooterNote>
          <Spacer />
          <button type="button" className="st-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            onClick={() => onConfirm(note.trim())}
            disabled={busy}
            data-testid="hx-restore-confirm"
          >
            <Icon name="i19" size={14} />
            {busy ? 'Restoring…' : `Restore as v${next}`}
          </button>
        </>
      }
    >
      <div style={blueInfoBox}>
        <span style={{ color: '#2F6FB0', display: 'flex', marginTop: 1 }}>
          <Icon name="i28" size={16} />
        </span>
        <span data-testid="hx-restore-what">
          <b style={{ fontWeight: 700 }}>Restoring creates v{next}.</b> {page.title} is set back to the content of v
          {target.version} and published as a new version. v{page.version} stays in the history, so you can go back at
          any time.
        </span>
      </div>
      {!compact && <Preview projectId={projectId} title={detail?.title ?? page.title} detail={detail} />}
      {blocks && (
        <div className="hx-stats" data-testid="hx-restore-counts">
          <span className="hx-stats-head">Compared with today’s page</span>
          <Stat n={blocks.changed} label={blocks.changed === 1 ? 'block changed' : 'blocks changed'} tone="changed" />
          <Stat n={blocks.addedBack} label="added back" tone="added" />
          <Stat n={blocks.removed} label="removed" tone="removed" />
        </div>
      )}
      {!blocks && lineQ.data && (
        <div className="hx-stats" data-testid="hx-restore-lines">
          <span className="hx-stats-head">Compared with today’s page</span>
          <Stat n={lineQ.data.removed} label="lines back" tone="added" />
          <Stat n={lineQ.data.added} label="lines removed" tone="removed" />
        </div>
      )}
      <div className="hx-comments-note" data-testid="hx-restore-comments">
        <Icon name="comment" size={15} strokeWidth={1.8} />
        <span>
          Comments stay with the page, not with a version.
          {sentence && (
            <>
              {' '}
              <b>{sentence}</b>
            </>
          )}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="st-field-label" htmlFor="restore-note" style={{ fontSize: 11 }}>
          Version note
        </label>
        <input
          id="restore-note"
          ref={noteRef}
          className="st-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {draft && (
        <div className="hx-warn">
          <Icon name="i14" size={15} strokeWidth={2} />
          <span>
            {displayName(draft.author)} {displayName(draft.author) === 'You' ? 'have' : 'has'} an unpublished draft (
            {plural(draft.saves ?? 1, 'autosave')}). It is kept, and will now be based on v{next}.
          </span>
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
          {error}
        </div>
      )}
    </ModalShell>
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
    <ModalShell
      width={540}
      zIndex={1200}
      ariaLabel={`Copy v${target.version} as a new page`}
      testId="hx-copy"
      icon="i21"
      title={`Copy v${target.version} as a new page`}
      subtitle={`${displayName(target.author)} · ${fmtDateTime(target.createdAt)}`}
      onClose={onCancel}
      bodyStyle={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={
        <>
          <FooterNote>The copy is created as a draft.</FooterNote>
          <Spacer />
          <button type="button" className="st-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={!detail || !title.trim() || copy.isPending}
            onClick={() => void create()}
            data-testid="hx-copy-confirm"
          >
            {copy.isPending ? 'Creating…' : 'Create draft'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="st-field-label" htmlFor="copy-title" style={{ fontSize: 11 }}>
          Title
        </label>
        <input id="copy-title" className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="st-field-label" style={{ fontSize: 11 }}>
          Place
        </span>
        <span className="hx-place">
          <Icon name="page" size={13} strokeWidth={1.9} />
          {place}
        </span>
      </div>
      <Preview projectId={projectId} title={detail?.title ?? page.title} detail={detail} />
      <div className="hx-comments-note">
        <Icon name="i28" size={15} />
        <span>
          The copy has the blocks of v{target.version}: formatting, images and embeds. Its history starts at v1.
          Comments and versions stay on the original page.
        </span>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
          {error}
        </div>
      )}
    </ModalShell>
  );
}
