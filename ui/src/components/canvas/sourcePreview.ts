const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '');

/** Resolve `href` against the folder of the page, so "css/site.css" and "./css/site.css" are the same file. */
function resolve(from: string, href: string): string {
  const base = norm(from).split('/').slice(0, -1);
  for (const part of norm(href.split(/[?#]/)[0]).split('/')) {
    if (part === '..') base.pop();
    else if (part && part !== '.') base.push(part);
  }
  return base.join('/');
}

const isLocal = (u: string) => !!u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u.trim());

/**
 * Put a board's own files into its page, so the source editor can preview what is being typed in the same locked
 * frame the Preview uses: stylesheets become `<style>`, and
 * pictures and fonts of the board become data addresses.
 * @param entry - Path of the page.
 * @param text - Text files by path (as edited).
 * Scripts by relative path that are edited here become inline scripts (the `type` kept), so unsaved edits run.
 * @param assets - Data addresses of the board's pictures and fonts by path.
 * @param baseHref - Address of the folder of the saved board files (ending in "/"); when given, a `<base>` pointing at the
 * folder of the page is added, so every other relative path (a module import, a fetch of a json) reads the saved files.
 */
export function inlineBoard(
  entry: string,
  text: Record<string, string>,
  assets: Record<string, string>,
  baseHref?: string,
): string {
  const html = text[entry] ?? '';
  const sub = (from: string, css: string): string =>
    css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q: string, u: string) => {
      const asset = isLocal(u) ? assets[resolve(from, u)] : undefined;
      return asset ? `url(${q}${asset}${q})` : m;
    });
  let out = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = /rel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (rel !== 'stylesheet' || !href || !isLocal(href)) return tag;
    const path = resolve(entry, href);
    return path in text ? `<style>${sub(path, text[path])}</style>` : tag;
  });
  out = out.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, a: string, css: string, b: string) => `${a}${sub(entry, css)}${b}`,
  );
  out = out.replace(
    /<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script\s*>/gi,
    (m, before: string, _q: string, u: string, after: string) => {
      const path = isLocal(u) ? resolve(entry, u) : '';
      if (!path || !(path in text)) return m;
      const attrs = `${before}${after}`.replace(/\s+/g, ' ').trimEnd();
      return `<script${attrs ? (attrs.startsWith(' ') ? attrs : ` ${attrs}`) : ''}>${text[path].replace(/<\/script/gi, '<\\/script')}</script>`;
    },
  );
  out = out.replace(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (m, attr: string, q: string, u: string) => {
    const asset = isLocal(u) ? assets[resolve(entry, u)] : undefined;
    return asset ? `${attr}=${q}${asset}${q}` : m;
  });
  if (baseHref && !/<base\b/i.test(out)) {
    const dir = norm(entry).split('/').slice(0, -1).map(encodeURIComponent).join('/');
    const tag = `<base href="${baseHref}${dir ? `${dir}/` : ''}">`;
    out = /<head\b[^>]*>/i.test(out) ? out.replace(/<head\b[^>]*>/i, (h) => `${h}${tag}`) : `${tag}${out}`;
  }
  return out;
}

/**
 * The document for the source editor's live preview: the page with its files inlined, otherwise as written.
 * @param entry - Path of the page.
 * @param text - Text files by path.
 * @param assets - Data addresses of pictures and fonts by path.
 * @param baseHref - Folder address of the saved files, for everything that is not inlined (see `inlineBoard`).
 */
export function previewDocument(
  entry: string,
  text: Record<string, string>,
  assets: Record<string, string>,
  baseHref?: string,
) {
  return { srcDoc: inlineBoard(entry, text, assets, baseHref) };
}

/** A byte array as a data address. */
export function dataUrl(bytes: ArrayBuffer, type: string): string {
  let bin = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}
