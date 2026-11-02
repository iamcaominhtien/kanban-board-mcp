import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../Toast';
import {
  REPO_URL,
  RELEASES_URL,
  SHORTCUT_GROUPS,
  diagnosticsText,
  filterShortcuts,
  formatKeys,
  releaseNotesFor,
  reportIssueText,
  reportIssueUrl,
  type AppInfo,
  type ReleaseNotes,
} from './desktopHelpers';
import styles from './DesktopWindows.module.css';
import { LineIcon } from '../ui/LineIcon';

const isMac = () => window.electronAPI?.platform === 'darwin';

interface DialogProps {
  title: string;
  /** Keep the title for screen readers only (About shows the app name in its body instead). */
  hideTitle?: boolean;
  subtitle?: string;
  small?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}

/** The frame the four windows share: a title, a body, a footer with Close, and Esc to close. */
function Dialog({ title, hideTitle, subtitle, small, onClose, footer, children }: DialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`${styles.panel} ${small ? styles.small : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.head}>
          {hideTitle ? <span /> : <h2 className={styles.title}>{title}</h2>}
          <button type="button" className={styles.x} aria-label="Close" onClick={onClose}>
            <LineIcon name="close" size={14} />
          </button>
        </div>
        {subtitle && <p className={styles.sub}>{subtitle}</p>}
        <div className={styles.body}>{children}</div>
        <div className={styles.foot}>{footer}</div>
      </div>
    </div>
  );
}

function CloseButton({ onClose, primary }: { onClose: () => void; primary?: boolean }) {
  return (
    <button type="button" className={`${styles.btn} ${primary ? styles.primary : ''}`} onClick={onClose}>
      Close
    </button>
  );
}

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    void window.electronAPI?.getAppInfo?.().then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/** Help › Keyboard Shortcuts: every shortcut, searchable by command or by key. Reads the same list as the guide. */
export function KeyboardShortcutsWindow({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const mac = isMac();
  const groups = useMemo(() => filterShortcuts(SHORTCUT_GROUPS, query, mac), [query, mac]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <Dialog title="Keyboard Shortcuts" onClose={onClose} footer={<CloseButton onClose={onClose} />}>
      <input
        ref={input}
        className={styles.search}
        style={{ margin: '0 0 4px', width: '100%', boxSizing: 'border-box' }}
        type="search"
        aria-label="Search shortcuts and commands"
        placeholder="Search shortcuts and commands…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {groups.length === 0 && <div className={styles.empty}>No shortcut matches “{query}”.</div>}
      {groups.map((g) => (
        <section key={g.id}>
          <h3 className={styles.groupTitle}>{g.title}</h3>
          {g.items.map((i) => (
            <div key={i.id} className={styles.row}>
              <span>
                {i.label}
                <span className={styles.where}>{i.where}</span>
              </span>
              <span className={styles.keys}>
                {formatKeys(i.keys, mac).map((k, n) => (
                  <kbd key={n} className={styles.key}>
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      {!mac && <p className={styles.never}>On a Mac the keys show as ⌘, ⌥ and ⇧.</p>}
    </Dialog>
  );
}

/** "2026-11-02" as "2 Nov 2026"; any other text stays as it is. */
function releasedOn(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return mon ? `${Number(m[3])} ${mon} ${m[1]}` : date;
}

/** Help › What's New: the release notes of the version that is running, from CHANGELOG.md. */
export function WhatsNewWindow({ onClose }: { onClose: () => void }) {
  const info = useAppInfo();
  const [notes, setNotes] = useState<ReleaseNotes | null | undefined>(undefined);
  useEffect(() => {
    if (!info) return;
    let live = true;
    void import('../../../../CHANGELOG.md?raw').then((m) => live && setNotes(releaseNotesFor(m.default, info.version)));
    return () => {
      live = false;
    };
  }, [info]);
  const open = () => void window.electronAPI?.openExternal?.(RELEASES_URL);
  return (
    <Dialog
      title={info ? `What’s new in ${info.version}` : 'What’s new'}
      subtitle={notes?.date ? `Released ${releasedOn(notes.date)}` : undefined}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.btn} onClick={open}>
            <LineIcon name="external" size={13} />
            Full changelog
          </button>
          <CloseButton onClose={onClose} primary />
        </>
      }
    >
      {notes === undefined && <div className={styles.empty}>Loading…</div>}
      {notes === null && (
        <div className={styles.empty}>There are no release notes for this version. Use Full changelog.</div>
      )}
      {notes && <MarkdownRenderer plain>{notes.body}</MarkdownRenderer>}
    </Dialog>
  );
}

/** Help › Report an Issue…: shows what will be filled in, then opens a new GitHub issue. Nothing is sent by the app. */
export function ReportIssueWindow({ onClose }: { onClose: () => void }) {
  const info = useAppInfo();
  const toast = useToast();
  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(reportIssueText(info));
      toast.success('Copied');
    } catch {
      toast.error('Could not copy', 'Select the text and copy it by hand.');
    }
  };
  return (
    <Dialog
      title="Report an issue"
      subtitle="This opens a new GitHub issue in your browser. Nothing is sent until you press Create issue there."
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.btn} onClick={() => void copy()} disabled={!info}>
            <LineIcon name="copy" size={14} />
            Copy text
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            disabled={!info}
            onClick={() => {
              if (info) void window.electronAPI?.openExternal?.(reportIssueUrl(info));
              onClose();
            }}
          >
            <LineIcon name="external" size={14} />
            Open GitHub
          </button>
        </>
      }
    >
      <div className={styles.preview} data-testid="report-preview">
        {info ? reportIssueText(info) : 'Loading…'}
      </div>
      <div className={styles.scope}>
        <span className={styles.included}>
          <LineIcon name="check" size={13} />
          Included: versions, system, window size
        </span>
        <span className={styles.excluded}>
          <LineIcon name="close" size={13} />
          Never included: tickets, Docs, file paths, keys, logs
        </span>
      </div>
      <p className={styles.never}>Logs can help; attach them yourself with Help › Export Logs…</p>
    </Dialog>
  );
}

/** About (Windows and Linux; macOS uses the system About window). */
export function AboutWindow({ onClose }: { onClose: () => void }) {
  const info = useAppInfo();
  const toast = useToast();
  return (
    <Dialog small hideTitle title="About Kanban Board" onClose={onClose} footer={<CloseButton onClose={onClose} />}>
      <div className={styles.about}>
        <span className={styles.appTile} aria-hidden="true">
          <span />
        </span>
        <h2 className={styles.aboutName}>Kanban Board</h2>
        <p className={styles.facts}>
          {info
            ? `Version ${info.version} · Backend ${info.backendRunning ? 'running' : 'not running'} · Electron ${info.electron}`
            : 'Loading…'}
        </p>
        <p className={styles.blurb}>
          A local Kanban board with Docs, ideas and AI members. Your data stays on this computer.
        </p>
        <div className={styles.aboutActions}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => void window.electronAPI?.openExternal?.(RELEASES_URL)}
          >
            <LineIcon name="external" size={14} />
            Release notes
          </button>
          <button
            type="button"
            className={styles.btn}
            disabled={!info}
            onClick={() => {
              if (!info) return;
              void navigator.clipboard.writeText(diagnosticsText(info)).then(() => toast.success('Copied'));
            }}
          >
            <LineIcon name="copy" size={14} />
            Copy diagnostics
          </button>
        </div>
        <p className={styles.never}>
          © 2026 Cao Minh Tiến · MIT licence ·{' '}
          <a href={REPO_URL} onClick={(e) => (e.preventDefault(), void window.electronAPI?.openExternal?.(REPO_URL))}>
            Source on GitHub
          </a>
        </p>
      </div>
    </Dialog>
  );
}
