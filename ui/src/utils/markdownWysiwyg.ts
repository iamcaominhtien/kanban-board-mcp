/**
 * Utility functions to convert between Markdown and HTML for the WYSIWYG Editor (Approach B).
 * Strictly mirrors the styling and formatting from DescriptionMarkdown.dc.html.
 */

import { resolveOrigin } from '../api/resolveOrigin';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Allow only http(s), mailto, root-relative and plain relative URLs. */
export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed.replace(/[\u0000-\u0020]/g, ''));
}

function formatInlineMarkdown(text: string): string {
  // Strip any old uploading:... placeholder
  text = text.replace(/!\[Uploading [^\]]*\]\(uploading:[^)]+\)/g, '');

  // Escape raw HTML first so user text can never inject markup
  text = escapeHtml(text);

  // Images: ![alt](url) or ![alt|width](url)
  let out = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, rawAlt, url) => {
    if (url.startsWith('uploading:')) return '';
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
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
    isSafeUrl(url) ? `<a href="${url}">${label}</a>` : label,
  );

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

  return out;
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
        codeLang = line.trimStart().slice(3).trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, '');
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
  function serializeInline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.nodeValue || '').replace(/ /g, ' ');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

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
      const text = (node.nodeValue || '').replace(/ /g, ' ').trim();
      return text ? `${text}\n\n` : '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const textAlign = el.style.textAlign;

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
        const inner = hasBlockChild(el)
          ? serializeMixed(el).trim().replace(/\n\n+/g, '\n\n')
          : Array.from(el.childNodes).map(serializeInline).join('').trim();
        return inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n\n';
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
