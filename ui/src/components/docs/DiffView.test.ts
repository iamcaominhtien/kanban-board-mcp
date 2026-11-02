import { describe, expect, it } from 'vitest';
import type { DocsDiff, DocsDiffRow } from '../../types/docs';
import { diffSections } from './DiffView';

const row = (type: DocsDiffRow['type'], text: string): DocsDiffRow => ({ type, text, oldNo: null, newNo: null });

describe('diffSections', () => {
  it('labels a section that is new in this version "Added", even next to a shared blank line', () => {
    const rows = [
      row('same', '## Overview'),
      row('same', 'Intro'),
      row('same', ''),
      row('add', '## Example request'),
      row('add', 'curl /tickets'),
      row('same', ''),
    ];
    const diff: DocsDiff = { from: 1, to: 2, rows, added: 2, removed: 0, sections: [] };
    expect(diffSections(diff)).toEqual([{ heading: 'Example request', added: 2, removed: 0, kind: 'Added' }]);
  });

  it('keeps "Changed" when unchanged text sits in the section', () => {
    const rows = [row('same', '## Limits'), row('del', 'Old rule'), row('add', 'New rule')];
    const diff: DocsDiff = { from: 1, to: 2, rows, added: 1, removed: 1, sections: [] };
    expect(diffSections(diff)[0].kind).toBe('Changed');
  });
});
