// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { renderPptx } from './pptxRender';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rels = (...items: [string, string][]) =>
  `<Relationships xmlns="${REL}">${items.map(([id, t]) => `<Relationship Id="${id}" Type="x" Target="${t}"/>`).join('')}</Relationships>`;
const tree = (...shapes: string[]) => `<p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld>`;
const xfrm = (x: number, y: number, w: number, h: number) =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const box = (x: number, y: number, w: number, h: number, text: string, extra = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"/>${extra}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const pic = (rid: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="2" name="pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:srcRect l="10000" r="10000"/></p:blipFill><p:spPr>${xfrm(0, 0, 9525 * 100, 9525 * 50)}</p:spPr></p:pic>`;

function deck(slide: string, layout = tree(), master = tree()) {
  return zipSync({
    'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
    'ppt/slides/slide1.xml': strToU8(`<p:sld ${NS}>${slide}</p:sld>`),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(
      rels(['rId1', '../slideLayouts/slideLayout1.xml'], ['rId2', '../media/a.png']),
    ),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(`<p:sldLayout ${NS}>${layout}</p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(rels(['rId1', '../slideMasters/slideMaster1.xml'])),
    'ppt/slideMasters/slideMaster1.xml': strToU8(`<p:sldMaster ${NS}>${master}</p:sldMaster>`),
    'ppt/media/a.png': new Uint8Array([137, 80, 78, 71]),
  });
}

describe('renderPptx', () => {
  it('places a text box, its colour and size, and a cropped picture, in px', () => {
    const [s] = renderPptx(
      deck(
        tree(
          pic('rId2'),
          box(
            9525 * 10,
            9525 * 20,
            9525 * 300,
            9525 * 40,
            'Hello',
            '<a:solidFill><a:srgbClr val="FFEEDD"/></a:solidFill>',
          ),
        ),
      ),
      (_b, mime) => `blob:${mime}`,
    );
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    const [image, text] = s.shapes;
    expect(image.image).toEqual({ src: 'blob:image/png', crop: [0.1, 0, 0.1, 0] });
    expect(image.w).toBe(100);
    expect(text).toMatchObject({ x: 10, y: 20, w: 300, h: 40, fill: '#FFEEDD', geometry: 'rect' });
    expect(text.text?.anchor).toBe('center');
    expect(text.text?.paras[0]).toMatchObject({ align: 'center' });
    expect(text.text?.paras[0].runs[0]).toMatchObject({ text: 'Hello', bold: true, color: '#112233', font: 'Calibri' });
    expect(text.text?.paras[0].runs[0].sizePx).toBeCloseTo(32);
  });

  it('gives a placeholder the place its layout gives it', () => {
    const layout = tree(
      `<p:sp><p:nvSpPr><p:cNvPr id="1" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(9525 * 50, 9525 * 60, 9525 * 500, 9525 * 80)}</p:spPr></p:sp>`,
    );
    const slide = tree(
      `<p:sp><p:nvSpPr><p:cNvPr id="1" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    const [s] = renderPptx(deck(slide, layout), () => '');
    expect(s.shapes).toHaveLength(1);
    expect(s.shapes[0]).toMatchObject({ x: 50, y: 60, w: 500, h: 80 });
    expect(s.shapes[0].text?.paras[0].runs[0].text).toBe('Title');
  });

  it('keeps the text of a shape it cannot draw and refuses a file that is not a deck', () => {
    const star = box(0, 0, 9525 * 100, 9525 * 100, 'Star').replace('prst="rect"', 'prst="star5"');
    const [s] = renderPptx(deck(tree(star)), () => '');
    expect(s.shapes[0].geometry).toBe('none');
    expect(s.shapes[0].text?.paras[0].runs[0].text).toBe('Star');
    expect(() => renderPptx(zipSync({ 'a.txt': strToU8('x') }), () => '')).toThrow();
  });
});
