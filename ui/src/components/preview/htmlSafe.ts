/** Result of making an HTML file safe to show in a locked frame. */
export interface SafeHtml {
  /** Document for the frame's `srcdoc`, with a CSP that blocks every outside request. */
  srcDoc: string;
  /** Scripts that were removed. */
  scripts: number;
  /** Pictures, fonts and styles that live on other websites and were not loaded. */
  external: { images: number; styles: number; other: number };
}

/** Policy for the frame: nothing from outside; only pictures, fonts and styles stored inside the file. */
export const FRAME_CSP =
  "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const isRemote = (v: string | null) => !!v && /^\s*(?:https?:)?\/\//i.test(v);

/**
 * Prepare an HTML file for the locked frame.
 * Defense in depth: the frame is sandboxed without scripts, forms, pop-ups or same-origin, and the CSP blocks outside
 * requests; on top of that the document is stripped of scripts, embedded content, event handlers and link targets.
 * @param html - The file's text.
 */
export function makeSafeHtml(html: string): SafeHtml {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let scripts = 0;
  const external = { images: 0, styles: 0, other: 0 };

  doc.querySelectorAll('img, source, video, audio, track, input[type=image]').forEach((el) => {
    const src = el.getAttribute('src') ?? el.getAttribute('srcset');
    if (isRemote(src)) external.images++;
    if (src && !src.trim().startsWith('data:')) el.removeAttribute('src');
    el.removeAttribute('srcset');
    el.removeAttribute('poster');
  });
  doc.querySelectorAll('link').forEach((el) => {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase();
    if (isRemote(el.getAttribute('href'))) {
      if (rel.includes('stylesheet')) external.styles++;
      else external.other++;
    }
    el.remove();
  });
  doc.querySelectorAll('style').forEach((el) => {
    const css = el.textContent ?? '';
    const remote = css.match(/(?:@import\s+(?:url\()?["']?|url\(\s*["']?)(?:https?:)?\/\/[^)"'\s]+/gi);
    if (remote) external.other += remote.length;
  });
  doc.querySelectorAll('script').forEach((el) => {
    scripts++;
    el.remove();
  });
  if (doc.querySelector('noscript')) doc.querySelectorAll('noscript').forEach((el) => el.remove());
  doc.querySelectorAll('iframe, frame, frameset, object, embed, applet, base, portal').forEach((el) => {
    external.other++;
    el.remove();
  });
  doc.querySelectorAll('meta[http-equiv]').forEach((el) => el.remove());
  doc.querySelectorAll('form').forEach((el) => {
    el.removeAttribute('action');
  });
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      else if (attr.name === 'href' || attr.name === 'xlink:href') {
        // links do not open from the preview
        if (el.tagName.toLowerCase() === 'a') {
          el.setAttribute('data-blocked-href', attr.value);
          el.removeAttribute(attr.name);
        } else el.removeAttribute(attr.name);
      } else if (attr.name === 'style' && /url\(/i.test(attr.value) && !/url\(\s*["']?data:/i.test(attr.value)) {
        el.removeAttribute('style');
      }
    }
  });
  doc.querySelectorAll('a').forEach((el) => {
    el.setAttribute('target', '_self');
    el.setAttribute('rel', 'noreferrer noopener');
  });

  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', FRAME_CSP);
  doc.head.prepend(meta);
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  doc.head.prepend(charset);

  return { srcDoc: `<!doctype html>${doc.documentElement.outerHTML}`, scripts, external };
}
