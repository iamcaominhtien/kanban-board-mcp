/**
 * Crop (board C 12): a frame over the whole picture; drag the frame to move it, a corner to size it, or pick a shape
 * (Free, Original, 3:2, 1:1, 4:3, 16:9) and zoom. The page stores only the frame (`crop`, fractions of the original),
 * so the original stays untouched and the crop can be changed later.
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { normalizeCrop, setNodeAttrs, type Crop } from './commands';
import { Dialog, Seg } from './ui';

const SHAPES = [
  { value: 'free', label: 'Free' },
  { value: 'original', label: 'Original' },
  { value: '3:2', label: '3:2' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '16:9', label: '16:9' },
] as const;
type Shape = (typeof SHAPES)[number]['value'];

/**
 * A frame of `shape` centred on `c`, as large as fits, for a picture of `w` × `h`.
 * @param zoom - 1 for the largest frame, 2 for half its size…
 */
export function frameFor(shape: Shape, w: number, h: number, c: Crop, zoom = 1): Crop {
  if (shape === 'free') return c;
  const ratio =
    shape === 'original'
      ? w / h
      : (() => {
          const [a, b] = shape.split(':').map(Number);
          return a / b;
        })();
  // in fractions: width fraction / height fraction = ratio * h / w
  const k = (ratio * h) / w;
  let fw = 1;
  let fh = fw / k;
  if (fh > 1) {
    fh = 1;
    fw = k;
  }
  fw /= zoom;
  fh /= zoom;
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  return { x: Math.min(1 - fw, Math.max(0, cx - fw / 2)), y: Math.min(1 - fh, Math.max(0, cy - fh / 2)), w: fw, h: fh };
}

/** The crop dialog for the image at `pos`. */
export function CropDialog({ editor, pos, onClose }: { editor: Editor; pos: number; onClose: () => void }) {
  const node = editor.state.doc.nodeAt(pos);
  const src = typeof node?.attrs.src === 'string' ? node.attrs.src : '';
  const [frame, setFrame] = useState<Crop>(() => (node?.attrs.crop as Crop | null) ?? { x: 0, y: 0, w: 1, h: 1 });
  const [shape, setShape] = useState<Shape>('free');
  const [zoom, setZoom] = useState(1);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!nat || shape === 'free') return;
    setFrame((f) => frameFor(shape, nat.w, nat.h, f, zoom));
  }, [shape, zoom, nat]);

  const drag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const start = { x: e.clientX, y: e.clientY, f: frame };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / box.width;
      const dy = (ev.clientY - start.y) / box.height;
      const f = start.f;
      let next: Crop;
      if (mode === 'move') next = { ...f, x: f.x + dx, y: f.y + dy };
      else {
        const left = mode.endsWith('w');
        const top = mode.startsWith('n');
        const x = left ? f.x + dx : f.x;
        const y = top ? f.y + dy : f.y;
        const w = left ? f.w - dx : f.w + dx;
        const h = top ? f.h - dy : f.h + dy;
        next = { x, y, w, h };
        if (shape !== 'free' && nat) {
          // keep the shape: the height follows the width
          const fixed = frameFor(shape, nat.w, nat.h, { x: 0, y: 0, w: 1, h: 1 });
          next.h = (next.w * fixed.h) / fixed.w;
          if (top) next.y = f.y + f.h - next.h;
        }
      }
      setFrame(normalizeCrop(next) ?? { x: 0, y: 0, w: 1, h: 1 });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <Dialog
      title="Crop"
      onClose={onClose}
      width={620}
      testId="crop-dialog"
      footer={
        <>
          <button type="button" className="dk-btn-ghost" onClick={() => setFrame({ x: 0, y: 0, w: 1, h: 1 })}>
            Reset
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="dk-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dk-btn-primary"
            onClick={() => {
              setNodeAttrs(editor, pos, { crop: normalizeCrop(frame) });
              onClose();
            }}
          >
            Done
          </button>
        </>
      }
    >
      <div className="dk-crop-stage">
        <div ref={boxRef} className="dk-crop-box">
          <img
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          />
          <div
            className="dk-crop-frame"
            role="group"
            aria-label="Crop frame"
            style={{
              left: `${frame.x * 100}%`,
              top: `${frame.y * 100}%`,
              width: `${frame.w * 100}%`,
              height: `${frame.h * 100}%`,
            }}
            onPointerDown={drag('move')}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
              <span key={c} className={`dk-crop-h dk-crop-h-${c}`} onPointerDown={drag(c)} />
            ))}
          </div>
        </div>
        {nat && (
          <div className="dk-crop-size">
            {nat.w} × {nat.h}
          </div>
        )}
      </div>
      <Seg label="Shape" value={shape} onChange={setShape} options={SHAPES} wrap />
      <label className="dk-crop-zoom">
        Zoom
        <input
          type="range"
          min={1}
          max={4}
          step={0.1}
          value={zoom}
          disabled={shape === 'free'}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </label>
      <p className="dk-bp-note">Drag the picture to move it inside the frame. The original stays untouched.</p>
    </Dialog>
  );
}
