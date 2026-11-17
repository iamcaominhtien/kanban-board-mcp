// @vitest-environment jsdom
import { Editor, type JSONContent } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from '../extensions';
import { MenuHost, type MenuState } from '../menuHost';
import { SLASH_GROUPS, SLASH_ITEMS, filterSlash, recentSlashIds, rememberSlash, type SlashItem } from '../slashItems';
import { useMenuPosition } from '../SlashMenu';
import { InsertCatalog } from './InsertCatalog';

const ids = (items: SlashItem[]) => items.map((i) => i.id);

describe('the catalog search', () => {
  it('keeps every block the slash menu had, under the catalog groups', () => {
    for (const id of [
      'h1',
      'h2',
      'h3',
      'bullet',
      'number',
      'task',
      'quote',
      'divider',
      'code',
      'table',
      'callout-info',
      'callout-warning',
      'callout-success',
      'ai',
      'image',
      'file',
      'sketch',
      'canvas',
      'diagram',
      'diagram-import',
      'toc',
      'ticket',
      'page',
    ]) {
      expect(SLASH_ITEMS.some((i) => i.id === id)).toBe(true);
    }
    for (const i of SLASH_ITEMS) expect(SLASH_GROUPS).toContain(i.group);
    // the new blocks
    for (const id of [
      'h4',
      'pullquote',
      'columns',
      'columns3',
      'scene',
      'callout-danger',
      'callout-note',
      'callout-custom',
      'formula',
    ]) {
      expect(SLASH_ITEMS.some((i) => i.id === id)).toBe(true);
    }
  });

  it('lists everything in the order of the groups when nothing is typed', () => {
    const all = filterSlash('');
    const ranks = all.map((i) => SLASH_GROUPS.indexOf(i.group));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(all[0].id).toBe('h1');
  });

  it('finds blocks by name first, then by words and shortcuts', () => {
    expect(ids(filterSlash('tab')).slice(0, 2)).toEqual(['table', 'toc']);
    expect(filterSlash('h1')[0].id).toBe('h1');
    expect(filterSlash('callout')[0].id).toBe('callout-info');
    expect(ids(filterSlash('pdf'))).toContain('file');
    expect(ids(filterSlash('boxes'))).toContain('diagram');
    expect(filterSlash('```')[0].id).toBe('code');
    expect(filterSlash('columns')[0].id).toBe('columns');
    expect(filterSlash('zzz')).toEqual([]);
  });

  it('puts the editor AI menu and the Docs rows under AI for "/ai"', () => {
    const items = filterSlash('ai', { ai: { run: () => {}, docs: true } });
    expect(items[0].id).toBe('ai');
    expect(items.every((i) => i.group === 'AI' || i.group === 'Docs only')).toBe(true);
  });

  it('remembers the last blocks inserted, newest first', () => {
    window.localStorage.clear();
    rememberSlash('table');
    rememberSlash('image');
    rememberSlash('table');
    expect(recentSlashIds()).toEqual(['table', 'image']);
  });
});

describe('the catalog on a desktop', () => {
  let editor: Editor;
  beforeEach(() => {
    window.localStorage.clear();
    editor = new Editor({
      extensions: buildExtensions({ isTicket: () => false, onLink: () => {} }),
      content: '<p>/</p>',
    });
  });
  afterEach(() => {
    cleanup();
    editor.destroy();
  });

  function show(query: string, run = vi.fn()) {
    const host = new MenuHost();
    const state: MenuState = {
      editor: editor as never,
      range: { from: 1, to: 2 + query.length },
      query,
      lineBefore: '',
      rect: new DOMRect(10, 10, 1, 16),
      run,
    };
    render(
      <InsertCatalog
        host={host}
        state={state}
        ctx={{
          pickImage: () => {},
          newDiagram: () => {},
          newSketch: () => {},
          newCanvas: () => {},
          importDiagram: () => {},
          ticketPrefix: 'KAN',
          pageTitle: 'P',
        }}
        usePosition={useMenuPosition}
      />,
    );
    return { host, run };
  }

  it('shows the group rail and selects the first block', () => {
    show('');
    expect(screen.getByRole('listbox', { name: 'Insert block' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Tables & layout' })).toBeTruthy();
    const first = screen.getAllByRole('option')[0];
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(first.textContent).toContain('Heading 1');
  });

  it('narrows the list as you type and inserts the first match on Enter', () => {
    const { host, run } = show('tab');
    expect(screen.getByText('Blocks matching "tab"')).toBeTruthy();
    expect(screen.getAllByRole('option')[0].textContent).toContain('Table');
    act(() => {
      host.keyHandler?.(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    act(() => {
      host.keyHandler?.(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect((run.mock.calls[0][0] as SlashItem).id).toBe('toc');
  });

  it('asks for the size of a table, then inserts the size picked', () => {
    editor.commands.setContent('<p>/table</p>');
    const run = vi.fn((item: SlashItem) =>
      item.run(
        editor as never,
        { from: 1, to: 7 },
        {
          pickImage: () => {},
          newDiagram: () => {},
          newSketch: () => {},
          newCanvas: () => {},
          importDiagram: () => {},
          ticketPrefix: 'KAN',
          pageTitle: 'P',
        },
      ),
    );
    const { host } = show('table', run);
    act(() => {
      host.keyHandler?.(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(screen.getByTestId('table-size')).toBeTruthy();
    expect(screen.getByText('3 columns x 3 rows')).toBeTruthy();
    act(() => {
      host.keyHandler?.(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(screen.getByText('4 columns x 3 rows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }));
    const table = (editor.getJSON() as JSONContent).content?.find((n) => n.type === 'table');
    expect(table?.content).toHaveLength(3);
    expect(table?.content?.[0].content).toHaveLength(4);
    expect(recentSlashIds()[0]).toBe('table');
  });

  it('says when nothing matches', () => {
    show('zzz');
    expect(screen.getByText(/No blocks match "zzz"/)).toBeTruthy();
  });
});
