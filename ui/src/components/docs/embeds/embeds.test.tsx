// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), get: api.get, post: api.post } };
});

import { CodeView, copyText, parseLineRanges } from './CodeView';
import { limitSentence, siteAllowed, uploadDocsFile, uploadProblem } from './embedApi';
import { HtmlEmbedFrame } from './HtmlEmbedFrame';
import {
  EMBED_CSP,
  FRAME_MESSAGE,
  buildSrcdoc,
  embedSandbox,
  linesWith,
  listWords,
  removedThings,
} from './htmlSandbox';
import { ProviderPlayer, VideoPlayer } from './VideoBlock';
import { playableInBrowser, videoEmbedOf } from './videoEmbed';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** Every frame on the screen must keep the embed off the board's origin. */
function expectNoSameOrigin(container: HTMLElement) {
  for (const f of Array.from(container.querySelectorAll('iframe'))) {
    const sb = f.getAttribute('sandbox');
    expect(sb).not.toBeNull();
    expect(sb).not.toContain('allow-same-origin');
    expect(sb).not.toContain('allow-top-navigation');
    expect(sb).not.toContain('allow-popups');
  }
}

describe('HTML embed: the sandbox', () => {
  it('allows scripts only when they may run, and never the same origin', () => {
    expect(embedSandbox(false)).toBe('');
    expect(embedSandbox(true)).toBe('allow-scripts');
    expect(embedSandbox(true)).not.toContain('allow-same-origin');
  });

  it('puts the Content Security Policy in every document, and the reporter only when scripts run', () => {
    const quiet = buildSrcdoc('<p>Hi</p>', { scripts: false, frameId: 'f1' });
    expect(quiet).toContain(`<meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}">`);
    expect(EMBED_CSP).toContain("default-src 'none'");
    expect(EMBED_CSP).toContain("connect-src 'none'");
    expect(EMBED_CSP).toContain("form-action 'none'");
    expect(quiet).toContain('<p>Hi</p>');
    expect(quiet).not.toContain('<script>');
    const loud = buildSrcdoc('<p>Hi</p>', { scripts: true, frameId: 'f1' });
    expect(loud).toContain('<script>');
    expect(loud).toContain(FRAME_MESSAGE);
  });

  it('says what saving removed, and which lines held it', () => {
    const before = [
      '<div onclick="track()">',
      '  <iframe src="https://ads.example.com"></iframe>',
      '  <a href="javascript:go()">Pricing</a>',
      '  <h3>Team</h3>',
      '</div>',
    ].join('\n');
    const after = '<div>\n  \n  <a>Pricing</a>\n  <h3>Team</h3>\n</div>';
    const r = removedThings(before, after);
    expect(r.things).toEqual(['an onclick attribute', 'an iframe', 'a javascript: link']);
    expect(r.lines).toEqual([1, 2, 3]);
    expect(listWords(r.things)).toBe('an onclick attribute, an iframe and a javascript: link');
    expect(linesWith('<h3>Team</h3>\n<div onclick="x()">', r.keys)).toEqual([2]);
    expect(removedThings('<b>same</b>', '<b>same</b>').things).toEqual([]);
  });
});

describe('HtmlEmbedFrame', () => {
  const html = '<p id="t">Hello</p><script>document.getElementById("t").textContent = "Ran"</script>';

  it('shows HTML without scripts in a frame with nothing allowed and a fixed height', () => {
    api.get.mockResolvedValue({ data: { scriptsInEmbeds: 'ask' } });
    const { container } = wrap(
      <HtmlEmbedFrame html="<p>Plain</p>" title="Card" height={null} runScripts={false} projectId="p1" />,
    );
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frame.style.height).toBe('320px');
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
    expectNoSameOrigin(container);
  });

  it('asks before running scripts, then runs them in this view only', async () => {
    api.get.mockResolvedValue({ data: { scriptsInEmbeds: 'ask' } });
    const { container } = wrap(<HtmlEmbedFrame html={html} title="Widget" height={null} runScripts projectId="p1" />);
    const before = container.querySelector('iframe')!;
    expect(before.getAttribute('sandbox')).toBe('');
    expect(before.getAttribute('data-scripts')).toBe('off');
    fireEvent.click(await screen.findByRole('button', { name: 'Run it' }));
    const after = container.querySelector('iframe')!;
    expect(after.getAttribute('sandbox')).toBe('allow-scripts');
    expect(after.getAttribute('srcdoc')).toContain(FRAME_MESSAGE);
    expectNoSameOrigin(container);
    // the height reported by the frame's own script is taken (Height: Auto)
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: FRAME_MESSAGE,
            id: (after.getAttribute('srcdoc') ?? '').match(/var id="([^"]+)"/)?.[1],
            height: 512,
          },
          source: after.contentWindow,
        }),
      );
    });
    expect(container.querySelector('iframe')!.style.height).toBe('512px');
  });

  it('never runs scripts when the project turned them off', async () => {
    api.get.mockResolvedValue({ data: { scriptsInEmbeds: 'off' } });
    const { container } = wrap(<HtmlEmbedFrame html={html} title="Widget" height={200} runScripts projectId="p1" />);
    expect(await screen.findByText(/Scripts are turned off for this project/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.style.height).toBe('200px');
    expectNoSameOrigin(container);
  });

  it('shows "Too large to embed" in place of a frame over 512 KB', () => {
    api.get.mockResolvedValue({ data: {} });
    const big = `<p>${'x'.repeat(600 * 1024)}</p>`;
    const { container } = wrap(<HtmlEmbedFrame html={big} title="Export" height={null} runScripts={false} />);
    expect(screen.getByText('Too large to embed')).toBeTruthy();
    expect(screen.getByText(/An embed can be 512 KB at most/)).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('video', () => {
  it('knows the players of YouTube (no cookies), Vimeo and Loom', () => {
    expect(videoEmbedOf('https://www.youtube.com/watch?v=k3Rn8e_x-1')?.embedUrl).toBe(
      'https://www.youtube-nocookie.com/embed/k3Rn8e_x-1',
    );
    expect(videoEmbedOf('https://youtu.be/abc123')?.provider).toBe('youtube');
    expect(videoEmbedOf('https://vimeo.com/76979871')?.embedUrl).toBe('https://player.vimeo.com/video/76979871');
    expect(videoEmbedOf('https://www.loom.com/share/0281766fa2d04bb7')?.embedUrl).toBe(
      'https://www.loom.com/embed/0281766fa2d04bb7',
    );
    expect(videoEmbedOf('https://example.com/watch?v=1')).toBeNull();
    expect(playableInBrowser('/uploads/demo.mp4')).toBe(true);
    expect(playableInBrowser('/uploads/demo.avi')).toBe(false);
  });

  it('never starts a file by itself: its first frame and the bar until Play, no autoplay, then the controls', () => {
    const { container } = render(<VideoPlayer src="/uploads/demo.mp4" title="Sprint demo" />);
    // only the metadata loads (the length, the first frame); the player's own controls wait for Play
    let v = container.querySelector('video')!;
    expect(v.getAttribute('preload')).toBe('metadata');
    expect(v.getAttribute('src')).toBe('/uploads/demo.mp4#t=0.1');
    expect(v.hasAttribute('autoplay')).toBe(false);
    expect(v.controls).toBe(false);
    fireEvent(v, new Event('loadedmetadata'));
    expect(screen.getByText(/^0:00 \//)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play Sprint demo' }));
    v = container.querySelector('video')!;
    expect(v.autoplay).toBe(false);
    expect(v.hasAttribute('autoplay')).toBe(false);
    expect(v.controls).toBe(true);
  });

  it('says a missing file cannot be played before anyone presses Play', () => {
    const { container } = render(<VideoPlayer src="/uploads/missing.mp4" title="Sprint demo" />);
    fireEvent(container.querySelector('video')!, new Event('error'));
    expect(screen.getByText('This video could not be played')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('loads nothing from YouTube before Play, then its no-cookie player', () => {
    const embed = videoEmbedOf('https://www.youtube.com/watch?v=k3Rn8e')!;
    const { container } = render(<ProviderPlayer embed={embed} title="Designing a calmer board" />);
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play Designing a calmer board' }));
    const f = container.querySelector('iframe')!;
    expect(f.getAttribute('src')).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/k3Rn8e/);
  });

  it('says when a format cannot play in a browser', () => {
    const attach = vi.fn();
    render(<VideoPlayer src="/uploads/demo.avi" onAttachAsFile={attach} onChooseAnother={vi.fn()} />);
    expect(screen.getByText('demo.avi cannot play in a browser')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Attach as a file' }));
    expect(attach).toHaveBeenCalled();
  });
});

describe("uploads: what the server says, in the card's words", () => {
  const fail = (status: number, detail: Record<string, unknown>) => ({ response: { status, data: { detail } } });

  it('maps too large, a blocked type, a virus and a failed scan', () => {
    expect(uploadProblem(fail(413, { code: 'too_large', limit_mb: 100, size_bytes: 1 }), 'file', 50)).toMatchObject({
      code: 'too_large',
      text: 'Too large. A file can be 100 MB at most.',
    });
    expect(uploadProblem(fail(413, {}), 'video', 200).text).toBe('Too large. A video can be 200 MB at most.');
    expect(
      uploadProblem(
        fail(415, { code: 'type_not_allowed', message: 'Programs and scripts cannot be attached.' }),
        'file',
        100,
      ),
    ).toMatchObject({ code: 'type_not_allowed', text: 'Blocked. Programs and scripts cannot be attached.' });
    expect(uploadProblem(fail(422, { code: 'virus_found', virus: 'Eicar' }), 'file', 100)).toMatchObject({
      code: 'virus_found',
      text: 'Not added. The scan found a virus in this file. Nothing was uploaded.',
    });
    expect(
      uploadProblem(fail(503, { code: 'scan_failed', message: 'The scan could not run.' }), 'file', 100),
    ).toMatchObject({
      code: 'scan_failed',
      text: 'The scan could not run.',
    });
    expect(uploadProblem(new Error('offline'), 'file', 100).code).toBe('failed');
    expect(limitSentence('image', 10)).toBe('An image can be 10 MB at most.');
  });

  it("sends the kind and the file to the project's Docs uploads", async () => {
    api.post.mockResolvedValue({
      data: { src: '/uploads/a.pdf', name: 'a.pdf', size: 3, mime: 'application/pdf', kind: 'file' },
    });
    const res = await uploadDocsFile('p1', new File(['abc'], 'a.pdf'), 'file');
    expect(res.src).toBe('/uploads/a.pdf');
    const [url, form] = api.post.mock.lastCall as [string, FormData];
    expect(url).toBe('/projects/p1/docs/uploads');
    expect(form.get('kind')).toBe('file');
    expect([...form.keys()]).toEqual(['kind', 'file']);
  });

  it("embeds only the sites on the project's list", () => {
    expect(siteAllowed('https://www.youtube.com/watch?v=1', ['youtube.com'])).toBe(true);
    expect(siteAllowed('https://evil-youtube.com/x', ['youtube.com'])).toBe(false);
    expect(siteAllowed('https://vimeo.com/1', ['youtube.com'])).toBe(false);
  });
});

describe('code block options', () => {
  it('reads highlighted lines and copies a diff without its markers', () => {
    expect([...parseLineRanges('5-6, 9')]).toEqual([5, 6, 9]);
    expect([...parseLineRanges('3-1,x')]).toEqual([1, 2, 3]);
    expect(copyText(' a\n-b\n+c', true)).toBe('a\nc');
    expect(copyText('x\ny', false)).toBe('x\ny');
  });

  it('draws the file name, line numbers, highlighted lines and the theme', () => {
    const code = 'def a():\n    return 1\n    # done';
    const { container } = render(
      <CodeView
        code={code}
        options={{ language: 'python', filename: 'tokens.py', lineNumbers: true, highlightLines: '2', theme: 'light' }}
        blockId="b-1"
      />,
    );
    const root = container.querySelector('[data-block-id="b-1"]')!;
    expect(root.className).toContain('dk-cv-light');
    expect(root.textContent).toContain('tokens.py');
    expect(root.textContent).toContain('Python');
    const lines = root.querySelectorAll('.dk-cv-line');
    expect(lines).toHaveLength(3);
    expect(lines[1].className).toContain('dk-cv-hl');
    expect(lines[0].querySelector('.dk-cv-gutter')?.textContent).toBe('1');
  });

  it('tints a diff, shows + and - in the gutter, and folds long code behind "Show all"', () => {
    const { container } = render(<CodeView code={' keep\n-old\n+new'} options={{ diff: true }} />);
    const lines = container.querySelectorAll('.dk-cv-line');
    expect(lines[1].className).toContain('dk-cv-del');
    expect(lines[2].className).toContain('dk-cv-add');
    expect(lines[2].querySelector('.dk-cv-gutter')?.textContent).toBe('+');
    cleanup();
    const long = Array.from({ length: 40 }, (_v, i) => `line ${i + 1}`).join('\n');
    render(<CodeView code={long} options={{ wrap: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 40 lines' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });
});

describe('a frame that may not run scripts', () => {
  it('leaves the scripts out of its document', async () => {
    const { buildSrcdoc } = await import('./htmlSandbox');
    const doc = buildSrcdoc('<p>Hi</p><script>alert(1)</script><SCRIPT src="x.js"></SCRIPT>', {
      scripts: false,
      frameId: 'f',
    });
    expect(doc).toContain('<p>Hi</p>');
    expect(doc.toLowerCase()).not.toContain('<script');
    expect(buildSrcdoc('<script>x()</script>', { scripts: true, frameId: 'f' })).toContain('<script>x()</script>');
  });
});
