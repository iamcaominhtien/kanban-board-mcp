// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { AxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client } from './client';
import { useDocsPage, usePublishPage, useSaveDraft } from './docs';

/** A rich page JSON whose attribute names must reach the server as they are. */
const DOC = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { blockId: 'b-000001', level: 2, textAlign: 'center' },
      content: [{ type: 'text', text: 'Intro' }],
    },
    {
      type: 'paragraph',
      attrs: { blockId: 'b-000002', spaceBefore: 8 },
      content: [
        { type: 'text', text: 'Hi', marks: [{ type: 'textStyle', attrs: { fontFamily: 'lora', fontSize: 18 } }] },
      ],
    },
  ],
};

let sent: AxiosRequestConfig[] = [];
let reply: unknown = {};
const original = client.defaults.adapter;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  sent = [];
  reply = {};
  client.defaults.adapter = async (config) => {
    sent.push(config);
    return { data: reply, status: 200, statusText: 'OK', headers: {}, config };
  };
});
afterEach(() => {
  client.defaults.adapter = original;
});

const body = (i = 0) => JSON.parse(String(sent[i].data)) as Record<string, unknown>;

describe('docs client: rich pages (format 1)', () => {
  it('sends a draft as `content`, its JSON as is, and the other keys snake_cased', async () => {
    const { result } = renderHook(() => useSaveDraft('p1'), { wrapper });
    await result.current.mutateAsync({ pageId: 'pg1', content: DOC, title: 'Intro', baseVersion: 3 });
    expect(sent[0].url).toBe('/docs/pages/pg1/draft');
    expect(body()).toEqual({ content: DOC, title: 'Intro', base_version: 3 });
  });

  it('still sends `markdown` when that is all the caller has', async () => {
    const { result } = renderHook(() => useSaveDraft('p1'), { wrapper });
    await result.current.mutateAsync({ pageId: 'pg1', markdown: '# Hi', baseVersion: 1 });
    expect(body()).toEqual({ markdown: '# Hi', base_version: 1 });
  });

  it('publishes `content` in place of `markdown`', async () => {
    const { result } = renderHook(() => usePublishPage('p1'), { wrapper });
    await result.current.mutateAsync({ pageId: 'pg1', baseVersion: 2, content: DOC, note: 'n', title: 'Intro' });
    expect(sent[0].url).toBe('/docs/pages/pg1/publish');
    expect(body()).toEqual({ notify: false, base_version: 2, note: 'n', content: DOC, title: 'Intro' });
  });

  it('reads the new page fields camelCased, the page JSON unchanged', async () => {
    reply = {
      id: 'pg1',
      markdown: '## Intro\n\nHi',
      format: 'rich',
      content: DOC,
      settings: { bodyFont: 'lora', showOutline: false },
      convert_state: 'done',
      convert_error: null,
      draft: { title: 'Intro', markdown: 'x', format: 'rich', content: DOC, base_version: 2 },
    };
    const { result } = renderHook(() => useDocsPage('pg1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    const page = result.current.data!;
    expect(page.format).toBe('rich');
    expect(page.content).toEqual(DOC);
    expect(page.settings).toEqual({ bodyFont: 'lora', showOutline: false });
    expect(page.convertState).toBe('done');
    expect(page.convertError).toBeNull();
    expect(page.draft?.format).toBe('rich');
    expect(page.draft?.content).toEqual(DOC);
    expect(page.draft?.baseVersion).toBe(2);
  });
});
