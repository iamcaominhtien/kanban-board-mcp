// Small deterministic files for upload steps, written to a per-run temporary folder (never into the repo).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// A w x h PNG with a red/blue pattern.
export function png(w = 48, h = 32) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      raw[o] = on ? 200 : 20; raw[o + 1] = 30; raw[o + 2] = on ? 40 : 220;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-fixtures-'));
  const f = {
    dir,
    png: path.join(dir, 'pattern.png'),
    png2: path.join(dir, 'pasted.png'),
    txt: path.join(dir, 'notes.txt'),
    txtBody: 'Release notes\nline two with ünïcode\n',
    drawio: path.join(dir, 'flow.drawio'),
    md1: path.join(dir, 'alpha-guide.md'),
    md2: path.join(dir, 'beta-guide.md'),
  };
  fs.writeFileSync(f.drawio, '<mxfile host="e2e"><diagram id="d1" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Start" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell><mxCell id="3" value="End" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="240" y="40" width="120" height="60" as="geometry"/></mxCell><mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>');
  fs.writeFileSync(f.png, png(48, 32));
  fs.writeFileSync(f.png2, png(24, 24));
  fs.writeFileSync(f.txt, f.txtBody);
  fs.writeFileSync(f.md1, '# Alpha guide\n\nThis page explains the alpha flow.\n\n## Install\n\nRun the installer.\n');
  fs.writeFileSync(f.md2, '# Beta guide\n\nSecond imported page with a [link](https://example.com).\n\n- one\n- two\n');
  return f;
}
export function cleanFixtures(f) { try { fs.rmSync(f.dir, { recursive: true, force: true }); } catch {} }
