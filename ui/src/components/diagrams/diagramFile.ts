/** The smallest valid empty drawing, used for "New draw.io drawing". */
export const EMPTY_DIAGRAM_XML =
  '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** Thrown for a file that cannot be opened as a draw.io diagram; the message is safe to show. */
export class DiagramFileError extends Error {}

function looksLikeDrawio(xml: string): boolean {
  return /<(mxfile|mxGraphModel)[\s>]/.test(xml);
}

/**
 * Read a `.drawio`, `.xml` or `.svg` file chosen or dropped by the person and return the draw.io XML.
 * An SVG must be one exported by draw.io with its data included (it carries the XML in `content`).
 * @param file - The file to read.
 */
export async function readDiagramFile(file: File): Promise<string> {
  if (file.size > MAX_IMPORT_BYTES) throw new DiagramFileError('That file is too large to import.');
  const text = await file.text();
  if (/\.svg$/i.test(file.name) || /^\s*<svg[\s>]/i.test(text) || /^\s*<\?xml[^>]*\?>\s*<svg[\s>]/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const content = doc.documentElement.getAttribute('content');
    if (!content || !looksLikeDrawio(content)) {
      throw new DiagramFileError(
        'This SVG has no draw.io data. Export it from draw.io with "Include a copy of my diagram" ticked.',
      );
    }
    return content;
  }
  if (!looksLikeDrawio(text)) throw new DiagramFileError('This is not a draw.io file (.drawio, .xml or .svg).');
  return text;
}

/**
 * Whether a drag carries files (so a page can show a drop target).
 * @param e - The drag event.
 */
export function dragHasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Pick the first draw.io-looking file from a list (by extension).
 * @param files - Dropped or chosen files.
 */
export function firstDiagramFile(files: FileList | File[] | null | undefined): File | null {
  return Array.from(files ?? []).find((f) => /\.(drawio|xml|svg)$/i.test(f.name)) ?? null;
}

/**
 * Turn an SVG text into a PNG blob at a scale (default 2x) for downloads and copy-as-image.
 * @param svgText - The SVG markup.
 * @param scale - Pixel ratio.
 */
export async function svgToPng(svgText: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not draw the diagram'));
      img.src = url;
    });
    const w = Math.max(1, Math.round((img.naturalWidth || 800) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 600) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not draw the diagram');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Save a blob as a file through a temporary link.
 * @param blob - Content.
 * @param name - File name.
 */
export function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * A file-name-safe version of a diagram label.
 * @param label - Diagram label.
 */
export function fileStem(label: string): string {
  return label.replace(/[^\w.-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'diagram';
}

/**
 * Decode a `data:` URI from draw.io's export into text (base64 or percent-encoded).
 * @param data - The `data:` URI or plain text.
 */
export function decodeExportData(data: string): string {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(data);
  if (!m) return data;
  if (m[1]) {
    const bin = atob(m[2]);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
  return decodeURIComponent(m[2]);
}
