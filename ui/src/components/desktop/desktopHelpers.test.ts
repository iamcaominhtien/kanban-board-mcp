import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_GROUPS,
  filterShortcuts,
  formatKeys,
  releaseNotesFor,
  reportIssueText,
  reportIssueUrl,
  type AppInfo,
} from './desktopHelpers';

const info: AppInfo = {
  appName: 'Kanban Board',
  version: '3.15.0',
  backendRunning: true,
  osName: 'macOS',
  osVersion: '24.1.0',
  arch: 'arm64',
  electron: '39.8.5',
  chrome: '140',
  language: 'en',
  window: [1400, 900],
};

describe('formatKeys', () => {
  it('writes Ctrl Shift N elsewhere and ⇧ ⌘ N on a Mac', () => {
    expect(formatKeys(['Mod', 'Shift', 'N'], false)).toEqual(['Ctrl', 'Shift', 'N']);
    expect(formatKeys(['Mod', 'Shift', 'N'], true)).toEqual(['⇧', '⌘', 'N']);
    expect(formatKeys(['Mod', 'Alt', 'N'], true)).toEqual(['⌥', '⌘', 'N']);
    expect(formatKeys(['Mod', 'Enter'], true)).toEqual(['⌘', '⏎']);
  });
});

describe('filterShortcuts', () => {
  it('finds a command by name, by key and by where it works', () => {
    const names = (q: string) => filterShortcuts(SHORTCUT_GROUPS, q, false).flatMap((g) => g.items.map((i) => i.id));
    expect(names('ask ai')).toContain('ask-ai');
    expect(names('ctrl shift n')).toContain('new-idea');
    expect(names('idea inbox')).toContain('triage-keep');
    expect(names('zzzz')).toEqual([]);
  });
  it('keeps every group for an empty search', () => {
    expect(filterShortcuts(SHORTCUT_GROUPS, '  ', false)).toBe(SHORTCUT_GROUPS);
  });
});

describe('releaseNotesFor', () => {
  const log = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [3.15.0] - 2026-10-30',
    '',
    'Menu.',
    '',
    '### Added',
    '- one',
    '',
    '---',
    '',
    '## [3.14.0] - 2026-10-29',
    'Old.',
  ].join('\n');
  it('returns the notes of one version without its heading', () => {
    const notes = releaseNotesFor(log, '3.15.0');
    expect(notes?.date).toBe('2026-10-30');
    expect(notes?.body).toBe('Menu.\n\n### Added\n- one');
  });
  it('returns null for a version that is not there', () => {
    expect(releaseNotesFor(log, '9.9.9')).toBeNull();
  });
});

describe('report an issue', () => {
  it('lists versions and system facts only', () => {
    const text = reportIssueText(info);
    expect(text).toContain('App 3.15.0');
    expect(text).toContain('macOS 24.1.0 (arm64)');
    expect(text).toContain('Window 1400 × 900');
  });
  it('opens a new issue of this project', () => {
    const url = new URL(reportIssueUrl(info));
    expect(url.origin + url.pathname).toBe('https://github.com/iamcaominhtien/kanban-board-mcp/issues/new');
    expect(url.searchParams.get('body')).toContain('About my setup');
  });
});
