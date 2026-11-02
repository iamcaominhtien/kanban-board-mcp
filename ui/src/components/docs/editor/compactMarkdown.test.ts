import { describe, expect, it } from 'vitest';
import { compactMarkdown } from './compactMarkdown';

describe('compactMarkdown', () => {
  it('writes tables with one space around each cell, keeping alignment and escaped pipes', () => {
    const md = [
      '| Method | Path                 |',
      '| :----- | -------------------: |',
      '| GET    | /tickets             |',
      '| POST   | `a \\| b`             |',
    ].join('\n');
    expect(compactMarkdown(md)).toBe(
      ['| Method | Path |', '| :--- | ---: |', '| GET | /tickets |', '| POST | `a \\| b` |'].join('\n'),
    );
  });

  it('collapses blank-line runs to one and leaves fenced code alone', () => {
    const md = ['Intro', '', '', '## Next', '```', '| a  |  b |', '', '', '```', 'end'].join('\n');
    expect(compactMarkdown(md)).toBe(['Intro', '', '## Next', '```', '| a  |  b |', '', '', '```', 'end'].join('\n'));
  });

  it('is stable: compact markdown comes out unchanged', () => {
    const md = '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    expect(compactMarkdown(md)).toBe(md);
  });
});
