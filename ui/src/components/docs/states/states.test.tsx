// @vitest-environment jsdom
import type { JSONContent } from '@tiptap/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChoices, mergeBlocks } from '../../../richdoc/merge';
import { blockLabel, changeChips, changeGroup } from './blockInfo';
import { ConflictChooser, canKeepBoth, joinedSummary, KeepMineConfirm } from './ConflictChooser';
import { joinedTitle } from './MergedDialog';
import { fmtSize, PAGE_SIZE_LIMIT, pageBytes, SizeWarningBar, whatTakesSpace } from './PageSize';
import { pageHtmlFile } from './KeepCopyDialog';
import { SaveStatus, saveAnnouncement } from './SaveStatus';
import { WaitingList, waitingRows } from './WaitingList';
import { isSessionEnded, SessionEnded } from './SessionEnded';
import { fixColour, ReadabilityCheck, readabilityIssues } from './Readability';

const p = (id: string, text: string): JSONContent => ({
  type: 'paragraph',
  attrs: { blockId: id },
  content: [{ type: 'text', text }],
});
const img = (id: string, placement: string, caption?: string): JSONContent => ({
  type: 'image',
  attrs: { blockId: id, src: '/uploads/a.png', placement, ...(caption ? { caption } : {}) },
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

afterEach(cleanup);

describe('the save status (Docs states C 13)', () => {
  it('says each of the six states in the board words', () => {
    const at = new Date(2026, 10, 18, 10, 42);
    const views = [
      [{ kind: 'saving' }, 'Saving…'],
      [{ kind: 'saved', at }, 'Saved10:42'],
      [{ kind: 'error' }, 'Not savedRetry'],
      [{ kind: 'offline', waiting: 3 }, 'Offline· 3 changes waiting'],
      [{ kind: 'merging' }, 'Merging…'],
      [{ kind: 'paused' }, 'Paused'],
    ] as const;
    for (const [view, text] of views) {
      const { unmount } = render(<SaveStatus view={view} onRetry={() => {}} />);
      expect(screen.getByTestId('save-state').textContent).toBe(text);
      unmount();
    }
    expect(saveAnnouncement({ kind: 'error' })).toBe(
      'Not saved. Retry is available. Your text is kept in this browser.',
    );
  });

  it('keeps the phone header short and opens the waiting list from Offline', () => {
    const open = vi.fn();
    const { rerender } = render(<SaveStatus view={{ kind: 'offline', waiting: 2 }} onOpenWaiting={open} />);
    fireEvent.click(screen.getByTestId('save-state'));
    expect(open).toHaveBeenCalled();
    rerender(<SaveStatus view={{ kind: 'offline', waiting: 2 }} compact />);
    expect(screen.getByTestId('save-state').textContent).toBe('Offline');
  });
});

describe('block words', () => {
  const page = doc(p('b-1', 'One.'), img('b-2', 'block'), p('b-3', 'Three.'));
  it('numbers a block and names its kind', () => {
    expect(blockLabel(page, 'b-2')).toBe('Block 2 · picture');
    expect(blockLabel(page, 'b-9', p('b-9', 'x'))).toBe('A paragraph');
    expect(changeGroup(img('x', 'block'))).toBe('picture');
  });
  it('names a picture move and a caption change as labels, text as Text changed', () => {
    const chips = changeChips(img('b-2', 'block'), img('b-2', 'floatRight', 'Low tide')).map((c) => c.text);
    expect(chips.some((c) => /→/.test(c))).toBe(true);
    expect(chips).toContain('Caption changed');
    expect(changeChips(p('b-1', 'One.'), p('b-1', 'One, two.')).map((c) => c.text)).toEqual(['Text changed']);
    expect(changeChips(p('b-1', 'One.'), null)[0].text).toBe('Removed');
  });
  it('groups the changes waiting by kind', () => {
    expect(waitingRows([{ node: p('a', '') }, { node: p('b', '') }, { node: img('c', 'block') }])).toEqual([
      { group: 'text', count: 2 },
      { group: 'picture', count: 1 },
    ]);
  });
});

describe('joining and choosing (Docs states E)', () => {
  const base = doc(p('b-1', 'The ferry horn sounded. Forty-one.'), img('b-2', 'block'), p('b-3', 'Three.'));
  const mine = doc(p('b-1', 'The ferry horn sounded. Forty-two.'), img('b-2', 'floatRight'), p('b-3', 'Three.'));
  const theirs = doc(p('b-1', 'The ferry horn sounded. Forty.'), img('b-2', 'center'), p('b-3', 'Three!'));
  const m = mergeBlocks(base, mine, theirs);

  it('summarises what was joined and titles each row', () => {
    expect(m.conflicts.map((c) => c.id)).toEqual(['b-1', 'b-2']);
    expect(m.joined.map((j) => j.id)).toEqual(['b-3']);
    expect(joinedSummary(m.joined, 'Hoa Mai')).toBe('A change by Hoa Mai.');
    expect(joinedTitle(m.joined[0], 'Hoa Mai')).toBe('Hoa Mai changed the paragraph');
    expect(canKeepBoth(m.conflicts[0])).toBe(true);
    expect(canKeepBoth(m.conflicts[1])).toBe(false);
  });

  it('shows both versions of each block, marks the words, and applies the choices', () => {
    const apply = vi.fn();
    render(
      <ConflictChooser
        conflicts={m.conflicts}
        joined={m.joined}
        theirs={{ version: 15, author: 'Hoa Mai', at: '2026-11-18T10:42:00Z' }}
        baseVersion={14}
        mineAt={new Date()}
        me="An Nguyen"
        doc={applyChoices(m, {})}
        layout="desktop"
        onApply={apply}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Two blocks changed in both versions')).toBeTruthy();
    expect(screen.getByTestId('conflict-mine').querySelector('ins')?.textContent).toBe('Forty-two.');
    expect(screen.getByTestId('conflict-count').textContent).toBe('0 of 2 chosen');
    fireEvent.click(screen.getByTestId('conflict-choice-both'));
    fireEvent.click(screen.getByTestId('conflict-next'));
    // a picture is chosen whole: no Keep both
    expect(screen.queryByTestId('conflict-choice-both')).toBeNull();
    fireEvent.click(screen.getByTestId('conflict-choice-theirs'));
    fireEvent.click(screen.getByText('Apply and continue'));
    expect(apply).toHaveBeenCalledWith({ 'b-1': 'both', 'b-2': 'theirs' });
    const out = applyChoices(m, apply.mock.calls[0][0], () => 'b-new');
    expect(out.content?.map((n) => n.attrs?.blockId)).toEqual(['b-1', 'b-new', 'b-2', 'b-3']);
  });

  it('asks before Keep mine replaces her blocks', () => {
    const yes = vi.fn();
    render(
      <KeepMineConfirm
        count={2}
        joinedCount={4}
        who="Hoa Mai"
        version={15}
        pageTitle="Chapter 3"
        onConfirm={yes}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Keep your version of both blocks?')).toBeTruthy();
    expect(screen.getByRole('alertdialog').textContent).toContain('The 4 blocks that were joined for you stay joined.');
    fireEvent.click(screen.getByTestId('keep-mine-yes'));
    expect(yes).toHaveBeenCalled();
  });
});

describe('page size (Docs states G 49, 50)', () => {
  it('measures the page JSON and lists what takes space, largest first', () => {
    const big = { ...img('b-2', 'block'), attrs: { blockId: 'b-2', src: `data:image/png;base64,${'A'.repeat(4000)}` } };
    const d = doc(p('b-1', 'Hello'), big);
    expect(pageBytes(d)).toBe(new TextEncoder().encode(JSON.stringify(d)).length);
    const rows = whatTakesSpace(d);
    expect(rows[0]).toMatchObject({ kind: 'picture', count: 1, largestId: 'b-2' });
    expect(fmtSize(38 * 1024 * 1024)).toBe('38 MB');
    expect(fmtSize(640 * 1024)).toBe('640 KB');
  });
  it('warns with the size and the limit', () => {
    render(<SizeWarningBar bytes={38 * 1024 * 1024} onShow={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('size-warning').textContent).toContain(
      `It is 38 MB. The limit is ${fmtSize(PAGE_SIZE_LIMIT)}`,
    );
  });
});

describe('keep a copy', () => {
  it('writes a whole HTML file whose pictures open from the disk', () => {
    const html = pageHtmlFile('A <b>', '<p>x</p><img src="/uploads/a.png">', 'http://localhost:8000');
    expect(html).toContain('<title>A &lt;b&gt;</title>');
    expect(html).toContain('src="http://localhost:8000/uploads/a.png"');
  });
});

describe('session ended (F 38, 44)', () => {
  it('knows a refused window from other errors', () => {
    expect(isSessionEnded({ response: { status: 401 } })).toBe(true);
    expect(
      isSessionEnded({
        response: { status: 403, data: { detail: "This request must come from the board's own window. An AI run…" } },
      }),
    ).toBe(true);
    expect(isSessionEnded({ response: { status: 403, data: { detail: { code: 'forbidden' } } } })).toBe(false);
    expect(isSessionEnded(new Error('Network Error'))).toBe(false);
  });

  it('says how many changes are kept, and signs in or copies', () => {
    const signIn = vi.fn();
    const copy = vi.fn();
    render(<SessionEnded waiting={3} onSignIn={signIn} onCopy={copy} onClose={() => {}} />);
    const d = screen.getByTestId('session-ended');
    expect(d.textContent).toContain('Nothing was lost: 3 changes are kept in this browser');
    expect(d.textContent).toContain('Signing in opens a new tab, so this page stays as it is.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy my text' }));
    expect(signIn).toHaveBeenCalled();
    expect(copy).toHaveBeenCalled();
  });
});

describe('the readability check (J 74)', () => {
  const colored = (id: string, color: string): JSONContent => ({
    type: 'paragraph',
    attrs: { blockId: id },
    content: [{ type: 'text', text: 'hard', marks: [{ type: 'textStyle', attrs: { color } }] }],
  });
  it('lists a hard-to-read custom colour and a picture without a description, and fixes the colour', () => {
    const page = doc(p('a', 'x'), colored('b', '#e8b93a'), colored('c', '#1e2a22'), {
      type: 'image',
      attrs: { blockId: 'd', src: '/uploads/a.png', alt: '' },
    });
    const issues = readabilityIssues(page, '#FFFFFF');
    expect(issues.map((x) => [x.kind, x.n])).toEqual([
      ['contrast', 2],
      ['alt', 4],
    ]);
    const c = issues[0];
    if (c.kind !== 'contrast') throw new Error('contrast first');
    expect(c.name).toBe('custom colour 1');
    expect(c.ratio).toBeLessThan(2);
    expect(c.suggestion).toBeTruthy();
    const fixed = fixColour(page as never, 'b', c.hex, c.suggestion!);
    expect(readabilityIssues(fixed, '#FFFFFF').map((x) => x.kind)).toEqual(['alt']);
    render(<ReadabilityCheck issues={issues} pageHex="#FFFFFF" onFix={() => {}} onAdd={() => {}} onClose={() => {}} />);
    const list = screen.getByTestId('readability-check');
    expect(list.textContent).toContain('2 to look at');
    expect(list.textContent).toContain('Block 2 · custom colour 1 on White, 1.8 to 1');
    expect(list.textContent).toContain('Block 4 · a picture. People who cannot see it will not know what it shows.');
  });
});

describe('the changes waiting list (D 24)', () => {
  it('lists a picture that waits to upload with Needs connection, and queued writes', () => {
    render(
      <WaitingList
        total={3}
        rows={[{ group: 'text', count: 1 }]}
        titleChanged={false}
        uploads={[{ name: 'harbour-night.jpg', size: '2.1 MB' }]}
        writes={[{ label: 'Highlights', count: 1 }]}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );
    const l = screen.getByTestId('waiting-list');
    expect(l.textContent).toContain('harbour-night.jpg · 2.1 MB waits to uploadNeeds connection');
    expect(l.textContent).toContain('Highlights1 waiting');
  });
});
