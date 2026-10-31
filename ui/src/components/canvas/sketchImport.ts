import { createSketch, type Sketch, type SketchOwnerKind } from '../../api/sketches';

interface SketchSource {
  format?: string;
  width: number;
  height: number;
  background?: 'white' | 'clear';
  layers: {
    visible?: boolean;
    opacity?: number;
    png?: string | null;
    texts?: { x: number; y: number; text: string; size: number; color: string; bold?: boolean }[];
  }[];
}

const load = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('A layer could not be read.'));
    img.src = src;
  });

/**
 * Draw an editable sketch source (a `.sketch.json`) into one flat PNG: the paper, then each visible layer with its
 * opacity and text, bottom to top.
 * @param doc - The parsed source.
 */
export async function flattenSketch(doc: SketchSource): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = doc.width;
  canvas.height = doc.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the sketch.');
  if (doc.background !== 'clear') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  for (const layer of doc.layers) {
    if (layer.visible === false) continue;
    ctx.globalAlpha = layer.opacity ?? 1;
    if (layer.png) ctx.drawImage(await load(layer.png), 0, 0, doc.width, doc.height);
    for (const t of layer.texts ?? []) {
      ctx.fillStyle = t.color;
      ctx.font = `${t.bold ? '700 ' : ''}${t.size}px sans-serif`;
      ctx.textBaseline = 'top';
      t.text.split('\n').forEach((line, i) => ctx.fillText(line, t.x, t.y + i * t.size * 1.2));
    }
  }
  ctx.globalAlpha = 1;
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture.'))), 'image/png'),
  );
}

/**
 * Turn a dropped `.sketch.json` file into a saved Sketch (so a canvas board can point at it).
 * @param file - The file.
 * @param owner - Who owns the new sketch.
 */
export async function importSketchFile(
  file: File,
  owner: { ownerKind: SketchOwnerKind; ownerId: string; projectId?: string },
): Promise<Sketch> {
  const text = await file.text();
  let doc: SketchSource;
  try {
    doc = JSON.parse(text) as SketchSource;
  } catch {
    throw new Error(`“${file.name}” is not a sketch file.`);
  }
  if (doc.format !== 'kanban-sketch' || !Array.isArray(doc.layers))
    throw new Error(`“${file.name}” is not a sketch file.`);
  const png = await flattenSketch(doc);
  return createSketch(owner, { png, source: text, title: file.name.replace(/\.(sketch\.json|sketch)$/i, '') });
}
