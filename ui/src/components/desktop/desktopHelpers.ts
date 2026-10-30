import shortcutData from '../shortcuts/shortcuts.json';

export const REPO_URL = 'https://github.com/iamcaominhtien/kanban-board-mcp';
export const RELEASES_URL = `${REPO_URL}/releases`;

export interface Shortcut {
  id: string;
  label: string;
  keys: string[];
  where: string;
  source: string;
}
export interface ShortcutGroup {
  id: string;
  title: string;
  items: Shortcut[];
}

/** The one list of shortcuts (the guide's shortcut sheet is built from the same file). */
export const SHORTCUT_GROUPS: ShortcutGroup[] = shortcutData.groups;

/** Facts about the app and the computer: versions and system only. */
export interface AppInfo {
  appName: string;
  version: string;
  backendRunning: boolean;
  osName: string;
  osVersion: string;
  arch: string;
  electron: string;
  chrome: string;
  language: string;
  window?: number[] | null;
}

const MAC_KEYS: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃', Enter: '⏎' };

/**
 * The keys of a shortcut as the platform writes them.
 * @param keys - Keys as in shortcuts.json (`Mod` is Ctrl, or ⌘ on a Mac).
 * @param mac - True on a Mac.
 * @returns One string per key cap, in the order to press them (⌘ ⇧ N on a Mac, Ctrl Shift N elsewhere).
 */
export function formatKeys(keys: string[], mac: boolean): string[] {
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift'];
  const mods = keys.filter((k) => order.includes(k));
  const rest = keys.filter((k) => !order.includes(k));
  // a Mac writes ⌃ ⌥ ⇧ ⌘ then the key; elsewhere the usual Ctrl Alt Shift
  const sorted = mac ? ['Ctrl', 'Alt', 'Shift', 'Mod'] : ['Mod', 'Ctrl', 'Alt', 'Shift'];
  const ordered = sorted.filter((m) => mods.includes(m));
  return [...ordered, ...rest].map((k) => (k === 'Mod' ? (mac ? '⌘' : 'Ctrl') : mac ? (MAC_KEYS[k] ?? k) : k));
}

/** Shortcuts that match a search, by name, key or where they work. An empty search keeps every group. */
export function filterShortcuts(groups: ShortcutGroup[], query: string, mac: boolean): ShortcutGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) =>
        [i.label, i.where, g.title, formatKeys(i.keys, mac).join(' '), i.keys.join(' ')].join(' ').toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

export interface ReleaseNotes {
  version: string;
  date: string | null;
  body: string;
}

/**
 * The part of the changelog for one version.
 * @param changelog - The text of CHANGELOG.md.
 * @param version - For example `3.15.0`.
 * @returns The notes without their heading, or null when the version is not in the changelog.
 */
export function releaseNotesFor(changelog: string, version: string): ReleaseNotes | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end < 0) end = lines.length;
  const date = /\]\s*-\s*(\d{4}-\d{2}-\d{2})/.exec(lines[start])?.[1] ?? null;
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/\n-{3,}\s*$/, '')
    .trim();
  return { version, date, body };
}

/** The text a bug report starts with: what will be filled in, shown to the person before anything is opened. */
export function reportIssueText(info: AppInfo): string {
  const win = info.window && info.window.length === 2 ? `${info.window[0]} × ${info.window[1]}` : 'unknown';
  return [
    '**What happened**',
    '',
    '',
    '**What I expected**',
    '',
    '',
    '**Steps**',
    '1. ',
    '',
    '**About my setup**',
    `- App ${info.version} · Backend ${info.backendRunning ? 'running' : 'not running'}`,
    `- ${info.osName} ${info.osVersion} (${info.arch}) · Electron ${info.electron}`,
    `- Window ${win} · Language ${info.language}`,
  ].join('\n');
}

/** The address of a new GitHub issue with the report text filled in. Opening it sends nothing by itself. */
export function reportIssueUrl(info: AppInfo): string {
  const params = new URLSearchParams({ template: 'bug_report.md', body: reportIssueText(info) });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

/** The diagnostics as one block of text (the same facts as Help › Copy Diagnostics Info). */
export function diagnosticsText(info: AppInfo): string {
  return [
    `${info.appName} ${info.version}`,
    `Backend: ${info.backendRunning ? 'running' : 'not running'}`,
    `System: ${info.osName} ${info.osVersion} (${info.arch})`,
    `Electron ${info.electron} · Chromium ${info.chrome}`,
    `Language: ${info.language}`,
  ].join('\n');
}
