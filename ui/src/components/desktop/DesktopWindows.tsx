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

const isMac = () => window.electronAPI?.platform === 'darwin';

interface DialogProps {
  title: string;
  subtitle?: string;
  small?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}

/** The frame the four windows share: a title, a body, a footer with Close, and Esc to close. */
function Dialog({ title, subtitle, small, onClose, footer, children }: DialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${styles.panel} ${small ? styles.small : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.x} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {subtitle && <p className={styles.sub}>{subtitle}</p>}
        <div className={styles.body}>{children}</div>
        <div className={styles.foot}>{footer}</div>
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className={styles.btn} onClick={onClose}>
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
    <Dialog
      title="Keyboard Shortcuts"
      onClose={onClose}
      footer={<CloseButton onClose={onClose} />}
    >
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
      subtitle={notes?.date ? `Released ${notes.date}` : undefined}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.btn} onClick={open}>
            Full changelog
          </button>
          <CloseButton onClose={onClose} />
        </>
      }
    >
      {notes === undefined && <div className={styles.empty}>Loading…</div>}
      {notes === null && <div className={styles.empty}>There are no release notes for this version. Use Full changelog.</div>}
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
            Open GitHub
          </button>
        </>
      }
    >
      <div className={styles.preview}>{info ? reportIssueText(info) : 'Loading…'}</div>
      <p className={styles.never}>
        Included: versions, system, window size. Never included: tickets, Docs, file paths, keys, logs. Logs can help;
        attach them yourself with Help › Export Logs…
      </p>
    </Dialog>
  );
}

/** About (Windows and Linux; macOS uses the system About window). */
export function AboutWindow({ onClose }: { onClose: () => void }) {
  const info = useAppInfo();
  const toast = useToast();
  return (
    <Dialog
      small
      title="About"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.btn} onClick={() => void window.electronAPI?.openExternal?.(RELEASES_URL)}>
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
            Copy diagnostics
          </button>
          <CloseButton onClose={onClose} />
        </>
      }
    >
      <div className={styles.about}>
        <p className={styles.aboutName}>Kanban Board</p>
        <p className={styles.facts}>
          {info ? `Version ${info.version} · Backend ${info.backendRunning ? 'running' : 'not running'} · Electron ${info.electron}` : 'Loading…'}
        </p>
        <p>A local Kanban board with Docs, ideas and AI members. Your data stays on this computer.</p>
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
