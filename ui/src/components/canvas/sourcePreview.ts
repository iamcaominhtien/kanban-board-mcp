import { makeSafeHtml } from '../preview/htmlSafe';

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
 * frame the Preview uses (which allows only what is stored inside the file): stylesheets become `<style>`, and
 * pictures and fonts of the board become data addresses.
 * @param entry - Path of the page.
 * @param text - Text files by path (as edited).
 * @param assets - Data addresses of the board's pictures and fonts by path.
 */
export function inlineBoard(entry: string, text: Record<string, string>, assets: Record<string, string>): string {
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
  out = out.replace(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (m, attr: string, q: string, u: string) => {
    const asset = isLocal(u) ? assets[resolve(entry, u)] : undefined;
    return asset ? `${attr}=${q}${asset}${q}` : m;
  });
  return out;
}

/**
 * The document for the source editor's live preview: the page with its files inlined, made safe like a Preview.
 * @param entry - Path of the page.
 * @param text - Text files by path.
 * @param assets - Data addresses of pictures and fonts by path.
 */
export function previewDocument(entry: string, text: Record<string, string>, assets: Record<string, string>) {
  return makeSafeHtml(inlineBoard(entry, text, assets));
}

/** A byte array as a data address. */
export function dataUrl(bytes: ArrayBuffer, type: string): string {
  let bin = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}
