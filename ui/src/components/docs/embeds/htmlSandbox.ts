/**
 * How an HTML embed is put in its frame (design "Embeds", section A): a `srcdoc` with a Content Security Policy that
 * allows no network requests from scripts, forms or frames, in an `<iframe sandbox>` that may run scripts only when
 * they are allowed and never gets `allow-same-origin`, top navigation or pop-ups. When scripts run, a tiny script is
 * added that reports the content's height (Height: Auto) and what the sandbox blocked. Also what the server removed
 * when the page was saved, found by comparing the HTML sent with the HTML it kept.
 */

/** The largest HTML an embed may hold (bytes). */
export const HTML_EMBED_LIMIT = 512 * 1024;

/** The height of a frame whose content cannot report its own (no scripts), in px. */
export const DEFAULT_EMBED_HEIGHT = 320;

/** The Content Security Policy every embed's document carries. */
export const EMBED_CSP =
  "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' *; font-src * data:; " +
  "script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'";

/**
 * The `sandbox` attribute of an embed's frame: `allow-scripts` only while scripts may run, else nothing allowed.
 * Never `allow-same-origin` (the document would share the board's origin), `allow-top-navigation` or pop-ups.
 * @param scripts - Scripts may run in this view.
 */
export function embedSandbox(scripts: boolean): string {
  return scripts ? 'allow-scripts' : '';
}

/** Bytes of a text in UTF-8. */
export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "0.6 KB", "1.4 MB". */
export function kbOrMb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** True when the HTML has a script element (the reason to ask before running it). */
export function hasScripts(html: string): boolean {
  return /<script\b/i.test(html);
}

/** The message type the frame's script sends. */
export const FRAME_MESSAGE = 'kb-embed';

/** The script added to a frame whose scripts run: reports the height and what the sandbox blocked. */
function reporterScript(frameId: string): string {
  const id = JSON.stringify(frameId);
  return (
    '<script>(function(){' +
    `var id=${id};` +
    "function send(m){m.type='" +
    FRAME_MESSAGE +
    "';m.id=id;try{parent.postMessage(m,'*')}catch(e){}}" +
    'function h(){send({height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0))})}' +
    "addEventListener('load',h);" +
    'if(window.ResizeObserver){new ResizeObserver(h).observe(document.documentElement)}else{setInterval(h,500)}' +
    "document.addEventListener('securitypolicyviolation',function(e){send({blocked:(e.effectiveDirective||e.violatedDirective||'')+' '+(e.blockedURI||'')})});" +
    "window.open=function(){send({blocked:'popup'});return null};" +
    'h();})();</script>'
  );
}

/** Options of {@link buildSrcdoc}. */
export interface SrcdocOptions {
  /** Scripts may run: the height reporter is added. */
  scripts: boolean;
  /** Names the frame in its messages. */
  frameId: string;
}

/**
 * The embed's HTML without its scripts, for a frame that may not run them: the sandbox would block them anyway,
 * and the browser would log an error for each.
 */
export function withoutScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/?>/gi, '');
}

/**
 * The document an embed's frame shows: the CSP, base styles and the author's HTML (and the reporter when scripts
 * run).
 * @param html - The embed's HTML as stored (cleaned by the server).
 * @param opts - Whether scripts run, and the frame id the reporter answers with.
 */
export function buildSrcdoc(html: string, opts: SrcdocOptions): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>html,body{margin:0}body{padding:8px;font-family:system-ui,sans-serif;font-size:14px;color:#1e2a22}' +
    'img,video{max-width:100%}</style>' +
    `</head><body>${opts.scripts ? html + reporterScript(opts.frameId) : withoutScripts(html)}</body></html>`
  );
}

/** One kind of thing the server removes from an embed when it is saved. */
interface Feature {
  /** How it is named in "Saved. N things were removed…". */
  label: string;
  /** Finds it on a line of the author's code (to cross the line out). */
  line: RegExp;
}

const IFRAME_LIKE = ['iframe', 'frame', 'object', 'embed'];

/** The removable things in a piece of HTML, one string per thing (`on:onclick`, `tag:iframe`, `js-link`). */
function features(html: string): string[] {
  const out: string[] = [];
  if (typeof DOMParser === 'undefined') return out;
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  doc.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (IFRAME_LIKE.includes(tag)) out.push(`tag:${tag}`);
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) out.push(`on:${name}`);
      else if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name) && /^\s*javascript:/i.test(a.value))
        out.push('js-link');
    }
  });
  return out;
}

function featureOf(key: string): Feature {
  if (key.startsWith('on:')) {
    const name = key.slice(3);
    return { label: `an ${name} attribute`, line: new RegExp(`\\s${name}\\s*=`, 'i') };
  }
  if (key.startsWith('tag:')) {
    const tag = key.slice(4);
    return { label: `an ${tag}`, line: new RegExp(`<${tag}\\b`, 'i') };
  }
  return { label: 'a javascript: link', line: /javascript:/i };
}

/** What the server removed from an embed on save. */
export interface Removed {
  /** "an onclick attribute", "an iframe", "a javascript: link", one per thing. */
  things: string[];
  /** The things as keys (`on:onclick`, `tag:iframe`, `js-link`), to find them again in edited code. */
  keys: string[];
  /** Line numbers (1-based) of the author's code that hold a removed thing. */
  lines: number[];
}

/**
 * The lines (1-based) of `html` that hold one of the removed things.
 * @param keys - {@link Removed.keys}.
 */
export function linesWith(html: string, keys: string[]): number[] {
  const list = [...new Set(keys)].map(featureOf);
  const out: number[] = [];
  html.split('\n').forEach((text, i) => {
    if (list.some((f) => f.line.test(text))) out.push(i + 1);
  });
  return out;
}

/**
 * What saving removed from an embed: the things in `before` (what the author wrote) that `after` (what the server
 * kept) no longer has. Nothing when the two are the same.
 * @param before - The HTML sent.
 * @param after - The HTML in the server's answer.
 */
export function removedThings(before: string, after: string): Removed {
  if (before === after) return { things: [], keys: [], lines: [] };
  const kept = new Map<string, number>();
  for (const k of features(after)) kept.set(k, (kept.get(k) ?? 0) + 1);
  const gone: string[] = [];
  for (const k of features(before)) {
    const n = kept.get(k) ?? 0;
    if (n > 0) kept.set(k, n - 1);
    else gone.push(k);
  }
  return { things: gone.map((k) => featureOf(k).label), keys: gone, lines: linesWith(before, gone) };
}

/** "an onclick attribute, an iframe and a javascript: link". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
