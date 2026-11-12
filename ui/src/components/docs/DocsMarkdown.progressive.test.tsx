// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { splitMarkdown } from '../../utils/markdownChunks';
import { DocsMarkdown } from './DocsMarkdown';

afterEach(cleanup);

/** Six sections, each with an "Example" heading: the ids go example, example-2… across the whole page. */
function longPage() {
  const out: string[] = [];
  for (let s = 0; s < 6; s++) {
    out.push(`## Section ${s}`, '', '### Example', '');
    for (let i = 0; i < 100; i++) out.push(`line ${s}-${i}`, '');
  }
  return out.join('\n');
}

async function renderAll(md: string, progressive: boolean) {
  const r = render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsMarkdown projectId="p" progressive={progressive}>
        {md}
      </DocsMarkdown>
    </QueryClientProvider>,
  );
  for (let i = 0; i < 80 && r.container.querySelector('[data-rendering]'); i++) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });
  }
  return r;
}

describe('DocsMarkdown progressive', () => {
  it('gives repeated headings the same ids as the whole page does', async () => {
    const md = longPage();
    expect(splitMarkdown(md).length).toBeGreaterThan(2);
    const whole = await renderAll(md, false);
    const ids = Array.from(whole.container.querySelectorAll('h2,h3')).map((h) => h.id);
    whole.unmount();
    const prog = await renderAll(md, true);
    expect(prog.container.querySelector('[data-rendering]')).toBeNull();
    expect(Array.from(prog.container.querySelectorAll('h2,h3')).map((h) => h.id)).toEqual(ids);
    expect(ids.filter((id) => id.includes('example'))).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
