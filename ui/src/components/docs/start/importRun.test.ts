import { beforeEach, describe, expect, it, vi } from 'vitest';

const conv = vi.hoisted(() => ({ fileToDoc: vi.fn(), saveImportedPage: vi.fn() }));
vi.mock('./importConvert', async (orig) => ({ ...(await orig<typeof import('./importConvert')>()), ...conv }));

import { ImportError } from './importConvert';
import { runImport, type ImportRow } from './importRun';

const DOC = { type: 'doc', content: [{ type: 'paragraph' }] };
const row = (key: string, extra: Partial<ImportRow> = {}): ImportRow => ({
  key,
  name: `${key}.docx`,
  size: 10,
  file: new File(['x'], `${key}.docx`),
  problem: null,
  status: 'waiting',
  ...extra,
});
const offline = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });

function ctx(stopAfter = Infinity) {
  const updates: Record<string, Partial<ImportRow>> = {};
  let n = 0;
  return {
    updates,
    c: {
      projectId: 'p1',
      parentId: 'parent',
      stopped: () => n >= stopAfter,
      update: (key: string, patch: Partial<ImportRow>) => {
        updates[key] = { ...updates[key], ...patch };
        if (patch.status === 'done' || patch.status === 'failed') n += 1;
      },
    },
  };
}

beforeEach(() => {
  conv.fileToDoc.mockReset().mockResolvedValue({ doc: DOC, title: null, droppedPictures: 0 });
  conv.saveImportedPage.mockReset().mockImplementation(async (_p: string, v: { title: string }) => `id-${v.title}`);
});

describe('an import run', () => {
  it('imports the files one by one under the chosen parent, titled from the file name, skipping refused ones', async () => {
    const { c, updates } = ctx();
    const res = await runImport(
      [row('a'), row('b', { problem: { code: 'too_large', title: 'Too large', text: '' } }), row('c')],
      c,
    );
    expect(res).toEqual({ created: ['id-a', 'id-c'], failed: 0, stopped: false, offline: false });
    expect(conv.saveImportedPage).toHaveBeenCalledWith('p1', {
      title: 'a',
      parentId: 'parent',
      doc: DOC,
      pageId: undefined,
    });
    expect(updates.a).toMatchObject({ status: 'done', pageId: 'id-a' });
    expect(updates.b).toBeUndefined();
  });

  it('keeps the reason of a file that cannot be read and goes on with the rest', async () => {
    conv.fileToDoc.mockRejectedValueOnce(
      new ImportError('This file is password-protected. Remove the password and try again.'),
    );
    const { c, updates } = ctx();
    const res = await runImport([row('a'), row('b')], c);
    expect(res.failed).toBe(1);
    expect(res.created).toEqual(['id-b']);
    expect(updates.a).toMatchObject({ status: 'failed', reason: expect.stringMatching(/password-protected/) });
  });

  it('retries only the failed file, and only its text when its page was already made', async () => {
    conv.saveImportedPage.mockRejectedValueOnce(
      Object.assign(new Error('500'), {
        pageId: 'made',
        response: { status: 500, data: { detail: { code: 'x', message: 'Could not save' } } },
      }),
    );
    const first = ctx();
    await runImport([row('a')], first.c);
    expect(first.updates.a).toMatchObject({ status: 'failed', reason: 'Could not save', pageId: 'made' });
    const again = ctx();
    const res = await runImport([row('a', { pageId: 'made' })], again.c);
    expect(conv.saveImportedPage).toHaveBeenLastCalledWith('p1', expect.objectContaining({ pageId: 'made' }));
    expect(res.created).toHaveLength(1);
  });

  it('stops before the next file when Stop is pressed; what is in stays', async () => {
    const { c, updates } = ctx(1);
    const res = await runImport([row('a'), row('b'), row('c')], c);
    expect(res).toMatchObject({ created: ['id-a'], stopped: true });
    expect(updates.b).toBeUndefined();
  });

  it('stops when the server cannot be reached', async () => {
    conv.saveImportedPage.mockRejectedValueOnce(offline());
    const { c, updates } = ctx();
    const res = await runImport([row('a'), row('b')], c);
    expect(res).toMatchObject({ created: [], offline: true });
    expect(updates.a?.reason).toMatch(/could not reach the server/);
    expect(updates.b).toBeUndefined();
  });
});
