import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Column } from './Column';
import type { Column as ColumnType } from '../types/ticket';

const col: ColumnType = { id: 'todo', label: 'To Do', accentColor: '#2E6F40' };

describe('Column while tickets load (AL-1)', () => {
  it('shows the lane count when it is known, over skeleton cards', () => {
    const html = renderToStaticMarkup(
      <Column column={col} tickets={[]} onCardClick={() => undefined} skeletonCards={2} loadingCount={3} />,
    );
    expect(html).toContain('data-testid="column-loading-count"');
    expect(html).toContain('3 active tickets');
    expect(html).toContain('>3<');
  });

  it('keeps the skeleton pill without a count', () => {
    const html = renderToStaticMarkup(
      <Column column={col} tickets={[]} onCardClick={() => undefined} skeletonCards={2} />,
    );
    expect(html).not.toContain('column-loading-count');
    expect(html).not.toContain('active tickets');
  });
});
