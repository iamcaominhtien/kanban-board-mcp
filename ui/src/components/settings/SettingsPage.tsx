import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useProjects } from '../../api/projects';
import { McpIntegrations } from '../McpIntegrations';
import { AiSettingsSection } from '../ai/AiSettingsSection';
import { UpdateSettingsSection } from '../UpdateSettingsSection';
import { DocsSettingsRow } from '../docs/DocsSettingsRow';
import { DiagramSettingsSection } from '../diagrams/DiagramSettingsSection';
import { AssistSettings } from '../assist/AssistSettings';
import type { Theme } from '../../types';
import { ProjectRepoRow } from './ProjectRepoRow';
import { StoragePage } from './StoragePage';
import { DiagnosticsPage } from './DiagnosticsPage';
import {
  SETTINGS_PAGES,
  isSettingsPageId,
  searchSettings,
  type SettingEntry,
  type SettingsPageId,
} from './settingsIndex';
import styles from './SettingsPage.module.css';

const LAST_PAGE_KEY = 'settingsLastPage';

export interface SettingsTarget {
  page?: SettingsPageId;
  /** `data-setting` anchor to scroll to and highlight. */
  setting?: string;
}

interface SettingsPageProps {
  onClose: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** Project open on the board; the picker starts here. */
  projectId?: string;
  /** Opens the AI members page. */
  onManageAi?: () => void;
  target?: SettingsTarget;
}

const isDesktop = () => !!(window as any).electronAPI?.getUpdateStatus;

/** The page to open when none is asked for: the last one used, else Repositories. */
function startPage(target?: SettingsTarget): SettingsPageId {
  if (target?.page) return target.page;
  const last = localStorage.getItem(LAST_PAGE_KEY);
  return isSettingsPageId(last) ? last : 'repositories';
}

/** Keeps `?settings=<page>` in the address so a page can be linked to. */
function syncUrl(page: SettingsPageId | null) {
  const url = new URL(window.location.href);
  if (page) url.searchParams.set('settings', page);
  else url.searchParams.delete('settings');
  window.history.replaceState(null, '', url);
}

/**
 * Settings as a full page with a list of pages, search and direct links
 * (design/screens/settings-structure.md, settings-pages.md).
 */
export function SettingsPage({ onClose, theme, onToggleTheme, projectId, onManageAi, target }: SettingsPageProps) {
  const desktop = isDesktop();
  const pages = useMemo(() => SETTINGS_PAGES.filter((p) => !p.desktopOnly || desktop), [desktop]);
  const { data: projects = [] } = useProjects();
  const [page, setPage] = useState<SettingsPageId>(() => {
    const p = startPage(target);
    return pages.some((x) => x.id === p) ? p : 'repositories';
  });
  const [pickedProject, setPickedProject] = useState(projectId ?? '');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pendingSetting, setPendingSetting] = useState<string | null>(target?.setting ?? null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const project =
    projects.find((p) => p.id === pickedProject) ?? projects.find((p) => p.id === projectId) ?? projects[0];
  const def = pages.find((p) => p.id === page) ?? pages[0];
  const results = useMemo(() => searchSettings(query, desktop), [query, desktop]);

  function go(id: SettingsPageId, setting?: string) {
    setPage(id);
    setPendingSetting(setting ?? null);
    localStorage.setItem(LAST_PAGE_KEY, id);
    syncUrl(id);
  }

  useEffect(() => {
    syncUrl(page);
    return () => syncUrl(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to and highlight the setting a search result or a link points at
  useEffect(() => {
    if (!pendingSetting) return;
    const t = window.setTimeout(() => {
      const el = contentRef.current?.querySelector<HTMLElement>(`[data-setting="${pendingSetting}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove(styles.flash);
      void el.offsetWidth;
      el.classList.add(styles.flash);
    }, 150);
    return () => window.clearTimeout(t);
  }, [pendingSetting, page]);

  // Esc returns to the board; "/" focuses the search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
      if (e.key === 'Escape' && !typing) onClose();
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function open(entry: SettingEntry) {
    go(entry.page, entry.id);
    setQuery('');
    searchRef.current?.blur();
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      if (query) setQuery('');
      else searchRef.current?.blur();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && results[active]) {
      open(results[active]);
    }
  }

  const where = (e: SettingEntry) => {
    const p = SETTINGS_PAGES.find((x) => x.id === e.page)!;
    return `${p.scope === 'project' ? `Project${project ? ` · ${project.name}` : ''}` : 'App'} › ${p.label} › ${e.section}`;
  };

  let body: ReactNode;
  switch (def.id) {
    case 'repositories':
      body = project ? (
        <div className={styles.section} data-setting="repo-path">
          <span className={styles.sectionTitle}>
            {project.name} ({project.prefix})
          </span>
          <div className={styles.hint}>
            Branches created on a ticket are created in this repository. A ticket can override it from its branch menu.
          </div>
          <div data-setting="worktree">
            <ProjectRepoRow project={project} />
          </div>
          <div className={styles.hint}>Other projects: switch project at the top of the list.</div>
        </div>
      ) : null;
      break;
    case 'docs':
      body = project ? (
        <div className={styles.section} data-setting="docs-enabled">
          <DocsSettingsRow project={project} />
        </div>
      ) : null;
      break;
    case 'ai':
      body = project ? <AiSettingsSection projectId={project.id} onManage={onManageAi} /> : null;
      break;
    case 'assistant':
      body = project ? (
        <div className="ai-root" data-setting="assistant">
          <AssistSettings projectId={project.id} onOpenAudit={onManageAi} />
        </div>
      ) : null;
      break;
    case 'appearance':
      body = (
        <div className={styles.section} data-setting="theme">
          <span className={styles.sectionTitle}>Theme</span>
          <div className={styles.hint}>
            How the app looks on this computer. Switch between color and black &amp; white TV mode.
          </div>
          <button type="button" className={styles.btn} onClick={onToggleTheme} style={{ alignSelf: 'flex-start' }}>
            {theme === 'default' ? '📺 Switch to B&W' : '🎨 Switch to Color'}
          </button>
        </div>
      );
      break;
    case 'storage':
      body = <StoragePage />;
      break;
    case 'integrations':
      body = (
        <>
          <div data-setting="mcp">
            <McpIntegrations />
          </div>
          <div className={styles.section} data-setting="drawio">
            <span className={styles.sectionTitle}>Diagrams (draw.io)</span>
            <DiagramSettingsSection />
          </div>
        </>
      );
      break;
    case 'updates':
      body = (
        <div data-setting="updates">
          <UpdateSettingsSection />
        </div>
      );
      break;
    case 'diagnostics':
      body = <DiagnosticsPage />;
      break;
  }

  const projectPicker = (
    <select
      className={`${styles.input} ${styles.picker}`}
      value={project?.id ?? ''}
      onChange={(e) => setPickedProject(e.target.value)}
      aria-label="Project to edit"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.prefix})
        </option>
      ))}
    </select>
  );

  return (
    <div className={styles.page} role="region" aria-label="Settings" data-testid="settings-page">
      <div className={styles.topbar}>
        <button type="button" className={styles.backBtn} onClick={onClose}>
          ← Back to board
        </button>
        <div className={styles.searchWrap}>
          <input
            ref={searchRef}
            className={styles.searchInput}
            type="search"
            placeholder="Search settings   ( / )"
            aria-label="Search settings"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKey}
          />
          {query.trim() && (
            <div className={styles.results} role="listbox">
              {results.length === 0 ? (
                <div className={styles.noResults}>
                  No setting matches “{query.trim()}”. Try a shorter word, or one of:{' '}
                  {['theme', 'backup', 'MCP', 'logs', 'draw.io'].map((w) => (
                    <button key={w} type="button" className={styles.backBtn} onClick={() => setQuery(w)}>
                      {w}
                    </button>
                  ))}
                </div>
              ) : (
                results.map((r, i) => (
                  <button
                    key={`${r.id}-${r.name}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={`${styles.result} ${i === active ? styles.resultActive : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => open(r)}
                  >
                    <span className={styles.resultWhere}>{where(r)}</span>
                    <span className={styles.resultName}>{r.name}</span>
                    <span className={styles.resultDesc}>{r.description}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <select
        className={styles.navSelect}
        value={def.id}
        onChange={(e) => go(e.target.value as SettingsPageId)}
        aria-label="Settings page"
      >
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.scope === 'project' ? 'Project' : 'App'} · {p.label}
          </option>
        ))}
      </select>

      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="Settings pages">
          <div className={styles.navGroup}>Project settings</div>
          {projectPicker}
          {pages
            .filter((p) => p.scope === 'project')
            .map((p) => (
              <NavItem key={p.id} label={p.label} active={p.id === def.id} onClick={() => go(p.id)} />
            ))}
          <div className={styles.navGroup}>App settings · all projects</div>
          {pages
            .filter((p) => p.scope === 'app')
            .map((p) => (
              <NavItem key={p.id} label={p.label} active={p.id === def.id} onClick={() => go(p.id)} />
            ))}
        </nav>
        <div className={styles.content} ref={contentRef}>
          <div className={styles.contentInner}>
            <div>
              <div className={styles.scopeNote}>
                {def.scope === 'project' ? `Project${project ? ` · ${project.name}` : ''}` : 'App · all projects'}
              </div>
              <h1 className={styles.pageTitle}>{def.title}</h1>
              <p className={styles.pageSummary}>{def.summary}</p>
            </div>
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
