export type SettingsScope = 'project' | 'app';

export type SettingsPageId =
  | 'repositories'
  | 'docs'
  | 'ai'
  | 'assistant'
  | 'ideas'
  | 'appearance'
  | 'storage'
  | 'integrations'
  | 'updates'
  | 'diagnostics';

export interface SettingsPageDef {
  id: SettingsPageId;
  scope: SettingsScope;
  label: string;
  title: string;
  summary: string;
  /** Only shown in the desktop app. */
  desktopOnly?: boolean;
}

/** The pages in list order (design/screens/settings-structure.md, C). */
export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    id: 'repositories',
    scope: 'project',
    label: 'Repositories',
    title: 'Repositories',
    summary: 'Git settings for this project.',
  },
  {
    id: 'docs',
    scope: 'project',
    label: 'Docs',
    title: 'Docs',
    summary: 'Turn Docs on or off and choose who can edit pages.',
  },
  {
    id: 'ai',
    scope: 'project',
    label: 'AI',
    title: 'AI',
    summary: 'Who answers for this project, and how far AI may go.',
  },
  {
    id: 'assistant',
    scope: 'project',
    label: 'Board assistant',
    title: 'Board assistant',
    summary: 'How the board assistant behaves in this project.',
  },
  {
    id: 'ideas',
    scope: 'project',
    label: 'Idea Space',
    title: 'Idea Space',
    summary: 'AI helpers and what they may use.',
  },
  { id: 'appearance', scope: 'app', label: 'Appearance', title: 'Appearance', summary: 'How the app looks.' },
  {
    id: 'storage',
    scope: 'app',
    label: 'Storage & backup',
    title: 'Storage & backup',
    summary: 'Where your data lives and how to back it up.',
  },
  {
    id: 'integrations',
    scope: 'app',
    label: 'Integrations',
    title: 'Integrations',
    summary: 'Connect other tools and services.',
  },
  { id: 'updates', scope: 'app', label: 'Updates', title: 'Updates', summary: 'Desktop app only.', desktopOnly: true },
  {
    id: 'diagnostics',
    scope: 'app',
    label: 'Diagnostics',
    title: 'Diagnostics',
    summary: 'Help when something goes wrong.',
  },
];

export interface SettingEntry {
  /** Anchor id: the element with `data-setting="<id>"` on its page. */
  id: string;
  page: SettingsPageId;
  /** Section inside the page, shown in search results. */
  section: string;
  name: string;
  description: string;
  /** Extra words people may type. */
  keywords?: string;
}

/** Every setting, for search and direct links. */
export const SETTINGS_INDEX: SettingEntry[] = [
  {
    id: 'idea-ai-enable',
    page: 'ideas',
    section: 'AI help in Idea Space',
    name: 'AI help in Idea Space',
    description: 'Turn the optional helpers (triage advice, shaping, ask, weekly grooming) on or off.',
    keywords: 'ideas triage advice grooming digest shape',
  },
  {
    id: 'idea-ai-member',
    page: 'ideas',
    section: 'Who and what it may use',
    name: 'What the idea helpers may read',
    description: 'Docs, tickets and the linked repository (read only).',
    keywords: 'ideas repository docs read',
  },
  {
    id: 'idea-ai-cap',
    page: 'ideas',
    section: 'Cost',
    name: 'Daily cap for Idea Space',
    description: 'How much the idea helpers may cost in a day.',
    keywords: 'ideas budget money limit',
  },
  {
    id: 'repo-path',
    page: 'repositories',
    section: 'Git',
    name: 'Repository path',
    description: 'Where branches created on a ticket are made.',
    keywords: 'git repo link unlink',
  },
  {
    id: 'worktree',
    page: 'repositories',
    section: 'Git',
    name: 'Worktree path template',
    description: 'Where new worktrees are created, and whether to create one by default.',
    keywords: 'branch folder',
  },
  {
    id: 'docs-enabled',
    page: 'docs',
    section: 'Docs',
    name: 'Docs on or off',
    description: 'Turn Docs on or off for the project.',
    keywords: 'pages wiki',
  },
  {
    id: 'docs-edit-policy',
    page: 'docs',
    section: 'Docs',
    name: 'Who can edit pages',
    description: 'Everyone, members or admins only. Everyone in the project can read published pages.',
    keywords: 'permission role viewer member admin access',
  },
  {
    id: 'board-ai',
    page: 'ai',
    section: 'Board AI',
    name: 'Board AI',
    description: 'Answers board-wide requests: chat, ticket drafting and suggestions.',
    keywords: 'chatbot assistant provider',
  },
  {
    id: 'safe-mode',
    page: 'ai',
    section: 'Safety',
    name: 'Safe mode',
    description: 'AI members may only read and comment; every other action is blocked.',
    keywords: 'read only',
  },
  {
    id: 'ai-limits',
    page: 'ai',
    section: 'Limits and budgets',
    name: 'Board daily cap and monthly budget',
    description: 'Caps for the whole board.',
    keywords: 'budget cost money spend limit',
  },
  {
    id: 'ai-limits',
    page: 'ai',
    section: 'Limits and budgets',
    name: 'Max chain depth',
    description: 'How many times an AI may hand work to another AI.',
    keywords: 'handoff',
  },
  {
    id: 'ai-limits',
    page: 'ai',
    section: 'Limits and budgets',
    name: 'Runs per ticket a day',
    description: 'How often AI may work on one ticket in a day.',
    keywords: 'runs limit',
  },
  {
    id: 'ai-limits',
    page: 'ai',
    section: 'Limits and budgets',
    name: 'Approvals expire after',
    description: 'How long an approval request waits.',
    keywords: 'expiry timeout',
  },
  {
    id: 'assistant',
    page: 'assistant',
    section: 'Assistant',
    name: 'Assistant features, language, tone and instructions',
    description: 'Controls the board assistant, including what it may see.',
    keywords: 'privacy language tone prompt',
  },
  {
    id: 'theme',
    page: 'appearance',
    section: 'Theme',
    name: 'Theme',
    description: 'Color or black & white (TV mode).',
    keywords: 'dark light color contrast',
  },
  {
    id: 'data-folder',
    page: 'storage',
    section: 'Data folder',
    name: 'Data folder',
    description: 'Where tickets, attachments and the database are stored.',
    keywords: 'path move location database',
  },
  {
    id: 'workspace',
    page: 'storage',
    section: 'Workspace',
    name: 'Workspace',
    description: 'A local scratch folder per ticket, its root path and retention.',
    keywords: 'retention sweep scratch clean',
  },
  {
    id: 'export',
    page: 'storage',
    section: 'Import and export',
    name: 'Export data',
    description: 'Export all data as a ZIP.',
    keywords: 'backup zip download',
  },
  {
    id: 'import',
    page: 'storage',
    section: 'Import and export',
    name: 'Import data',
    description: 'Restore from a ZIP. Replaces all current data.',
    keywords: 'restore backup zip',
  },
  {
    id: 'mcp',
    page: 'integrations',
    section: 'MCP integrations',
    name: 'MCP integrations',
    description: 'Let AI coding tools use your boards: Claude Code, Antigravity.',
    keywords: 'claude code antigravity install tools',
  },
  {
    id: 'drawio',
    page: 'integrations',
    section: 'Diagrams (draw.io)',
    name: 'Diagrams (draw.io)',
    description: 'The editor used to draw diagrams in tickets and Docs.',
    keywords: 'diagram editor address host',
  },
  {
    id: 'updates',
    page: 'updates',
    section: 'Updates',
    name: 'Check for updates',
    description: 'Installed version and available updates.',
    keywords: 'version release upgrade',
  },
  {
    id: 'logs',
    page: 'diagnostics',
    section: 'Application logs',
    name: 'Application logs',
    description: 'Export the app log to share when something goes wrong.',
    keywords: 'export log level debug',
  },
];

/** Entries whose name, description, section or keywords contain every word typed. */
export function searchSettings(query: string, includeDesktopOnly: boolean): SettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const desktopOnly = new Set(SETTINGS_PAGES.filter((p) => p.desktopOnly).map((p) => p.id));
  return SETTINGS_INDEX.filter((e) => {
    if (!includeDesktopOnly && desktopOnly.has(e.page)) return false;
    const hay = `${e.name} ${e.description} ${e.section} ${e.keywords ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Narrows a string (e.g. from the address) to a page id. */
export function isSettingsPageId(v: string | null | undefined): v is SettingsPageId {
  return SETTINGS_PAGES.some((p) => p.id === v);
}
