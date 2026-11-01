/**
 * Utility functions to convert between Markdown and HTML for the WYSIWYG Editor (Approach B).
 * Strictly mirrors the styling and formatting from DescriptionMarkdown.dc.html.
 */

import { keyChipHtml, keyPattern, refChipHtml } from './docRefTokens';
import { resolveOrigin } from '../api/resolveOrigin';
import { DIAGRAM_LINE } from '../components/diagrams/diagramRefs';
import { SKETCH_LINE } from '../components/sketch/sketchRefs';
import { CANVAS_LINE, canvasRefOf } from '../components/canvas/canvasRefs';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The editor's stand-in for a diagram line: a non-editable block with the picture, an Edit button and the name.
 * `htmlToMarkdown` turns it back into `[label](diagram:id)`.
 * @param id - Diagram id.
 * @param label - Diagram label.
 * @param version - Version to show; adds a cache key to the picture address.
 */
export function diagramBlockHtml(id: string, label: string, version?: number): string {
  const name = escapeHtml(label || 'Diagram');
  const safeId = escapeHtml(encodeURIComponent(id));
  const src = escapeHtml(
    `${resolveOrigin()}/diagrams/${encodeURIComponent(id)}/svg${version ? `?version=${Number(version)}` : ''}`,
  );
  return (
    `<div data-diagram="${safeId}" data-label="${name}" contenteditable="false" ` +
    `style="margin:10px 0;border:1px solid #E3E8E5;border-radius:12px;background:#fff;overflow:hidden;user-select:none;max-width:100%">` +
    `<div style="display:flex;justify-content:center;padding:12px"><img data-diagram-img src="${src}" alt="${name}" ` +
    `style="max-width:100%;max-height:320px;width:auto;height:auto;cursor:zoom-in" /></div>` +
    `<div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid #EEF2EF;background:#FAFCFA;font-size:13px;color:#5B6B60">` +
    `<span style="padding:1px 8px;border-radius:6px;background:#E3F2E7;color:#2E6F40;font-weight:600;font-size:12px">draw.io</span>` +
    `<b data-diagram-name style="color:#1E2A22">${name}</b><span style="flex:1"></span>` +
    `<button type="button" data-diagram-edit style="border:1px solid #DCE6DF;border-radius:7px;background:#fff;padding:3px 10px;font:600 12px inherit;cursor:pointer">Edit</button>` +
    `</div></div>`
  );
}

const BLOCK_STYLE =
  'margin:10px 0;border:1px solid #E3E8E5;border-radius:12px;background:#fff;overflow:hidden;user-select:none;max-width:100%';

/**
 * The same block as `diagramBlockHtml`, built with DOM calls so the label is only ever set as text or an attribute value.
 * @param id - Diagram id.
 * @param label - Diagram label.
 */
export function diagramBlockElement(id: string, label: string): HTMLElement {
  const name = label || 'Diagram';
  const el = (tag: string, style?: string) => {
    const e = document.createElement(tag);
    if (style) e.setAttribute('style', style);
    return e;
  };
  const block = el('div', BLOCK_STYLE);
  block.setAttribute('data-diagram', id);
  block.setAttribute('data-label', name);
  block.setAttribute('contenteditable', 'false');
  const stage = el('div', 'display:flex;justify-content:center;padding:12px');
  const img = el('img', 'max-width:100%;max-height:320px;width:auto;height:auto;cursor:zoom-in') as HTMLImageElement;
  img.setAttribute('data-diagram-img', '');
  img.src = `${resolveOrigin()}/diagrams/${encodeURIComponent(id)}/svg`;
  img.alt = name;
  stage.appendChild(img);
  const foot = el(
    'div',
    'display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid #EEF2EF;background:#FAFCFA;font-size:13px;color:#5B6B60',
  );
  const chip = el(
    'span',
    'padding:1px 8px;border-radius:6px;background:#E3F2E7;color:#2E6F40;font-weight:600;font-size:12px',
  );
  chip.textContent = 'draw.io';
  const title = el('b', 'color:#1E2A22');
  title.setAttribute('data-diagram-name', '');
  title.textContent = name;
  const grow = el('span', 'flex:1');
  const edit = el(
    'button',
    'border:1px solid #DCE6DF;border-radius:7px;background:#fff;padding:3px 10px;font:600 12px inherit;cursor:pointer',
  );
  edit.setAttribute('type', 'button');
  edit.setAttribute('data-diagram-edit', '');
  edit.textContent = 'Edit';
  foot.append(chip, title, grow, edit);
  block.append(stage, foot);
  return block;
}

/**
 * The editor's stand-in for a sketch line: a non-editable block with the picture and an "Edit sketch" button.
 * `htmlToMarkdown` turns it back into `![label](sketch:id)`.
 * @param id - Sketch id.
 * @param label - Sketch title.
 * @param version - Version to show; adds a cache key to the picture address.
 */
export function sketchBlockElement(id: string, label: string, version?: number): HTMLElement {
  const name = label || 'Sketch';
  const el = (tag: string, style?: string) => {
    const e = document.createElement(tag);
    if (style) e.setAttribute('style', style);
    return e;
  };
  const block = el('div', BLOCK_STYLE);
  block.setAttribute('data-sketch', id);
  block.setAttribute('data-label', name);
  block.setAttribute('contenteditable', 'false');
  const stage = el('div', 'display:flex;justify-content:center;padding:12px');
  const img = el('img', 'max-width:100%;max-height:320px;width:auto;height:auto;cursor:zoom-in') as HTMLImageElement;
  img.setAttribute('data-sketch-img', '');
  img.src = `${resolveOrigin()}/sketches/${encodeURIComponent(id)}/png${version ? `?v=${Number(version)}` : ''}`;
  img.alt = name;
  stage.appendChild(img);
  const foot = el(
    'div',
    'display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid #EEF2EF;background:#FAFCFA;font-size:13px;color:#5B6B60',
  );
  const chip = el(
    'span',
    'padding:1px 8px;border-radius:6px;background:#ECE8FB;color:#5A49C2;font-weight:600;font-size:12px',
  );
  chip.textContent = 'Sketch';
  const title = el('b', 'color:#1E2A22');
  title.setAttribute('data-sketch-name', '');
  title.textContent = name;
  const grow = el('span', 'flex:1');
  const edit = el(
    'button',
    'border:1px solid #DCE6DF;border-radius:7px;background:#fff;padding:3px 10px;font:600 12px inherit;cursor:pointer',
  );
  edit.setAttribute('type', 'button');
  edit.setAttribute('data-sketch-edit', '');
  edit.textContent = 'Edit sketch';
  foot.append(chip, title, grow, edit);
  block.append(stage, foot);
  return block;
}

/**
 * The editor's stand-in for a canvas line: a non-editable block with the overview picture and "Edit canvas" / "Show"
 * buttons. `htmlToMarkdown` turns it back into `![label](canvas:id[#frame])`.
 * @param id - Canvas id.
 * @param label - Canvas title.
 * @param fragment - `b_…` for one board or `p_…` for a page tab.
 * @param version - Version to show; adds a cache key to the picture address.
 */
export function canvasBlockElement(id: string, label: string, fragment?: string, version?: number): HTMLElement {
  const name = label || 'Canvas';
  const el = (tag: string, style?: string) => {
    const e = document.createElement(tag);
    if (style) e.setAttribute('style', style);
    return e;
  };
  const block = el('div', BLOCK_STYLE);
  block.setAttribute('data-canvas', id);
  if (fragment) block.setAttribute('data-fragment', fragment);
  block.setAttribute('data-label', name);
  block.setAttribute('contenteditable', 'false');
  const stage = el('div', 'display:flex;justify-content:center;padding:12px;background:#F3F5F3');
  const img = el('img', 'max-width:100%;max-height:320px;width:auto;height:auto;cursor:zoom-in') as HTMLImageElement;
  img.setAttribute('data-canvas-img', '');
  img.src = `${resolveOrigin()}/canvases/${encodeURIComponent(id)}/overview.png${version ? `?v=${Number(version)}` : ''}`;
  img.alt = name;
  stage.appendChild(img);
  const foot = el(
    'div',
    'display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid #EEF2EF;background:#FAFCFA;font-size:13px;color:#5B6B60',
  );
  const chip = el(
    'span',
    'padding:1px 8px;border-radius:6px;background:#E8F1FA;color:#244E78;font-weight:600;font-size:12px',
  );
  chip.textContent = 'Canvas';
  const title = el('b', 'color:#1E2A22');
  title.setAttribute('data-canvas-name', '');
  title.textContent = name;
  const grow = el('span', 'flex:1');
  const btn = (attr: string, text: string) => {
    const b = el(
      'button',
      'border:1px solid #DCE6DF;border-radius:7px;background:#fff;padding:3px 10px;font:600 12px inherit;cursor:pointer',
    );
    b.setAttribute('type', 'button');
    b.setAttribute(attr, '');
    b.textContent = text;
    return b;
  };
  foot.append(chip, title, grow, btn('data-canvas-show', 'Show…'), btn('data-canvas-edit', 'Edit canvas'));
  block.append(stage, foot);
  return block;
}

/** A canvas inside a sentence ("Link only"): a small chip that `htmlToMarkdown` turns back into `[label](canvas:id)`. */
export function canvasChipElement(id: string, label: string, fragment?: string): HTMLElement {
  const chip = document.createElement('span');
  chip.setAttribute('data-canvas-chip', id);
  if (fragment) chip.setAttribute('data-fragment', fragment);
  chip.setAttribute('data-label', label || 'Canvas');
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute(
    'style',
    'display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;background:#F1F8F3;border:1px solid #D7E8DC;color:#2E6F40;font-weight:600;font-size:13px;cursor:pointer;vertical-align:1px',
  );
  chip.textContent = `▦ ${label || 'Canvas'}`;
  return chip;
}

/** Allow only http(s), mailto, root-relative and plain relative URLs. */
export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return true;
  // eslint-disable-next-line no-control-regex -- strip control characters before checking the scheme
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed.replace(/[\u0000-\u0020]/g, ''));
}

function formatInlineMarkdown(text: string): string {
  // Strip any old uploading:... placeholder
  text = text.replace(/!\[Uploading [^\]]*\]\(uploading:[^)]+\)/g, '');

  // Normalize /api/uploads/ to /uploads/
  text = text.replace(/\/api\/uploads\//g, '/uploads/');

  // Convert Pandoc/Kramdown/Obsidian style image attributes: ![alt](url){width=...} -> ![alt|width](url)
  text = text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)\{(?:width=)?(\d+(?:%|px)?)[^}]*\}/gi,
    (_match, alt, url, width) => `![${alt ? `${alt}|${width}` : width}](${url})`,
  );

  // Escape raw HTML first so user text can never inject markup
  text = escapeHtml(text);

  // Docs references [[Page#Section|label]] become non-editable chips (swapped back in at the end)
  const refChips: string[] = [];
  text = text.replace(/\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g, (m) => {
    refChips.push(refChipHtml(m.slice(2, -2)));
    return `\u0000${refChips.length - 1}\u0000`;
  });
  // Ticket keys (KAN-12) outside inline code become pills too
  const keyRe = keyPattern();
  if (keyRe) {
    text = text
      .split(/(```[\s\S]*?```|`[^`\n]*`)/)
      .map((seg, i) =>
        i % 2 === 1
          ? seg
          : seg.replace(keyRe, (key) => {
              refChips.push(keyChipHtml(key));
              return `\u0000${refChips.length - 1}\u0000`;
            }),
      )
      .join('');
  }

  // Images: ![alt](url) or ![alt|width](url)
  let out = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, rawAlt, url) => {
    if (url.startsWith('uploading:')) return '';
    const inlineCanvas = canvasRefOf(url);
    if (inlineCanvas) {
      return canvasChipElement(inlineCanvas.id, rawAlt, inlineCanvas.boardId ?? inlineCanvas.pageId).outerHTML;
    }
    if (!isSafeUrl(url)) return '';
    const src = url.startsWith('/uploads/') ? `${resolveOrigin()}${url}` : url;

    let alt = rawAlt;
    let widthAttr = '';
    let widthStyle = '';

    const sizeMatch = rawAlt.match(/^(.*?)\s*\|\s*(?:width=)?(\d+(?:%|px)?)(?:x(\d+(?:%|px)?))?$/i);
    const numOnlyMatch = !sizeMatch ? rawAlt.match(/^(\d+(?:%|px)?)$/) : null;

    if (sizeMatch) {
      alt = sizeMatch[1].trim();
      const w = sizeMatch[2];
      const parsedW = /^\d+$/.test(w) ? `${w}px` : w;
      widthAttr = `width="${w.replace(/px$/, '')}"`;
      widthStyle = `style="width: ${parsedW}; max-width: 100%; height: auto;"`;
    } else if (numOnlyMatch) {
      alt = '';
      const w = numOnlyMatch[1];
      const parsedW = /^\d+$/.test(w) ? `${w}px` : w;
      widthAttr = `width="${w.replace(/px$/, '')}"`;
      widthStyle = `style="width: ${parsedW}; max-width: 100%; height: auto;"`;
    }

    return `<img src="${src}" alt="${alt}" ${widthAttr} ${widthStyle} />`;
  });

  // Links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const canvas = canvasRefOf(url);
    if (canvas) return canvasChipElement(canvas.id, label, canvas.boardId ?? canvas.pageId).outerHTML;
    return isSafeUrl(url) ? `<a href="${url}">${label}</a>` : label;
  });

  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Inline code: `text`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Mark / Highlight: <mark>text</mark> or ==text==
  out = out.replace(/==([^=]+)==/g, '<mark>$1</mark>');

  // eslint-disable-next-line no-control-regex -- NUL is the placeholder delimiter
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => refChips[Number(i)]);
}

const CALLOUT_RE = /^\[!(NOTE|INFO|TIP|WARNING|DANGER|IMPORTANT|CAUTION)\]\s*(.*)$/i;

/** Callout kinds the editor offers; GitHub's IMPORTANT/CAUTION alerts map onto them. */
function calloutKind(raw: string): 'info' | 'warning' | 'danger' | 'tip' {
  const k = raw.toLowerCase();
  if (k === 'warning' || k === 'caution') return 'warning';
  if (k === 'danger') return 'danger';
  if (k === 'tip') return 'tip';
  return 'info';
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function indentWidth(ws: string): number {
  return ws.replace(/\t/g, '    ').length;
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += t[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    lines[i].includes('|') &&
    TABLE_SEP_RE.test(lines[i + 1]) &&
    lines[i + 1].includes('-') &&
    splitTableRow(lines[i]).length === splitTableRow(lines[i + 1]).length
  );
}

function renderTable(header: string[], aligns: string[], rows: string[][]): string {
  const cell = (tag: 'th' | 'td', text: string, idx: number) => {
    const a = aligns[idx];
    const attr = a ? ` style="text-align: ${a};" data-align="${a}"` : '';
    return `<${tag}${attr}>${formatInlineMarkdown(text)}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((h, i) => cell('th', h, i)).join('')}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows
        .map((r) => `<tr>${header.map((_, i) => cell('td', r[i] ?? '', i)).join('')}</tr>`)
        .join('')}</tbody>`
    : '';
  return `<table>${head}${body}</table>`;
}

function renderListLevel(items: ListItem[], state: { i: number }, indent: number): string {
  const first = items[state.i];
  const tag = first.ordered ? 'ol' : 'ul';
  let out = `<${tag}>`;
  while (state.i < items.length && items[state.i].indent === indent && items[state.i].ordered === first.ordered) {
    const item = items[state.i];
    state.i++;
    const task = item.text.match(/^\[( |x|X)\]\s+(.*)$/);
    let inner: string;
    let liAttr = '';
    if (task) {
      const checked = task[1].toLowerCase() === 'x';
      liAttr = ' data-task="1"';
      inner = `<input type="checkbox" contenteditable="false"${checked ? ' checked' : ''}> ${formatInlineMarkdown(task[2])}`;
    } else {
      inner = formatInlineMarkdown(item.text);
    }
    if (state.i < items.length && items[state.i].indent > indent) {
      inner += renderListLevel(items, state, items[state.i].indent);
    }
    out += `<li${liAttr}>${inner}</li>`;
  }
  return `${out}</${tag}>`;
}

/** Convert Markdown to HTML for the contentEditable editor. */
export function markdownToHtml(md: string): string {
  if (!md || !md.trim()) return '<p><br></p>';

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const htmlParts: string[] = [];

  let inCodeBlock = false;
  let codeLang = '';
  let codeBlockContent: string[] = [];
  let inAlign: 'center' | 'right' | null = null;
  let alignContent: string[] = [];

  const codeHtml = () => {
    const cls = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
    return `<pre><code${cls}>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block ```
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        htmlParts.push(codeHtml());
        codeBlockContent = [];
        inCodeBlock = false;
        codeLang = '';
      } else {
        inCodeBlock = true;
        codeBlockContent = [];
        codeLang = line
          .trimStart()
          .slice(3)
          .trim()
          .split(/\s+/)[0]
          .replace(/[^\w+#.-]/g, '');
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Align container ::: center / ::: right / :::
    if (line.trim() === '::: center') {
      inAlign = 'center';
      alignContent = [];
      continue;
    }
    if (line.trim() === '::: right') {
      inAlign = 'right';
      alignContent = [];
      continue;
    }
    if (line.trim() === ':::' && inAlign) {
      const innerHtml = markdownToHtml(alignContent.join('\n'));
      htmlParts.push(`<div style="text-align: ${inAlign};">${innerHtml}</div>`);
      inAlign = null;
      alignContent = [];
      continue;
    }
    if (inAlign) {
      alignContent.push(line);
      continue;
    }

    // Blank line
    if (!line.trim()) continue;

    // A sketch on its own line: ![label](sketch:sk_…)
    const sketchLine = SKETCH_LINE.exec(line.trim());
    if (sketchLine) {
      htmlParts.push(sketchBlockElement(sketchLine[2], sketchLine[1]).outerHTML);
      continue;
    }

    // A canvas on its own line: ![label](canvas:cv_…[#b_…])
    const canvasLine = CANVAS_LINE.exec(line.trim());
    if (canvasLine) {
      htmlParts.push(canvasBlockElement(canvasLine[2], canvasLine[1], canvasLine[3]).outerHTML);
      continue;
    }

    // A diagram on its own line: [label](diagram:dg_…)
    const diagramLine = DIAGRAM_LINE.exec(line.trim());
    if (diagramLine) {
      htmlParts.push(diagramBlockHtml(diagramLine[2], diagramLine[1]));
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      htmlParts.push('<hr>');
      continue;
    }

    // Headings (# .. ######)
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      htmlParts.push(`<h${level}>${formatInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    // Blockquote: merge consecutive "> " lines into one quote, blank ">" = paragraph break
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      i--;
      const paras: string[] = [];
      let cur: string[] = [];
      for (const q of quoteLines) {
        if (!q.trim()) {
          if (cur.length) paras.push(cur.join('<br>'));
          cur = [];
        } else {
          cur.push(formatInlineMarkdown(q));
        }
      }
      if (cur.length) paras.push(cur.join('<br>'));
      const callout = quoteLines[0].match(CALLOUT_RE);
      if (callout) {
        const kind = calloutKind(callout[1]);
        // the marker is the first line of the first paragraph; keep any text that follows it
        const first = paras[0]?.replace(/^[^<]*?\[!\w+\]\s*(<br>)?/i, '') ?? '';
        const bodyParas = [...(first ? [first] : []), ...paras.slice(1)];
        htmlParts.push(
          `<blockquote data-callout="${kind}">${(bodyParas.length ? bodyParas : ['']).map((p) => `<p>${p || '<br>'}</p>`).join('')}</blockquote>`,
        );
        continue;
      }
      htmlParts.push(`<blockquote>${paras.map((p) => `<p>${p}</p>`).join('')}</blockquote>`);
      continue;
    }

    // Table
    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i]);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      htmlParts.push(renderTable(header, aligns, rows));
      i = j - 1;
      continue;
    }

    // Lists (bulleted, ordered, task, nested by indentation)
    if (LIST_RE.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (!m || HR_RE.test(lines[i])) break;
        items.push({ indent: indentWidth(m[1]), ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      i--;
      const state = { i: 0 };
      while (state.i < items.length) {
        htmlParts.push(renderListLevel(items, state, items[state.i].indent));
      }
      continue;
    }

    // Regular paragraph line
    htmlParts.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  if (inCodeBlock) htmlParts.push(codeHtml());

  return htmlParts.join('\n');
}

/**
 * Traverses an HTMLElement and serializes its content into clean, standard Markdown.
 */
export function htmlToMarkdown(root: HTMLElement): string {
  // the id is checked against the real id shape, so nothing but dg_xxxxxxxx can come back out of the DOM
  const diagramLink = (el: HTMLElement, id: string) =>
    /^dg_[0-9a-f]{8}$/.test(id)
      ? `[${(el.getAttribute('data-label') || 'Diagram').replace(/[<>"'[\]\n]+/g, ' ')}](diagram:${id})`
      : '';

  const canvasLink = (el: HTMLElement, id: string, image: boolean) => {
    if (!/^cv_[0-9a-f]{8}$/.test(id)) return '';
    const frag = el.getAttribute('data-fragment');
    const fragment = frag && /^(b|p)_[0-9a-f]{8}$/.test(frag) ? `#${frag}` : '';
    return `${image ? '!' : ''}[${(el.getAttribute('data-label') || 'Canvas').replace(/[<>"'[\]\n]+/g, ' ')}](canvas:${id}${fragment})`;
  };

  const sketchLink = (el: HTMLElement, id: string) =>
    /^sk_[0-9a-f]{8}$/.test(id)
      ? `![${(el.getAttribute('data-label') || 'Sketch').replace(/[<>"'[\]\n]+/g, ' ')}](sketch:${id})`
      : '';

  function serializeInline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      // eslint-disable-next-line no-irregular-whitespace -- non-breaking space is matched on purpose
      return (node.nodeValue || '').replace(/ /g, ' ');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const inlineDiagramId = el.getAttribute('data-diagram');
    if (inlineDiagramId) return diagramLink(el, inlineDiagramId);
    const inlineSketchId = el.getAttribute('data-sketch');
    if (inlineSketchId) return sketchLink(el, inlineSketchId);
    const inlineCanvasChip = el.getAttribute('data-canvas-chip');
    if (inlineCanvasChip) return canvasLink(el, inlineCanvasChip, false);
    const inlineCanvasId = el.getAttribute('data-canvas');
    if (inlineCanvasId) return canvasLink(el, inlineCanvasId, true);

    const childrenText = Array.from(el.childNodes).map(serializeInline).join('');

    switch (tag) {
      case 'strong':
      case 'b':
        return childrenText ? `**${childrenText}**` : '';
      case 'em':
      case 'i':
        return childrenText ? `*${childrenText}*` : '';
      case 's':
      case 'del':
      case 'strike':
        return childrenText ? `~~${childrenText}~~` : '';
      case 'mark':
        return childrenText ? `<mark>${childrenText}</mark>` : '';
      case 'code':
        return childrenText ? `\`${childrenText}\`` : '';
      case 'a': {
        const href = el.getAttribute('href') || '#';
        return `[${childrenText || 'link'}](${href})`;
      }
      case 'img': {
        let src = el.getAttribute('src') || '';
        if (!src || src.startsWith('uploading:')) return '';
        try {
          if (src.startsWith('http://') || src.startsWith('https://')) {
            const urlObj = new URL(src);
            if (urlObj.pathname.startsWith('/uploads/')) {
              src = urlObj.pathname;
            }
          }
        } catch {
          // ignore
        }
        const alt = el.getAttribute('alt') || '';

        // Extract width if resized
        let width = el.getAttribute('width') || '';
        if (!width && el.style.width) {
          const match = el.style.width.match(/^(\d+(?:px|%)?)/);
          if (match) width = match[1].replace(/px$/, '');
        }

        if (width && width !== 'auto') {
          return `![${alt ? `${alt}|${width}` : width}](${src})`;
        }
        return `![${alt}](${src})`;
      }
      case 'br':
        return '\n';
      case 'span':
        if (el.hasAttribute('data-key')) return el.getAttribute('data-key') ?? '';
        return el.hasAttribute('data-ref') ? `[[${el.getAttribute('data-ref')}]]` : childrenText;
      case 'input':
        return '';
      default:
        return childrenText;
    }
  }

  /** Serialize a <ul>/<ol>, indenting nested lists under their parent item. */
  function serializeList(list: HTMLElement, indent: string): string {
    const ordered = list.tagName.toLowerCase() === 'ol';
    const lines: string[] = [];
    let n = 0;
    for (const li of Array.from(list.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      n++;
      const task = li.getAttribute('data-task') === '1';
      const checkbox = li.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null;
      const marker = ordered ? `${n}. ` : '- ';
      const prefix = task ? `${marker}[${checkbox?.checked ? 'x' : ' '}] ` : marker;
      const text = Array.from(li.childNodes)
        .filter((c) => !(c.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/i.test((c as HTMLElement).tagName)))
        .map(serializeInline)
        .join('')
        .trim()
        .replace(/\n/g, ' ');
      lines.push(`${indent}${prefix}${text}`);
      for (const child of Array.from(li.children)) {
        if (/^(ul|ol)$/i.test(child.tagName)) {
          const nested = serializeList(child as HTMLElement, indent + ' '.repeat(marker.length));
          if (nested) lines.push(nested);
        }
      }
    }
    return lines.join('\n');
  }

  function serializeTable(table: HTMLElement): string {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cellText = (c: Element) =>
      Array.from(c.childNodes).map(serializeInline).join('').trim().replace(/\n/g, ' ').replace(/\|/g, '\\|');
    const matrix = rows.map((r) => Array.from(r.children).map((c) => c as HTMLElement));
    const cols = Math.max(...matrix.map((r) => r.length));
    const pad = (cells: string[]) => Array.from({ length: cols }, (_, i) => cells[i] ?? '');
    const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`;
    const aligns = Array.from({ length: cols }, (_, i) => {
      const a = matrix[0][i]?.getAttribute('data-align') || matrix[0][i]?.style.textAlign || '';
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
    });
    const out = [line(matrix[0].map(cellText)), `| ${aligns.join(' | ')} |`];
    for (const r of matrix.slice(1)) out.push(line(r.map(cellText)));
    return out.join('\n');
  }

  const BLOCK_TAG_RE = /^(p|div|ul|ol|h[1-6]|pre|table|blockquote|hr)$/i;

  /**
   * Serialize children that may mix inline runs and block elements (the browser's editor can
   * produce e.g. <p><ul>…</ul></p>): inline runs become paragraphs, blocks keep their own form.
   */
  function serializeMixed(el: HTMLElement): string {
    let out = '';
    let inlineRun = '';
    const flush = () => {
      if (inlineRun.trim()) out += `${inlineRun.trim()}\n\n`;
      inlineRun = '';
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAG_RE.test((child as HTMLElement).tagName)) {
        flush();
        out += serializeBlock(child);
      } else {
        inlineRun += serializeInline(child);
      }
    }
    flush();
    return out;
  }

  function hasBlockChild(el: HTMLElement): boolean {
    return Array.from(el.children).some((c) => BLOCK_TAG_RE.test(c.tagName));
  }

  function serializeBlock(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      // eslint-disable-next-line no-irregular-whitespace -- non-breaking space is matched on purpose
      const text = (node.nodeValue || '').replace(/ /g, ' ').trim();
      return text ? `${text}\n\n` : '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const textAlign = el.style.textAlign;
    const diagramId = el.getAttribute('data-diagram');
    if (diagramId) return `${diagramLink(el, diagramId)}\n\n`;
    const sketchId = el.getAttribute('data-sketch');
    if (sketchId) return `${sketchLink(el, sketchId)}\n\n`;
    const canvasId = el.getAttribute('data-canvas');
    if (canvasId) return `${canvasLink(el, canvasId, true)}\n\n`;

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return `${'#'.repeat(Number(tag[1]))} ${serializeInline(el)}\n\n`;
      case 'p': {
        if (hasBlockChild(el)) return serializeMixed(el);
        const inline = serializeInline(el);
        if (!inline.trim()) return '';
        if (textAlign === 'center') {
          return `::: center\n${inline}\n:::\n\n`;
        }
        if (textAlign === 'right') {
          return `::: right\n${inline}\n:::\n\n`;
        }
        return `${inline}\n\n`;
      }
      case 'blockquote': {
        const calloutType = el.getAttribute('data-callout');
        if (calloutType) {
          const body = (
            hasBlockChild(el) ? serializeMixed(el) : Array.from(el.childNodes).map(serializeInline).join('')
          )
            .trim()
            .replace(/\n\n+/g, '\n');
          return (
            [`> [!${calloutType.toUpperCase()}]`, ...body.split('\n').map((l) => (l ? `> ${l}` : '>'))].join('\n') +
            '\n\n'
          );
        }
        const inner = hasBlockChild(el)
          ? serializeMixed(el).trim().replace(/\n\n+/g, '\n\n')
          : Array.from(el.childNodes).map(serializeInline).join('').trim();
        return (
          inner
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n') + '\n\n'
        );
      }
      case 'pre': {
        const codeEl = el.querySelector('code');
        const code = codeEl?.textContent ?? el.textContent ?? '';
        const lang = (codeEl?.className.match(/language-([\w+#.-]+)/) || [])[1] || '';
        return `\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
      }
      case 'hr':
        return '---\n\n';
      case 'ul':
      case 'ol': {
        const out = serializeList(el, '');
        return out ? `${out}\n\n` : '';
      }
      case 'table': {
        const out = serializeTable(el);
        return out ? `${out}\n\n` : '';
      }
      case 'div': {
        if (textAlign === 'center') {
          const content = Array.from(el.childNodes).map(serializeBlock).join('').trim();
          return `::: center\n${content}\n:::\n\n`;
        }
        if (textAlign === 'right') {
          const content = Array.from(el.childNodes).map(serializeBlock).join('').trim();
          return `::: right\n${content}\n:::\n\n`;
        }
        return serializeMixed(el);
      }
      default: {
        const inline = serializeInline(el);
        return inline ? `${inline}\n\n` : '';
      }
    }
  }

  // Inline runs typed directly at the root (no <p>) must stay in one paragraph
  return serializeMixed(root).trim();
}
