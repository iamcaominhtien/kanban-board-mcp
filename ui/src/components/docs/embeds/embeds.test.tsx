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
import {
  isSiteFile,
  knownSite,
  limitSentence,
  siteAllowed,
  siteProblem,
  siteTitle,
  uploadDocsFile,
  uploadDocsSite,
  uploadProblem,
} from './embedApi';
import { HtmlEmbedBlock, siteEntry } from './HtmlEmbedBlock';
import { HtmlEmbedFrame } from './HtmlEmbedFrame';
import {
  FRAME_MESSAGE,
  HTML_EMBED_LIMIT,
  buildSrcdoc,
  embedSandbox,
  linesWith,
  listWords,
  removedThings,
  siteUrl,
  withoutScripts,
} from './htmlSandbox';
import { setBackendPort } from '../../../api/resolveOrigin';
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

describe('HTML embed: the sandbox', () => {
  it('runs a page with scripts with no sandbox at all, and allows nothing when scripts may not run', () => {
    expect(embedSandbox(true)).toBeUndefined();
    expect(embedSandbox(false)).toBe('');
  });

  it('puts no Content Security Policy in the document (CDN scripts and requests work), and the reporter only when scripts run', () => {
    const quiet = buildSrcdoc('<p>Hi</p>', { scripts: false, frameId: 'f1' });
    expect(quiet).not.toContain('Content-Security-Policy');
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
    expect(frame.style.height).toBe('320px');
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
  });

  it('asks before running scripts, then runs them in this view only', async () => {
    api.get.mockResolvedValue({ data: { scriptsInEmbeds: 'ask' } });
    const { container } = wrap(<HtmlEmbedFrame html={html} title="Widget" height={null} runScripts projectId="p1" />);
    const before = container.querySelector('iframe')!;
    expect(before.getAttribute('sandbox')).toBe('');
    expect(before.getAttribute('data-scripts')).toBe('off');
    fireEvent.click(await screen.findByRole('button', { name: 'Run it' }));
    const after = container.querySelector('iframe')!;
    expect(after.hasAttribute('sandbox')).toBe(false);
    expect(after.getAttribute('srcdoc')).toContain(FRAME_MESSAGE);
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

  it('runs scripts as soon as it is shown when the project lets them run (the default)', async () => {
    api.get.mockResolvedValue({ data: {} });
    const { container } = wrap(<HtmlEmbedFrame html={html} title="Widget" height={null} runScripts projectId="p1" />);
    // the settings arrive, and with no choice made the scripts run without a click
    await vi.waitFor(() => expect(container.querySelector('iframe')!.getAttribute('data-scripts')).toBe('on'));
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
    const frame = container.querySelector('iframe')!;
    expect(frame.hasAttribute('sandbox')).toBe(false);
    expect(frame.hasAttribute('allowfullscreen')).toBe(true);
  });

  it('never runs scripts when the project turned them off', async () => {
    api.get.mockResolvedValue({ data: { scriptsInEmbeds: 'off' } });
    const { container } = wrap(<HtmlEmbedFrame html={html} title="Widget" height={200} runScripts projectId="p1" />);
    expect(await screen.findByText(/Scripts are turned off for this project/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.style.height).toBe('200px');
  });

  it('shows "Too large to embed" in place of a frame over the limit', () => {
    api.get.mockResolvedValue({ data: {} });
    const big = `<p>${'x'.repeat(HTML_EMBED_LIMIT)}</p>`;
    const { container } = wrap(<HtmlEmbedFrame html={big} title="Export" height={null} runScripts={false} />);
    expect(screen.getByText('Too large to embed')).toBeTruthy();
    expect(screen.getByText(/An embed can be 10\.0 MB at most/)).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('HtmlEmbedFrame with a site (src)', () => {
  const src = '/docs/sites/ab12cd34ef56/index.html';
  // jsdom loads no frames: the frame gets a document of this origin whose content is `height` px tall
  const pageOf = (frame: HTMLIFrameElement, height: number) => {
    const doc = document.implementation.createHTMLDocument('Globe');
    Object.defineProperty(doc.documentElement, 'scrollHeight', { value: height, configurable: true });
    Object.defineProperty(frame, 'contentDocument', { value: doc, configurable: true });
  };

  it('opens the address in a frame with no sandbox and no srcdoc, whatever runScripts says', async () => {
    let answer: (v: unknown) => void = () => undefined;
    api.get.mockReturnValue(new Promise((r) => (answer = r)));
    const { container } = wrap(
      <HtmlEmbedFrame html="" src={src} title="Globe" height={480} runScripts={false} projectId="p1" />,
    );
    // until the project's choice is known the page is not loaded (it would load once without its scripts)
    expect(container.querySelector('iframe')!.hasAttribute('src')).toBe(false);
    act(() => answer({ data: {} }));
    await vi.waitFor(() => expect(container.querySelector('iframe')!.getAttribute('data-scripts')).toBe('on'));
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(siteUrl(src));
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.hasAttribute('sandbox')).toBe(false);
    expect(frame.hasAttribute('allowfullscreen')).toBe(true);
    expect(frame.getAttribute('allow')).toContain('xr-spatial-tracking');
    expect(frame.style.height).toBe('480px');
  });

  it('gets sandbox="" when the project turned scripts off', async () => {
    api.get.mockResolvedValue({ data: { scriptsInEmbeds: 'off' } });
    const { container } = wrap(
      <HtmlEmbedFrame html="" src={src} title="Globe" height={null} runScripts projectId="p1" />,
    );
    expect(await screen.findByText(/Scripts are turned off for this project/)).toBeTruthy();
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('src')).toBe(siteUrl(src));
  });

  it("follows the page's own height (Height: Auto) by reading its document", async () => {
    api.get.mockResolvedValue({ data: {} });
    const { container } = wrap(
      <HtmlEmbedFrame html="" src={src} title="Globe" height={null} runScripts projectId="p1" />,
    );
    await vi.waitFor(() => expect(container.querySelector('iframe')!.getAttribute('data-scripts')).toBe('on'));
    const frame = container.querySelector('iframe')!;
    // until the page has loaded, the default height
    expect(frame.style.height).toBe('320px');
    pageOf(frame, 912);
    act(() => {
      fireEvent.load(frame);
    });
    expect(frame.style.height).toBe('912px');
    // a fixed height wins over the page's
    cleanup();
    const fixed = wrap(<HtmlEmbedFrame html="" src={src} title="Globe" height={300} runScripts projectId="p1" />);
    const f2 = fixed.container.querySelector('iframe')!;
    pageOf(f2, 912);
    act(() => {
      fireEvent.load(f2);
    });
    expect(f2.style.height).toBe('300px');
  });

  it("the reader's View source names the page it opens and links to it", async () => {
    api.get.mockResolvedValue({ data: {} });
    wrap(<HtmlEmbedBlock attrs={{ html: '', src, title: 'Globe' }} projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    const view = screen.getByTestId('html-embed-site-source');
    expect(view.textContent).toContain('Site · opens index.html');
    expect(screen.getByRole('link', { name: /Open in a new tab/ }).getAttribute('href')).toBe(siteUrl(src));
    expect(siteEntry('/docs/sites/ab12cd34ef56/demo/page%20one.html')).toBe('demo/page one.html');
  });

  it("puts the site on the server's origin, so it also loads when the page is the desktop app's file:// one", () => {
    setBackendPort(57463);
    expect(siteUrl(src)).toBe('http://127.0.0.1:57463/docs/sites/ab12cd34ef56/index.html');
    // an address that already names a host stays as it is
    expect(siteUrl('https://example.com/a.html')).toBe('https://example.com/a.html');
    expect(siteUrl('//cdn.example.com/a.html')).toBe('//cdn.example.com/a.html');
  });
});

describe('sites: uploading a folder, a .zip or an .html', () => {
  it('sends each file under its path inside the folder, and remembers the answer', async () => {
    const site = {
      id: 'ab12cd34ef56',
      url: '/docs/sites/ab12cd34ef56/index.html',
      entry: 'index.html',
      files: [
        { path: 'index.html', bytes: 12 },
        { path: 'js/app.js', bytes: 3 },
      ],
      bytes: 15,
    };
    api.post.mockResolvedValue({ data: site });
    const page = new File(['<h1>Hi</h1>'], 'index.html', { type: 'text/html' });
    const script = new File(['x()'], 'app.js');
    Object.defineProperty(page, 'webkitRelativePath', { value: 'globe/index.html' });
    Object.defineProperty(script, 'webkitRelativePath', { value: 'globe/js/app.js' });
    const res = await uploadDocsSite('p1', [page, script]);
    expect(res).toEqual(site);
    const [url, form] = api.post.mock.lastCall as [string, FormData];
    expect(url).toBe('/projects/p1/docs/sites');
    const sent = form.getAll('files') as File[];
    expect(sent.map((f) => f.name)).toEqual(['globe/index.html', 'globe/js/app.js']);
    expect(knownSite(site.url)).toEqual(site);
    expect(siteTitle([page, script])).toBe('globe');
    expect(siteTitle([new File(['PK'], 'Solar system.zip')])).toBe('Solar system');
  });

  it('knows which files are sites, and says why the server refused one', () => {
    expect(isSiteFile(new File([''], 'globe.HTML'))).toBe(true);
    expect(isSiteFile(new File([''], 'site.zip'))).toBe(true);
    expect(isSiteFile(new File([''], 'notes.pdf'))).toBe(false);
    const refused = (status: number, detail: unknown) => siteProblem({ response: { status, data: { detail } } });
    expect(refused(422, 'no_html_page').text).toBe(
      'There is no HTML page in it. Add an index.html and upload it again.',
    );
    expect(refused(422, { code: 'unsafe_path' }).code).toBe('unsafe_path');
    expect(refused(413, 'too_large').text).toBe('Too large. A site can be 500 MB at most.');
    expect(refused(422, 'too_many_files').text).toBe('Too many files. A site can have 5000 files at most.');
    expect(siteProblem(new Error('offline')).code).toBe('failed');
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

describe('withoutScripts', () => {
  it('drops every form of a script tag the browser would run, and keeps the rest', () => {
    const html =
      '<p>a</p><script>x()</script><SCRIPT src="y.js"></SCRIPT ><script>z()</script\t\n bar><b>b</b><script/>';
    const out = withoutScripts(html);
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).toContain('<p>a</p>');
    expect(out).toContain('<b>b</b>');
  });
});
