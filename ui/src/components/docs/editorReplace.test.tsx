// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildExtensions } from './editor/extensions';
import { createEditorReplaceAdapter, findInDoc, setActiveReplaceAdapter } from './editorReplace';
import { FindInPage, openDocsFind, useDocsFindHotkey } from './FindInPage';
import { useState } from 'react';

let editor: Editor | null = null;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

function make(): Editor {
  editor = new Editor({
    extensions: buildExtensions({ isTicket: () => false, onLink: () => {} }),
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'It was the ' },
            { type: 'text', text: 'sa', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'lt road, never much salt. Salty air.' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The salt traders; ' },
            { type: 'text', text: 'salt', marks: [{ type: 'code' }] },
          ],
        },
      ],
    },
  });
  document.body.appendChild(editor.view.dom);
  return editor;
}

afterEach(() => {
  cleanup();
  setActiveReplaceAdapter(undefined);
  editor?.view.dom.remove();
  editor?.destroy();
  editor = null;
  localStorage.clear();
});

describe('find in the editor', () => {
  it('finds across bold, skips inline code, honours case and whole word', () => {
    const ed = make();
    const text = (m: { from: number; to: number }) => ed.state.doc.textBetween(m.from, m.to);
    const all = findInDoc(ed.state.doc, 'salt', { matchCase: false, wholeWord: false });
    expect(all.map(text)).toEqual(['salt', 'salt', 'Salt', 'salt']);
    expect(findInDoc(ed.state.doc, 'salt', { matchCase: true, wholeWord: false })).toHaveLength(3);
    expect(findInDoc(ed.state.doc, 'salt', { matchCase: false, wholeWord: true })).toHaveLength(3);
  });

  it('replaces the current match and all of them in one step each', () => {
    const ed = make();
    const a = createEditorReplaceAdapter(() => ed);
    const o = { matchCase: false, wholeWord: true, all: false, index: 1 };
    expect(a.replace('salt', 'brine', o)).toBe(1);
    expect(ed.state.doc.child(0).textContent).toBe('It was the salt road, never much brine. Salty air.');
    expect(a.replace('salt', 'brine', { ...o, all: true })).toBe(2);
    expect(ed.state.doc.textContent).not.toMatch(/\bsalt\b(?! *$)/);
    a.undo?.();
    expect(ed.state.doc.child(0).textContent).toContain('the salt road');
  });
});

describe('the find bar on an editor', () => {
  it('counts, says No results, opens the replace row and reports Replace all with Undo', async () => {
    const ed = make();
    const adapter = createEditorReplaceAdapter(() => ed);
    setActiveReplaceAdapter(adapter);
    function Host() {
      const [open, setOpen] = useState(false);
      useDocsFindHotkey(() => setOpen(true), open);
      return open ? (
        <FindInPage
          root={ed.view.dom as HTMLElement}
          editable
          replaceAdapter={adapter}
          onClose={() => setOpen(false)}
        />
      ) : null;
    }
    render(<Host />);
    act(() => openDocsFind(false));
    const find = await screen.findByRole('textbox', { name: 'Find' });
    expect(screen.queryByRole('textbox', { name: 'Replace with' })).toBeNull();
    fireEvent.change(find, { target: { value: 'salt' } });
    await screen.findByText('1 of 4');
    fireEvent.change(find, { target: { value: 'saltt' } });
    await screen.findByText('No results');
    fireEvent.change(find, { target: { value: 'salt' } });
    await screen.findByText('1 of 4');
    // Ctrl+H shows the replace row of the open bar
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true });
    const replace = await screen.findByRole('textbox', { name: 'Replace with' });
    fireEvent.click(screen.getByRole('button', { name: 'Whole word' }));
    await screen.findByText('1 of 3');
    fireEvent.change(replace, { target: { value: 'brine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    await screen.findByText('Replaced 3 matches');
    expect(ed.state.doc.textContent).toContain('the brine road');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(ed.state.doc.textContent).toContain('the salt road');
    expect(screen.queryByText('Replaced 3 matches')).toBeNull();
  });

  it('Ctrl+H opens the bar with the replace row while a page is edited', async () => {
    const ed = make();
    const adapter = createEditorReplaceAdapter(() => ed);
    setActiveReplaceAdapter(adapter);
    function Host() {
      const [open, setOpen] = useState(false);
      useDocsFindHotkey(() => setOpen(true), open);
      return open ? (
        <FindInPage
          root={ed.view.dom as HTMLElement}
          editable
          replaceAdapter={adapter}
          onClose={() => setOpen(false)}
        />
      ) : null;
    }
    render(<Host />);
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true });
    await screen.findByRole('textbox', { name: 'Replace with' });
  });
});
