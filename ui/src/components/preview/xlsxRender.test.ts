// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { XlsxError, parseXlsxBook } from './xlsxRender';

const M = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rel = (...items: [string, string][]) =>
  `<Relationships xmlns="${REL}">${items.map(([id, t]) => `<Relationship Id="${id}" Target="${t}"/>`).join('')}</Relationships>`;

const styles = `<styleSheet ${M}>
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FF112233"/></left><bottom style="medium"><color rgb="FF000000"/></bottom></border></borders>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0"/>
</cellXfs>
<dxfs count="1"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;
const theme = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`;

const sheet = `<worksheet ${M} ${R}>
<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>
<sheetViews><sheetView showGridLines="0"><pane xSplit="1" ySplit="1" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="3" width="10" hidden="1"/></cols>
<sheetData>
<row r="1" ht="30"><c r="A1" s="3" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>1234.5</v></c><c r="D2" s="4"><v>0.25</v></c></row>
<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" s="2"><v>45000</v></c><c r="D3" s="4"><v>0.75</v></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A5:C6"/></mergeCells>
<conditionalFormatting sqref="B2:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>2000</formula></cfRule></conditionalFormatting>
<conditionalFormatting sqref="D2:D3"><cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FF000000"/><color rgb="FFFFFFFF"/></colorScale></cfRule></conditionalFormatting>
<drawing r:id="rId1"/>
</worksheet>`;

const drawing = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ${R}>
<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="x"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>`;
const chart = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:tx><c:strRef><c:f>Data!$B$1</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>Data!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

function book(extra: Record<string, string> = {}) {
  return zipSync(
    Object.fromEntries(
      Object.entries({
        'xl/workbook.xml': `<workbook ${M} ${R}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': rel(['rId1', 'worksheets/sheet1.xml']),
        'xl/sharedStrings.xml': `<sst ${M}><si><t>Title</t></si><si><t>Amount</t></si><si><r><t>Rich </t></r><r><t>text</t></r></si><si><t>Second</t></si></sst>`,
        'xl/styles.xml': styles,
        'xl/theme/theme1.xml': theme,
        'xl/worksheets/sheet1.xml': sheet,
        'xl/worksheets/_rels/sheet1.xml.rels': rel(['rId1', '../drawings/drawing1.xml']),
        'xl/drawings/drawing1.xml': drawing,
        'xl/drawings/_rels/drawing1.xml.rels': rel(['rId1', '../charts/chart1.xml']),
        'xl/charts/chart1.xml': chart,
        ...extra,
      }).map(([k, v]) => [k, strToU8(v)]),
    ),
  );
}

describe('parseXlsxBook', () => {
  const [s] = parseXlsxBook(book(), () => '').sheets;

  it('reads text, rich text and formatted numbers and dates', () => {
    expect(s.rows[0][0]?.text).toBe('Title');
    expect(s.rows[1][0]?.text).toBe('Rich text');
    expect(s.rows[1][1]?.text).toBe('$1,234.50');
    expect(s.rows[2][1]?.text).toBe('3/15/2023');
    expect(s.rows[1][3]?.text).toBe('25%');
  });

  it("reads a cell's fill (theme colour with a tint), font, border and alignment", () => {
    const look = s.rows[0][0]!.look;
    expect(look).toMatchObject({
      bold: true,
      color: '#FFFFFF',
      align: 'center',
      vAlign: 'center',
      wrap: true,
      font: 'Arial',
    });
    expect(look.fontPx).toBeCloseTo(14 * (96 / 72));
    expect(look.bg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(look.bg?.toLowerCase()).not.toBe('#4472c4');
    expect(look.borders[0]).toBe('1px solid #112233');
    expect(look.borders[3]).toBe('2px solid #000000');
  });

  it('reads sizes, hidden columns, merges, frozen panes, grid lines and the tab colour', () => {
    expect(s.colWidths[0]).toBeGreaterThan(120);
    expect(s.colWidths[2]).toBe(0);
    expect(s.rowHeights[0]).toBeCloseTo(40);
    expect(s.merges).toEqual([{ r1: 4, c1: 0, r2: 5, c2: 2 }]);
    expect(s).toMatchObject({ freezeRows: 1, freezeCols: 1, showGrid: false, tabColor: '#FF0000' });
    expect(parseXlsxBook(book(), () => '').sheets).toHaveLength(1); // the hidden sheet is left out
  });

  it('applies conditional formats: a rule with its own colours and a colour scale', () => {
    expect(s.rows[1][1]?.cf).toMatchObject({ bg: '#FFC7CE', color: '#9C0006' });
    expect(s.rows[1][3]?.cf?.bg).toBe('#000000');
    expect(s.rows[2][3]?.cf?.bg).toBe('#ffffff');
  });

  it('puts a chart at its anchor and takes its values from the cells when it holds none', () => {
    const shape = s.shapes[0];
    expect(shape.chart?.kind).toBe('bar');
    expect(shape.x).toBe(s.colWidths.slice(0, 4).reduce((a, b) => a + b, 0));
    expect(shape.chart?.series[0]).toMatchObject({ values: [1234.5, 45000] });
  });

  it('refuses a protected workbook and a file that is not one', () => {
    expect(() => parseXlsxBook(new Uint8Array([0xd0, 0xcf, 0x11]), () => '')).toThrow(XlsxError);
    expect(() => parseXlsxBook(new Uint8Array([1, 2, 3]), () => '')).toThrow(XlsxError);
  });
});
