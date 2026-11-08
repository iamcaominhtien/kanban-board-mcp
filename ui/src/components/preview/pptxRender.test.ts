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
    expect(text).toMatchObject({ x: 10, y: 20, w: 300, h: 40, fill: { color: '#FFEEDD' }, geometry: 'rect' });
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

  it('keeps the text of a shape it has no outline for and refuses a file that is not a deck', () => {
    const star = box(0, 0, 9525 * 100, 9525 * 100, 'Curved').replace('prst="rect"', 'prst="curvedRightArrow"');
    const [s] = renderPptx(deck(tree(star)), () => '');
    expect(s.shapes[0].geometry).toBe('none');
    expect(s.shapes[0].text?.paras[0].runs[0].text).toBe('Curved');
    expect(() => renderPptx(zipSync({ 'a.txt': strToU8('x') }), () => '')).toThrow();
  });
});

const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
const frame = (inner: string, x = 0, y = 0, w = 9525 * 400, h = 9525 * 300) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="f"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm><a:graphic><a:graphicData uri="x">${inner}</a:graphicData></a:graphic></p:graphicFrame>`;

function deckWith(slideTree: string, extra: Record<string, string> = {}, slideRels: [string, string][] = []) {
  return zipSync({
    'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
    'ppt/slides/slide1.xml': strToU8(`<p:sld ${NS}>${slideTree}</p:sld>`),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(rels(['rId1', '../slideLayouts/slideLayout1.xml'], ...slideRels)),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(`<p:sldLayout ${NS}>${tree()}</p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(rels(['rId1', '../slideMasters/slideMaster1.xml'])),
    'ppt/slideMasters/slideMaster1.xml': strToU8(`<p:sldMaster ${NS}>${tree()}</p:sldMaster>`),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  });
}

describe('renderPptx: groups, tables, charts, SmartArt, styles', () => {
  it("scales a group's children from the group's child space to its box", () => {
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${9525 * 100}" y="${9525 * 50}"/><a:ext cx="${9525 * 200}" cy="${9525 * 100}"/><a:chOff x="0" y="0"/><a:chExt cx="${9525 * 100}" cy="${9525 * 50}"/></a:xfrm></p:grpSpPr>${box(0, 0, 9525 * 50, 9525 * 25, 'In group')}</p:grpSp>`;
    const [s] = renderPptx(deckWith(tree(group)), () => '');
    const g = s.shapes[0];
    expect(g).toMatchObject({ x: 100, y: 50, w: 200, h: 100, box: { x: 0, y: 0, w: 100, h: 50 } });
    expect(g.children).toHaveLength(1);
    expect(g.children?.[0]).toMatchObject({ w: 50, h: 25 });
  });

  it("reads a table with its default style, merged cells and a cell's own fill", () => {
    const cell = (text: string, extra = '', pr = '') =>
      `<a:tc${extra}><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr${pr}/></a:tc>`;
    const tbl =
      `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="${9525 * 100}"/><a:gridCol w="${9525 * 100}"/></a:tblGrid>` +
      `<a:tr h="${9525 * 30}">${cell('Head', ' gridSpan="2"')}<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr>` +
      `<a:tr h="${9525 * 30}">${cell('A')}<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="FFCC00"/></a:solidFill></a:tcPr></a:tc></a:tr></a:tbl>`;
    const [s] = renderPptx(deckWith(tree(frame(tbl))), () => '');
    const t = s.shapes[0].table;
    expect(t?.cols).toEqual([100, 100]);
    expect(t?.rows[0].cells).toHaveLength(1);
    expect(t?.rows[0].cells[0]).toMatchObject({ colSpan: 2 });
    expect(t?.rows[0].cells[0].text.paras[0].runs[0]).toMatchObject({ bold: true, color: '#ffffff' });
    expect(t?.rows[0].cells[0].fill?.color).toMatch(/^#/);
    expect(t?.rows[1].cells[1].fill).toEqual({ color: '#FFCC00' });
  });

  it('reads a chart: its type, categories, series and values', () => {
    const chartXml =
      `<c:chartSpace ${NS} ${C}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>` +
      `<c:ser><c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>2024</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="336699"/></a:solidFill></c:spPr>` +
      `<c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>` +
      `<c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>25</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;
    const [s] = renderPptx(
      deckWith(
        tree(frame('<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId5"/>')),
        { 'ppt/charts/chart1.xml': chartXml },
        [['rId5', '../charts/chart1.xml']],
      ),
      () => '',
    );
    expect(s.shapes[0].chart).toMatchObject({ kind: 'bar', title: 'Sales', legend: 'b', categories: ['Q1', 'Q2'] });
    expect(s.shapes[0].chart?.series[0]).toMatchObject({ name: '2024', values: [10, 25], color: '#336699' });
  });

  it('draws the shapes PowerPoint kept for a SmartArt graphic', () => {
    const dgm = `<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId7" r:lo="rId8"/>`;
    const data = `<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:extLst><a:ext><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId9"/></a:ext></dgm:extLst></dgm:dataModel>`;
    const drawing = `<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" ${NS}><dsp:spTree><dsp:sp><dsp:spPr>${xfrm(0, 0, 9525 * 100, 9525 * 40)}<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill></dsp:spPr><dsp:txBody><a:bodyPr/><a:p><a:r><a:t>Step</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>`;
    const [s] = renderPptx(
      deckWith(tree(frame(dgm)), { 'ppt/diagrams/data1.xml': data, 'ppt/diagrams/drawing1.xml': drawing }, [
        ['rId7', '../diagrams/data1.xml'],
        ['rId9', '../diagrams/drawing1.xml'],
      ]),
      () => '',
    );
    const inner = s.shapes[0].children?.[0];
    expect(inner).toMatchObject({ w: 100, h: 40, fill: { color: '#00AA00' } });
    expect(inner?.text?.paras[0].runs[0].text).toBe('Step');
  });

  it("takes a shape's text colour, fill and line from its style where it says nothing itself", () => {
    const theme = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`;
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 9525 * 100, 9525 * 40)}<a:prstGeom prst="rect"/></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr/><a:p><a:r><a:t>Hi</a:t></a:r></a:p></p:txBody></p:sp>`;
    const [s] = renderPptx(deckWith(tree(sp), { 'ppt/theme/theme1.xml': theme }), () => '');
    expect(s.shapes[0].fill).toEqual({ color: '#4472C4' });
    expect(s.shapes[0].line?.color).toBe('#4472C4');
    expect(s.shapes[0].text?.paras[0].runs[0].color).toBe('#FFFFFF');
  });
});
