import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useProjects } from '../../api/projects';
import { McpIntegrations } from '../McpIntegrations';
import { McpFullControl } from '../McpFullControl';
import { AiSettingsSection } from '../ai/AiSettingsSection';
import { UpdateSettingsSection } from '../UpdateSettingsSection';
import { DocsSettingsRow } from '../docs/DocsSettingsRow';
import { IdeaSpaceSettings } from '../ideas/IdeaSpaceSettings';
import { DocsAiSettings } from '../docs/ai/DocsAiSettings';
import { DiagramSettingsSection } from '../diagrams/DiagramSettingsSection';
import { AssistSettings } from '../assist/AssistSettings';
import type { Theme } from '../../types';
import { ProjectRepoRow } from './ProjectRepoRow';
import { StoragePage } from './StoragePage';
import { DiagnosticsPage } from './DiagnosticsPage';
import { NotificationsSettings } from './NotificationsSettings';
import { NotificationBellButton } from '../notifications/NotificationsHost';
import { ICONS, SIcon, SettingsCard, type IconName } from './settingsUi';
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
  /** Opens the AI accounts tab of the Members page. */
  onManageAccounts?: () => void;
  target?: SettingsTarget;
}

/** The icon of each page in the list (SettingsNav.dc.html, B). */
const PAGE_ICON: Record<SettingsPageId, IconName> = {
  repositories: 'repositories',
  docs: 'docs',
  ai: 'ai',
  assistant: 'assistant',
  ideas: 'ideas',
  appearance: 'appearance',
  notifications: 'notifications',
  storage: 'storage',
  integrations: 'integrations',
  updates: 'updates',
  diagnostics: 'diagnostics',
};

/** Words offered when a search finds nothing (D: No results). */
const SUGGESTIONS = ['theme', 'backup', 'MCP', 'budget', 'logs', 'draw.io'];

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

/** The words of `query` marked in `text`, as in the design's search results. */
function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className={styles.mark}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Whether the desktop app has an update waiting: the dot beside Updates in the list. */
function useUpdateReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void window.electronAPI
      ?.getUpdateStatus?.()
      .then((s) => setReady(!!s.info))
      .catch(() => undefined);
  }, []);
  return ready;
}

/**
 * Settings as a full page with a list of pages, search and direct links
 * (design/screens/settings-structure.md, settings-pages.md).
 */
export function SettingsPage({
  onClose,
  theme,
  onToggleTheme,
  projectId,
  onManageAi,
  onManageAccounts,
  target,
}: SettingsPageProps) {
  const desktop = isDesktop();
  const pages = useMemo(() => SETTINGS_PAGES.filter((p) => !p.desktopOnly || desktop), [desktop]);
  const { data: projects = [] } = useProjects();
  const [page, setPage] = useState<SettingsPageId>(() => {
    const p = startPage(target);
    return pages.some((x) => x.id === p) ? p : 'repositories';
  });
  const [pickedProject, setPickedProject] = useState(projectId ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pendingSetting, setPendingSetting] = useState<string | null>(target?.setting ?? null);
  const [toc, setToc] = useState<{ id: string; label: string }[]>([]);
  const [tocActive, setTocActive] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const updateReady = useUpdateReady();

  const project =
    projects.find((p) => p.id === pickedProject) ?? projects.find((p) => p.id === projectId) ?? projects[0];
  const def = pages.find((p) => p.id === page) ?? pages[0];
  const results = useMemo(() => searchSettings(query, desktop), [query, desktop]);
  const showResults = searchOpen && !!query.trim();

  function go(id: SettingsPageId, setting?: string) {
    setPage(id);
    setPendingSetting(setting ?? null);
    localStorage.setItem(LAST_PAGE_KEY, id);
    syncUrl(id);
    if (!setting) contentRef.current?.scrollTo({ top: 0 });
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
      window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, 700);
      el.classList.remove(styles.flash);
      void el.offsetWidth;
      el.classList.add(styles.flash);
    }, 150);
    return () => window.clearTimeout(t);
  }, [pendingSetting, page]);

  // Esc returns to the board; "/" focuses the search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName ?? '') || !!el?.isContentEditable;
      if (e.key === 'Escape' && !typing) {
        if (pickerOpen) setPickerOpen(false);
        else if (!document.querySelector('[role="dialog"]')) onClose();
      }
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pickerOpen]);

  // Close the project menu and the search results on a click elsewhere
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (pickerRef.current && !pickerRef.current.contains(t)) setPickerOpen(false);
      if (searchWrapRef.current && !searchWrapRef.current.contains(t)) setSearchOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // "On this page": every section card of the page, rebuilt as the page loads its parts
  const readToc = useCallback(() => {
    const els = mainRef.current?.querySelectorAll<HTMLElement>('[data-toc]') ?? [];
    const next: { id: string; label: string }[] = [];
    els.forEach((el, i) => {
      const label = el.dataset.toc;
      if (!label) return;
      if (!el.id) el.id = `st-sec-${i}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      next.push({ id: el.id, label });
    });
    setToc((prev) =>
      prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.label === next[i].label)
        ? prev
        : next,
    );
  }, []);

  useEffect(() => {
    readToc();
    const main = mainRef.current;
    if (!main) return;
    let raf = 0;
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(readToc);
    });
    obs.observe(main, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [readToc, page, project?.id]);

  // The section being read is the last one whose top has passed the top of the content
  useEffect(() => {
    const box = contentRef.current;
    if (!box) return;
    function onScroll() {
      if (!box) return;
      const top = box.getBoundingClientRect().top + 24;
      let current = toc[0]?.id ?? null;
      for (const t of toc) {
        const el = document.getElementById(t.id);
        if (el && el.getBoundingClientRect().top <= top) current = t.id;
      }
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4 && toc.length) current = toc[toc.length - 1].id;
      setTocActive(current);
    }
    onScroll();
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, [toc]);

  function jumpTo(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setTocActive(id);
    // Parts of a page load while it scrolls and push the section down; land on it once they have
    window.setTimeout(() => {
      const box = contentRef.current;
      if (!box) return;
      const off = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      if (Math.abs(off - 16) > 8) el.scrollIntoView({ block: 'start', behavior: 'instant' });
    }, 700);
  }

  /** Arrow keys, Home and End move between the projects of the open menu; Esc closes it. */
  function onPickerKey(e: React.KeyboardEvent) {
    const items = Array.from(pickerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (i: number) => items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pickerOpen) {
        setPickerOpen(true);
        return;
      }
      focus(at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' && pickerOpen) {
      e.preventDefault();
      focus(0);
    } else if (e.key === 'End' && pickerOpen) {
      e.preventDefault();
      focus(items.length - 1);
    } else if (e.key === 'Escape' && pickerOpen) {
      e.preventDefault();
      e.stopPropagation();
      setPickerOpen(false);
      pickerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (e.key === 'Tab' && pickerOpen) {
      setPickerOpen(false);
    }
  }

  // Opening the project menu puts the focus on the project in use
  useEffect(() => {
    if (pickerOpen)
      pickerRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus();
  }, [pickerOpen]);

  function open(entry: SettingEntry) {
    go(entry.page, entry.id);
    setQuery('');
    setSearchOpen(false);
    searchRef.current?.blur();
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
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
        <>
          <ProjectRepoRow project={project} />
          <div className={styles.pageNote}>Other projects: switch project at the top of the list.</div>
        </>
      ) : null;
      break;
    case 'docs':
      body = project ? (
        <>
          <DocsSettingsRow project={project} />
          {project.docsEnabled !== false && (
            <SettingsCard
              title="AI in Docs"
              hint="Ask the docs, the page AI menu, Check this page and Docs health."
              setting="docs-ai"
            >
              <DocsAiSettings project={project} />
            </SettingsCard>
          )}
        </>
      ) : null;
      break;
    case 'ai':
      body = project ? (
        <AiSettingsSection projectId={project.id} onManage={onManageAi} onManageAccounts={onManageAccounts} />
      ) : null;
      break;
    case 'assistant':
      body = project ? (
        <div className="ai-root" data-setting="assistant">
          <AssistSettings projectId={project.id} onOpenAudit={onManageAi} />
        </div>
      ) : null;
      break;
    case 'ideas':
      body = project ? <IdeaSpaceSettings projectId={project.id} onManageAi={onManageAi} /> : null;
      break;
    case 'appearance':
      body = <AppearanceSection theme={theme} onToggleTheme={onToggleTheme} />;
      break;
    case 'notifications':
      body = <NotificationsSettings />;
      break;
    case 'storage':
      body = <StoragePage />;
      break;
    case 'integrations':
      body = (
        <>
          <McpIntegrations />
          <McpFullControl />
          <DiagramSettingsSection />
        </>
      );
      break;
    case 'updates':
      body = <UpdateSettingsSection />;
      break;
    case 'diagnostics':
      body = <DiagnosticsPage />;
      break;
  }

  const navItem = (p: (typeof pages)[number]) => {
    const on = p.id === def.id;
    return (
      <button
        key={p.id}
        type="button"
        className={`${styles.navItem} ${on ? styles.navItemActive : ''}`}
        aria-current={on ? 'page' : undefined}
        onClick={() => go(p.id)}
      >
        <SIcon d={ICONS[PAGE_ICON[p.id]]} />
        <span className={styles.navLabel}>{p.label}</span>
        {p.id === 'updates' && updateReady && <span className={styles.navDot} title="An update is ready" />}
      </button>
    );
  };

  const projectPicker = (
    <div className={styles.picker} ref={pickerRef} onKeyDown={onPickerKey}>
      <button
        type="button"
        className={styles.pickerBtn}
        aria-haspopup="listbox"
        aria-expanded={pickerOpen}
        aria-label={`Project to edit: ${project?.name ?? 'none'}`}
        onClick={() => setPickerOpen((o) => !o)}
        disabled={!projects.length}
      >
        <span className={styles.projDot} style={{ background: project?.color ?? '#AACC2E' }} />
        <span className={styles.pickerName}>{project?.name ?? 'No project'}</span>
        {project && <span className={styles.pickerKey}>{project.prefix}</span>}
        <SIcon d={ICONS.chevronDown} size={14} stroke="#5B6B60" />
      </button>
      {pickerOpen && (
        <div className={styles.menu} role="listbox" aria-label="Projects">
          {projects.map((p) => {
            const on = p.id === project?.id;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={on}
                className={`${styles.menuItem} ${on ? styles.menuItemActive : ''}`}
                onClick={() => {
                  setPickedProject(p.id);
                  setPickerOpen(false);
                }}
              >
                <span className={styles.projDot} style={{ background: p.color ?? '#AACC2E' }} />
                <span>{p.name}</span>
                {on && <SIcon d={ICONS.check} size={14} stroke="#2E6F40" width={2} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.page} role="region" aria-label="Settings" data-testid="settings-page">
      <div className={styles.topbar}>
        <button type="button" className={styles.btn} onClick={onClose}>
          <SIcon d={ICONS.back} size={14} />
          Back to board
        </button>
        <h2 className={styles.pageHeading}>Settings</h2>
        <span className={styles.spacer} />
        <div className={styles.searchWrap} ref={searchWrapRef}>
          <div className={styles.searchBox}>
            <SIcon d={ICONS.search} size={15} stroke="#5B6B60" />
            <input
              ref={searchRef}
              className={styles.searchInput}
              type="search"
              placeholder="Search settings"
              aria-label="Search settings"
              aria-expanded={showResults}
              aria-controls="settings-search-results"
              value={query}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                setSearchOpen(true);
              }}
              onKeyDown={onSearchKey}
            />
            {query.trim() ? (
              <span className={styles.searchCount}>
                {results.length} {results.length === 1 ? 'result' : 'results'}
              </span>
            ) : (
              <span className={styles.kbd}>/</span>
            )}
          </div>
          {showResults && (
            <div className={styles.results} id="settings-search-results">
              {results.length === 0 ? (
                <div className={styles.noResults}>
                  <div className={styles.noResultsTitle}>No setting matches “{query.trim()}”</div>
                  <div className={styles.hint}>Try a shorter word, or one of these:</div>
                  <div className={styles.suggestions}>
                    {SUGGESTIONS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={styles.pill}
                        onClick={() => {
                          setQuery(w);
                          setActive(0);
                          searchRef.current?.focus();
                        }}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.resultList} role="listbox" aria-label="Settings found">
                    {results.map((r, i) => (
                      <button
                        key={`${r.id}-${r.name}`}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        className={`${styles.result} ${i === active ? styles.resultActive : ''}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => open(r)}
                      >
                        <span className={styles.resultIcon}>
                          <SIcon d={ICONS[PAGE_ICON[r.page]]} size={15} />
                        </span>
                        <span className={styles.resultText}>
                          <span className={styles.resultWhere}>{where(r)}</span>
                          <span className={styles.resultName}>
                            <Highlight text={r.name} query={query} />
                          </span>
                          <span className={styles.resultDesc}>{r.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className={styles.resultsFoot} aria-hidden="true">
                    <span className={styles.kbd}>↑</span>
                    <span className={styles.kbd}>↓</span> move
                    <span className={styles.kbd}>Enter</span> open
                    <span className={styles.kbd}>Esc</span> clear
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <NotificationBellButton />
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
          <div className={styles.navList}>{pages.filter((p) => p.scope === 'project').map(navItem)}</div>
          <div className={styles.navGroup} style={{ marginTop: 6 }}>
            App settings <span className={styles.navGroupNote}>all projects</span>
          </div>
          <div className={styles.navList}>{pages.filter((p) => p.scope === 'app').map(navItem)}</div>
        </nav>
        <div className={styles.content} ref={contentRef}>
          <div className={styles.contentRow}>
            <div className={styles.main} ref={mainRef} key={`${def.id}-${project?.id ?? ''}`}>
              <div className={styles.pageHead}>
                <div className={styles.pageTitleRow}>
                  <h1 className={styles.pageTitle}>{def.title}</h1>
                  <span className={styles.scopeChip}>
                    {def.scope === 'project' ? `Project${project ? ` · ${project.name}` : ''}` : 'App'}
                  </span>
                </div>
                <p className={styles.pageSummary}>{def.summary}</p>
              </div>
              {toc.length > 1 && (
                <nav className={styles.tocInline} aria-label="On this page (narrow window)">
                  <span className={styles.tocInlineLabel}>On this page</span>
                  {toc.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`${styles.pill} ${tocActive === t.id ? styles.pillOn : ''}`}
                      onClick={() => jumpTo(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </nav>
              )}
              <div className={styles.sections}>{body}</div>
            </div>
            {toc.length > 1 && (
              <nav className={styles.toc} aria-label="On this page">
                <div className={styles.tocLabel}>On this page</div>
                {toc.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`${styles.tocItem} ${tocActive === t.id ? styles.tocItemActive : ''}`}
                    aria-current={tocActive === t.id ? 'location' : undefined}
                    onClick={() => jumpTo(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Appearance › Theme: the two looks side by side, the one in use marked (F: App › Appearance). */
function AppearanceSection({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const looks = [
    {
      id: 'default' as const,
      name: 'Color',
      hint: 'The default look.',
      swatches: ['#253D2C', '#2E6F40', '#68BA7F', '#F6FAF7'],
    },
    {
      id: 'bw' as const,
      name: 'Black & white (TV mode)',
      hint: 'High contrast, no colour.',
      swatches: ['#111111', '#555555', '#BBBBBB', '#FFFFFF'],
    },
  ];
  const current = theme === 'default' ? 'default' : 'bw';
  return (
    <SettingsCard title="Theme" hint="How the app looks on this computer." setting="theme" status={status}>
      <div className={styles.themes} role="radiogroup" aria-label="Theme">
        {looks.map((l) => {
          const on = l.id === current;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`${styles.themeCard} ${on ? styles.themeCardOn : ''}`}
              onClick={() => {
                if (on) return;
                onToggleTheme();
                setStatus({ ok: true, text: 'Saved' });
              }}
            >
              <span className={styles.swatches} aria-hidden="true">
                {l.swatches.map((c) => (
                  <span key={c} style={{ background: c }} />
                ))}
              </span>
              <span className={styles.themeName}>
                <b>{l.name}</b>
                {on && <SIcon d={ICONS.checkCircle} size={16} stroke="#2E6F40" width={2.2} />}
              </span>
              <span className={styles.hint}>{l.hint}</span>
            </button>
          );
        })}
      </div>
    </SettingsCard>
  );
}
