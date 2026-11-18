import fs from 'node:fs';
import path from 'node:path';
import { ensureProject, createTicket, openTicket } from '../lib/ui.mjs';
import { makeFixtures, cleanFixtures, zipStored } from '../lib/fixtures.mjs';

// Notifications beyond 09 and 22: the person acts on rows (snooze, bring back, dismiss, clear, turn a kind off), the
// day card, clearing what is read, and Unmute in the notification settings; and the file previews 17 leaves out:
// the charts of a spreadsheet, the preset shapes, a custom shape, a table and a chart of a slide, a picture, code.
//
// Setup goes through the REST API (a member's mention, a publish by another person): the UI side is what the person
// sees and does with the rows. Another person is a request with `X-Actor`.
//
// Not covered: `GET` and `POST /notifications/day-card` and `POST /notifications/clear-read` are reached only by
// calls (no screen of the UI sends them; the day card the panel shows is written by the server's own loop in the
// evening), so they are checked here through the API and the screen they feed.

const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const rels = (items) => `${CT}<Relationships xmlns="${RELS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

// ---- a chart part: kind is the XML of the plot ('barChart', 'lineChart'...), series are {name, cats, vals, color?, ref?}
const strCache = (items) => `<c:strCache><c:ptCount val="${items.length}"/>${items.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:strCache>`;
const numCache = (items) => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${items.length}"/>${items.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache>`;
const fill = (hex) => `<c:spPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></c:spPr>`;
function series(list, { scatter = false, labels = false, points = null } = {}) {
  return list.map((s, i) => {
    const cat = scatter
      ? `<c:xVal><c:numRef><c:f>Sheet1!$A$2:$A$5</c:f>${numCache(s.cats)}</c:numRef></c:xVal>`
      : s.ref
        ? `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$5</c:f></c:strRef></c:cat>`
        : `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$5</c:f>${strCache(s.cats)}</c:strRef></c:cat>`;
    const val = scatter
      ? `<c:yVal><c:numRef><c:f>Sheet1!$B$2:$B$5</c:f>${numCache(s.vals)}</c:numRef></c:yVal>`
      : s.ref
        ? `<c:val><c:numRef><c:f>Sheet1!$${s.ref}$2:$${s.ref}$5</c:f></c:numRef></c:val>`
        : `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$5</c:f>${numCache(s.vals)}</c:numRef></c:val>`;
    const name = s.ref ? `<c:tx><c:strRef><c:f>Sheet1!$${s.ref}$1</c:f></c:strRef></c:tx>` : `<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f>${strCache([s.name])}</c:strRef></c:tx>`;
    const pts = points ? points.map((hex, k) => `<c:dPt><c:idx val="${k}"/>${fill(hex)}</c:dPt>`).join('') : '';
    const dl = labels ? '<c:dLbls><c:showVal val="1"/></c:dLbls>' : '';
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${name}${s.color ? fill(s.color) : ''}${pts}${dl}${cat}${val}${s.smooth ? '<c:smooth val="1"/>' : ''}</c:ser>`;
  }).join('');
}
function chartXml({ plot, title, legend = 'r', axes = true, min, max, grid = true, fmt }) {
  const ax = axes
    ? `<c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/>${min != null || max != null ? `<c:scaling>${max != null ? `<c:max val="${max}"/>` : ''}${min != null ? `<c:min val="${min}"/>` : ''}</c:scaling>` : ''}${grid ? '<c:majorGridlines/>' : ''}${fmt ? `<c:numFmt formatCode="${fmt}" sourceLinked="0"/>` : ''}</c:valAx>`
    : '';
  const t = title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>` : '';
  return `${CT}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:chart>${t}<c:plotArea>${plot}${ax}</c:plotArea>${legend ? `<c:legend><c:legendPos val="${legend}"/></c:legend>` : ''}</c:chart></c:chartSpace>`;
}
const Q = ['Q1', 'Q2', 'Q3', 'Q4'];
const CHARTS = [
  { title: 'Sales by quarter', plot: `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series([{ name: 'Sales', cats: Q, vals: [120, 80, 150, 95], color: 'C0504D' }, { name: 'Costs', cats: Q, vals: [60, 70, 90, 40], color: '4F81BD' }], { labels: true })}</c:barChart>`, fmt: '#,##0', legend: 'r' },
  { title: 'Stacked rows', plot: `<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/>${series([{ name: 'North', cats: Q, vals: [10, 20, 15, 5] }, { name: 'South', cats: Q, vals: [5, 10, 25, 15] }])}</c:barChart>`, legend: 'b' },
  { title: 'Share of the whole', plot: `<c:barChart><c:barDir val="col"/><c:grouping val="percentStacked"/>${series([{ name: 'Alpha', cats: Q, vals: [3, 4, 5, 6] }, { name: 'Beta', cats: Q, vals: [6, 4, 2, 1] }])}</c:barChart>`, legend: 't' },
  { title: 'Trend from cells', plot: `<c:lineChart><c:grouping val="standard"/>${series([{ name: 'Units', cats: Q, vals: [], ref: 'B', smooth: true }, { name: 'Price', cats: Q, vals: [], ref: 'C' }])}</c:lineChart>`, legend: 'l', min: 0, max: 200 },
  { title: 'Area of work', plot: `<c:areaChart><c:grouping val="standard"/>${series([{ name: 'Hours', cats: Q, vals: [30, 45, 38, 60] }])}</c:areaChart>`, legend: null },
  { title: 'Pie of quarters', plot: `<c:pieChart>${series([{ name: 'Share', cats: Q, vals: [40, 30, 20, 10] }], { labels: true, points: ['C0504D', '9BBB59', '8064A2', '4BACC6'] })}</c:pieChart>`, axes: false, legend: 'b' },
  { title: 'Doughnut', plot: `<c:doughnutChart>${series([{ name: 'Share', cats: Q, vals: [25, 25, 25, 25] }])}<c:holeSize val="60"/></c:doughnutChart>`, axes: false, legend: 'r' },
  { title: 'Scatter plot', plot: `<c:scatterChart>${series([{ name: 'Points', cats: [1, 2, 3, 4], vals: [2, 4, 3, 6] }], { scatter: true })}</c:scatterChart>`, legend: null },
];

function chartsWorkbook() {
  const row = (r, cells) => `<row r="${r}">${cells.map((v, c) => (typeof v === 'number' ? `<c r="${'ABC'[c]}${r}"><v>${v}</v></c>` : `<c r="${'ABC'[c]}${r}" t="inlineStr"><is><t>${v}</t></is></c>`)).join('')}</row>`;
  const rows = [['Quarter', 'Units', 'Price'], ['Q1', 120, 80], ['Q2', 80, 95], ['Q3', 150, 110], ['Q4', 95, 130]].map((r, i) => row(i + 1, r)).join('');
  // eight charts in two columns of four, each 6 columns wide and 14 rows high, below the data
  const anchors = CHARTS.map((c, i) => {
    const col = 4 + (i % 2) * 7;
    const rowAt = 1 + Math.floor(i / 2) * 15;
    return `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${rowAt}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 6}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${rowAt + 14}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');
  return zipStored([
    ['[Content_Types].xml', `${CT}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']])],
    ['xl/workbook.xml', `${CT}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']])],
    ['xl/worksheets/sheet1.xml', `${CT}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><sheetData>${rows}</sheetData><drawing r:id="rId1"/></worksheet>`],
    ['xl/worksheets/_rels/sheet1.xml.rels', rels([['rId1', 'drawing', '../drawings/drawing1.xml']])],
    ['xl/drawings/drawing1.xml', `${CT}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${anchors}</xdr:wsDr>`],
    ['xl/drawings/_rels/drawing1.xml.rels', rels(CHARTS.map((_, i) => [`rId${i + 1}`, 'chart', `../charts/chart${i + 1}.xml`]))],
    ...CHARTS.map((c, i) => [`xl/charts/chart${i + 1}.xml`, chartXml(c)]),
  ]);
}

// ---- a deck of two slides: preset shapes in a grid, and a custom shape, a connector, a group, a table and a chart
const PRESETS = [
  'rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon',
  'octagon', 'plus', 'star4', 'star5', 'star6', 'star7', 'star8', 'star10', 'star12', 'rightArrow',
  'leftArrow', 'upArrow', 'downArrow', 'chevron', 'homePlate', 'round1Rect', 'round2SameRect', 'round2DiagRect', 'snip1Rect', 'snip2SameRect',
  'donut', 'can', 'heart', 'wedgeEllipseCallout', 'wedgeRectCallout', 'wedgeRoundRectCallout', 'heptagon', 'decagon', 'dodecagon', 'flowChartPreparation',
  'flowChartInput', 'flowChartManualInput', 'flowChartMerge', 'flowChartExtract', 'flowChartOffpageConnector', 'flowChartPunchedCard', 'flowChartDelay', 'flowChartDocument', 'flowChartMagneticDisk', 'leftRightArrow',
  'upDownArrow', 'frame', 'leftBracket', 'rightBracket', 'leftBrace', 'rightBrace', 'arc', 'pie', 'chord', 'blockArc',
  'teardrop', 'moon', 'sun', 'lightningBolt', 'cloud', 'wave', 'doubleWave', 'foldedCorner', 'cube', 'mathPlus',
  'mathMinus', 'mathEqual', 'mathMultiply', 'flowChartDecision', 'flowChartData', 'flowChartManualOperation',
];
const COLORS = ['C0504D', '9BBB59', '8064A2', '4BACC6', 'F79646', '4F81BD'];
const shape = (id, prst, x, y, w, h, extra = '') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${prst}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${COLORS[id % COLORS.length]}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln></p:spPr></p:sp>`;

function shapesDeck() {
  const cell = 800000;
  const grid = PRESETS.map((prst, i) => shape(i + 10, prst, 150000 + (i % 10) * 880000, 650000 + Math.floor(i / 10) * 640000, cell, 520000)).join('');
  const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="150000" y="100000"/><a:ext cx="8000000" cy="450000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Shapes gallery</a:t></a:r></a:p></p:txBody></p:sp>`;
  const custom = `<p:sp><p:nvSpPr><p:cNvPr id="200" name="Custom"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="1800000" flipH="1"><a:off x="150000" y="5200000"/><a:ext cx="1400000" cy="900000"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="100"/></a:moveTo><a:lnTo><a:pt x="50" y="0"/></a:lnTo><a:cubicBezTo><a:pt x="80" y="20"/><a:pt x="100" y="60"/><a:pt x="100" y="100"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFCC00"/></a:gs><a:gs pos="100000"><a:srgbClr val="CC0000"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill><a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr></p:sp>`;
  const lines = ['line', 'straightConnector1', 'bentConnector3', 'curvedConnector3'].map((prst, i) => `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${210 + i}" name="${prst}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="${1800000 + i * 1500000}" y="5200000"/><a:ext cx="1200000" cy="800000"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom><a:ln w="25400"><a:solidFill><a:srgbClr val="1F5A31"/></a:solidFill>${i === 1 ? '<a:headEnd type="triangle"/><a:tailEnd type="triangle"/>' : i === 2 ? '<a:prstDash val="sysDot"/><a:tailEnd type="arrow"/>' : ''}</a:ln></p:spPr></p:cxnSp>`).join('');
  const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="220" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="7900000" y="5200000"/><a:ext cx="1000000" cy="900000"/><a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="1800000"/></a:xfrm></p:grpSpPr>${shape(221, 'ellipse', 0, 0, 1000000, 900000)}${shape(222, 'star5', 800000, 700000, 1000000, 900000)}</p:grpSp>`;
  const slide1 = `${CT}<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><p:cSld><p:spTree>${title}${grid}${custom}${lines}${group}</p:spTree></p:cSld></p:sld>`;
  const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="30" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="300000" y="3600000"/><a:ext cx="4200000" cy="900000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2100000"/><a:gridCol w="2100000"/></a:tblGrid><a:tr h="450000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Total</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr h="450000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>North</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>1234</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const frame = (id, rid, x, y) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="4300000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const title2 = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="150000" y="100000"/><a:ext cx="8000000" cy="450000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Chart and table</a:t></a:r></a:p></p:txBody></p:sp>`;
  const slide2 = `${CT}<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><p:cSld><p:spTree>${title2}${frame(31, 'rId1', 150000, 600000)}${frame(32, 'rId2', 4650000, 600000)}${tbl}</p:spTree></p:cSld></p:sld>`;
  return zipStored([
    ['[Content_Types].xml', `${CT}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', `${CT}<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml']])],
    ['ppt/slides/slide1.xml', slide1],
    ['ppt/slides/slide2.xml', slide2],
    ['ppt/slides/_rels/slide2.xml.rels', rels([['rId1', 'chart', '../charts/chart1.xml'], ['rId2', 'chart', '../charts/chart2.xml']])],
    ['ppt/charts/chart1.xml', chartXml(CHARTS[0])],
    ['ppt/charts/chart2.xml', chartXml(CHARTS[5])],
  ]);
}

export default {
  name: 'Notifications (snooze, dismiss, clear, day card, unmute) and previews (spreadsheet charts, slide shapes, picture, code)',
  async run(s) {
    const p = s.page;
    const fx = makeFixtures();
    const until = async (fn, what, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await fn()) return; } catch { /* look again */ }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await p.waitForTimeout(150);
      }
    };
    // One call to the REST API; `actor` makes it another person's call (the X-Actor header).
    const api = async (method, url, data, actor) => {
      const headers = { 'content-type': 'application/json' };
      if (actor) headers['X-Actor'] = actor;
      const r = await p.request.fetch(s.server.base + url, { method, data, headers });
      return { status: r.status(), body: await r.json().catch(() => null) };
    };
    const centre = () => p.getByRole('dialog', { name: 'Notifications' });
    const bell = () => p.getByRole('button', { name: /^Notifications(, (\d+ needs? you|unread updates|not connected))?$/ }).first();
    const counts = async () => (await api('GET', '/notifications/counts')).body;
    const rowsOf = async (query = 'view=page&filter=all') => (await api('GET', `/notifications?${query}`)).body.items;
    const rowByBody = (text) => p.locator('[data-row-id]').filter({ hasText: text });
    const updateRow = () => p.locator('[data-row-id]').filter({ hasText: /pages were published|published v2/ }).first();
    const openCentre = async () => {
      if (!(await centre().count())) await bell().click();
      await centre().waitFor();
    };
    const closeCentre = async () => {
      if (await centre().count()) { await centre().getByRole('button', { name: 'Close' }).click(); await centre().waitFor({ state: 'detached' }); }
    };
    const pages = {};
    let projectId;

    try {
      // ================================================================ notifications
      await s.step('set up: three people mention me on three pages, and another person publishes two pages I follow', async () => {
        await ensureProject(s);
        projectId = (await api('GET', '/projects')).body[0].id;
        await api('POST', `/projects/${projectId}/members`, { name: 'Me' });
        await api('POST', `/projects/${projectId}/members`, { name: 'Ada' });
        for (const name of ['Plans', 'Budget', 'Roadmap', 'News one', 'News two']) {
          const page = (await api('POST', `/projects/${projectId}/docs/pages`, { title: name, markdown: `# ${name}` })).body;
          const pub = await api('POST', `/docs/pages/${page.id}/publish`, { base_version: 0, note: 'first' });
          if (pub.status !== 200) throw new Error(`publish ${name}: ${JSON.stringify(pub.body)}`);
          pages[name] = page.id;
        }
        for (const name of ['Plans', 'Budget', 'Roadmap']) {
          const c = await api('POST', `/docs/pages/${pages[name]}/comments`, { kind: 'page', body: `Please look at ${name} @Me` }, 'Ada');
          if (c.status !== 201) throw new Error(`comment ${name}: ${JSON.stringify(c.body)}`);
        }
        for (const name of ['News one', 'News two']) {
          await api('PUT', '/notifications/follow', { scope: 'page', scope_id: pages[name], level: 'everything', project_id: projectId });
          await api('PUT', `/docs/pages/${pages[name]}/draft`, { markdown: `# ${name} again` }, 'Ada');
          const pub = await api('POST', `/docs/pages/${pages[name]}/publish`, { base_version: 1, note: 'second', notify: true }, 'Ada');
          if (pub.status !== 200) throw new Error(`publish v2 ${name}: ${JSON.stringify(pub.body)}`);
        }
        // the server writes the notifications from a background loop
        await until(async () => { const c = await counts(); return c.needs === 3 && c.updates === 1; }, 'three Needs you and one update row');
      });

      await s.step('the bell and the panel: three mentions under Needs you, the two publishes as one grouped row under Updates', async () => {
        await p.reload();
        await p.getByRole('button', { name: 'Notifications, 3 need you' }).waitFor({ timeout: 20000 });
        await bell().click();
        await centre().getByRole('tab', { name: /Needs you 3/ }).waitFor();
        await centre().getByRole('tab', { name: /Updates 1/ }).waitFor();
        for (const name of ['Plans', 'Budget', 'Roadmap']) await rowByBody(`Please look at ${name}`).first().waitFor();
        await p.getByText('Ada mentioned you').first().waitFor();
        await centre().getByRole('tab', { name: /^Updates/ }).click();
        // two pages published by the same person are one row that lists its items
        await updateRow().getByText('2 pages were published').waitFor();
        await updateRow().getByRole('button', { name: 'Show all 2' }).click();
        await updateRow().getByText('Ada published v2 of News one').waitFor();
        await updateRow().getByText('Ada published v2 of News two').waitFor();
        await centre().getByRole('tab', { name: /^Needs you/ }).click();
      });

      await s.step('Snooze from the row menu hides it from Needs you for an hour; the server keeps the time', async () => {
        const row = rowByBody('Please look at Plans').first();
        await row.hover();
        await row.getByRole('button', { name: 'Snooze' }).click();
        const menu = row.getByRole('menu');
        await menu.getByRole('menuitem', { name: '1 hour' }).waitFor();
        await menu.getByRole('menuitem', { name: 'Tomorrow morning 09:00' }).waitFor();
        await menu.getByRole('menuitem', { name: '1 hour' }).click();
        await rowByBody('Please look at Plans').waitFor({ state: 'detached' });
        await centre().getByRole('tab', { name: /Needs you 2/ }).waitFor();
        const c = await counts();
        if (c.snoozed !== 1 || c.needs !== 2) throw new Error(`counts: ${JSON.stringify(c)}`);
        const snoozed = (await rowsOf('view=page&filter=snoozed')).find((r) => /Plans/.test(r.body));
        const ahead = (Date.parse(snoozed.snoozed_until) - Date.now()) / 60000;
        if (!snoozed.snoozed || ahead < 55 || ahead > 61) throw new Error(`snoozed for ${ahead} minutes`);
      });

      await s.step('All notifications: the Snoozed filter says when it comes back, and "Bring back now" puts it among Needs you', async () => {
        await centre().getByRole('button', { name: 'All notifications' }).click();
        await p.getByRole('heading', { name: 'All notifications' }).waitFor();
        await p.getByRole('button', { name: /^Snoozed/ }).click();
        // a snoozed row shows its time instead of the comment; the page chip says which one it is
        const row = p.locator('[data-row-id]').filter({ hasText: /Snoozed until/ });
        await row.getByRole('button', { name: 'Plans' }).waitFor();
        await row.getByText(/Snoozed until \d\d:\d\d, back in (59 minutes|1 hour)\./).waitFor();
        await row.getByRole('button', { name: 'Bring back now' }).click();
        await row.waitFor({ state: 'detached' });
        const c = await counts();
        if (c.snoozed !== 0 || c.needs !== 3) throw new Error(`counts: ${JSON.stringify(c)}`);
        await p.getByRole('button', { name: /^Needs you/ }).first().click();
        await rowByBody('Please look at Plans').waitFor();
      });

      await s.step('keys on the page: J selects a row, S snoozes it for an hour, and the API brings it back with until null', async () => {
        // only a Needs you row snoozes by key: look at those
        await p.getByRole('button', { name: /^Needs you/ }).first().click();
        await rowByBody('Please look at Plans').waitFor();
        await p.keyboard.press('j');
        await p.locator('[data-row-id]').first().waitFor();
        await p.keyboard.press('s');
        await until(async () => (await counts()).snoozed === 1, 'the keyboard snooze');
        const gone = (await rowsOf('view=page&filter=snoozed'))[0];
        const back = await api('POST', `/notifications/${gone.id}/snooze`, { until: null });
        if (back.status !== 200 || back.body.snoozed !== false) throw new Error(`unsnooze: ${JSON.stringify(back)}`);
        await until(async () => (await counts()).snoozed === 0, 'the row to come back');
        // a time that is not a time is refused
        const bad = await api('POST', `/notifications/${gone.id}/snooze`, { until: 'tomorrow-ish' });
        if (bad.status !== 422) throw new Error(`a bad time answered ${bad.status}`);
      }, { expectConsole: true });

      await s.step('Dismiss closes a mention for good and the page shows it as done; an update cannot be dismissed', async () => {
        // the row's own Dismiss button is drawn only for a row whose target is gone and that cannot close alone (a mention
        // of an AI member), which needs an AI member's account: the call behind it is made here and the screen read
        const roadmap = (await rowsOf()).find((r) => /Roadmap/.test(r.body));
        if (!roadmap.dismissable) throw new Error('a mention cannot be dismissed');
        const dismissed = await api('POST', `/notifications/${roadmap.id}/dismiss`);
        if (dismissed.status !== 200 || !dismissed.body.done || !/^Dismissed by /.test(dismissed.body.done_text)) throw new Error(`dismiss: ${JSON.stringify(dismissed)}`);
        await until(async () => (await counts()).needs === 2, 'Needs you to drop to two');
        await p.getByRole('button', { name: /^All$/ }).click();
        await p.locator('[data-row-id]').filter({ hasText: /Done — dismissed by you/ }).getByRole('button', { name: 'Roadmap' }).waitFor();
        // an update is not dismissed: the server refuses
        const info = (await rowsOf()).find((r) => !r.needs);
        const refused = await api('POST', `/notifications/${info.id}/dismiss`);
        if (refused.status !== 409) throw new Error(`dismiss of an update answered ${refused.status}`);
      }, { expectConsole: true });

      await s.step('Clear (the x of an update) takes it off the lists, Cleared on the page keeps it, and the API puts it back', async () => {
        await p.getByRole('button', { name: /^All$/ }).click();
        const row = updateRow();
        await row.hover();
        await row.getByRole('button', { name: 'Clear' }).click();
        await row.waitFor({ state: 'detached' });
        const c = await counts();
        if (c.updates !== 0) throw new Error(`counts: ${JSON.stringify(c)}`);
        await p.getByRole('button', { name: /^Cleared/ }).click();
        await updateRow().waitFor();
        const cleared = (await rowsOf('view=page&filter=cleared')).find((r) => r.kind === 'page_published');
        const back = await api('POST', `/notifications/${cleared.id}/clear`, { on: false });
        if (back.status !== 200 || back.body.cleared) throw new Error(`clear off: ${JSON.stringify(back)}`);
        await updateRow().waitFor({ state: 'detached' });
        await p.getByRole('button', { name: /^All$/ }).click();
        await updateRow().waitFor();
        // clearing a Needs you row is refused: it closes when the work is done
        const needs = (await rowsOf()).find((r) => r.needs && !r.done);
        const bad = await api('POST', `/notifications/${needs.id}/clear`, { on: true });
        if (bad.status < 400) s.note('clear of a Needs you row', bad.status);
      }, { expectConsole: true });

      await s.step('"Turn this kind off" on an update mutes its kind: a toast says so and the notification settings list it', async () => {
        const row = updateRow();
        await row.hover();
        await row.getByRole('button', { name: 'More' }).click();
        await row.getByRole('menuitem', { name: 'Turn this kind off' }).click();
        await p.getByText('A page was published is off').waitFor();
        await p.getByText('You can turn it back on in Settings.').waitFor();
        const follows = (await api('GET', '/notifications/settings')).body;
        const muted = (follows.muted || []).find((m) => m.scope === 'kind');
        if (!muted) throw new Error(`no kind mute: ${JSON.stringify(follows.muted)}`);
        s.note('muted entry of a kind', { scope: muted.scope, level: muted.level });
      });

      await s.step('Unmute in the notification settings forgets the mute (DELETE /notifications/follow/:id) and the list shrinks', async () => {
        await p.getByRole('button', { name: 'Notification settings' }).first().click();
        await p.getByText(/Muted \(1\)/).waitFor();
        await p.getByText(/A page was published/).first().waitFor();
        const before = (await api('GET', '/notifications/settings')).body.muted;
        await Promise.all([
          p.waitForResponse((r) => r.request().method() === 'DELETE' && /\/notifications\/follow\//.test(r.url()) && r.status() === 200),
          p.getByRole('button', { name: 'Unmute' }).first().click(),
        ]);
        await p.getByText(/Muted \(0\)/).waitFor();
        const after = (await api('GET', '/notifications/settings')).body.muted;
        if (before.length !== 1 || after.length !== 0) throw new Error(`muted ${before.length} -> ${after.length}`);
        // a follow that is not there is not found
        const none = await api('DELETE', `/notifications/follow/${before[0].id}`);
        if (none.status !== 404) throw new Error(`a second unmute answered ${none.status}`);
      }, { expectConsole: true });

      await s.step('Mark all read, then clear-read clears the read updates (a call no screen sends)', async () => {
        await p.getByRole('button', { name: 'Back to board' }).click().catch(() => {});
        await openCentre();
        await centre().getByRole('button', { name: 'Mark all read' }).click();
        await until(async () => (await counts()).unread === 0, 'every row to be read');
        const r = await api('POST', '/notifications/clear-read');
        if (r.status !== 200 || r.body.cleared < 1) throw new Error(`clear-read: ${JSON.stringify(r)}`);
        // Needs you rows stay; the updates read are off the lists
        const c = await counts();
        if (c.updates !== 0 || c.needs < 1) throw new Error(`counts after clear-read: ${JSON.stringify(c)}`);
        s.note('clear-read cleared', r.body.cleared);
      });

      await s.step('the day card: its preview says what it holds, writing it puts it first in Updates, and Board health is offered', async () => {
        const preview = await api('GET', '/notifications/day-card?preview=true');
        if (preview.status !== 200 || !preview.body.preview || !Array.isArray(preview.body.preview.lines)) throw new Error(`preview: ${JSON.stringify(preview)}`);
        const written = await api('POST', '/notifications/day-card');
        if (written.status !== 200 || written.body.written !== 1) throw new Error(`day-card: ${JSON.stringify(written)}`);
        const card = await api('GET', '/notifications/day-card');
        if (!card.body.card) throw new Error('no card after writing');
        await p.reload();
        await bell().waitFor();
        await bell().click();
        await centre().getByRole('tab', { name: /^Updates/ }).click();
        await centre().getByText('AI runs finished').first().waitFor();
        await centre().getByText('still wait for you').first().waitFor();
        await centre().getByText('Not metered').first().waitFor();
        await centre().getByRole('button', { name: 'Board health' }).waitFor();
        await centre().getByRole('button', { name: 'Open', exact: true }).first().waitFor();
        await closeCentre();
      });

      // ================================================================ previews
      const pv = {
        charts: path.join(fx.dir, 'charts.xlsx'),
        shapes: path.join(fx.dir, 'shapes.pptx'),
        code: path.join(fx.dir, 'tool.py'),
      };
      fs.writeFileSync(pv.charts, chartsWorkbook());
      fs.writeFileSync(pv.shapes, shapesDeck());
      fs.writeFileSync(pv.code, 'def total(items):\n    """Sum of the prices."""\n    return sum(i.price for i in items)\n\n\nclass Cart:\n    def __init__(self):\n        self.items = []\n');
      const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
      const viewer = () => p.getByRole('dialog', { name: /^Preview of / });
      // a picture is a thumbnail that says "view", every other file a chip that says "preview"
      const chip = (name) => dlg().locator(`[title="Click to ${/\.png$/.test(name) ? 'view' : 'preview'} ${name}"]`);
      const attach = async (file) => {
        await dlg().locator('input[type="file"][accept="*/*"]').first().setInputFiles(file);
        await dlg().getByText(path.basename(file)).first().waitFor({ timeout: 15000 });
        await s.settle();
      };
      const openPreview = async (name) => {
        await chip(name).scrollIntoViewIfNeeded();
        await chip(name).click();
        const v = p.getByRole('dialog', { name: `Preview of ${name}` });
        await v.waitFor();
        return v;
      };
      const closePreview = async () => {
        await viewer().getByRole('button', { name: 'Close', exact: true }).click();
        await viewer().waitFor({ state: 'detached' });
      };

      await s.step('set up: a ticket with a spreadsheet of charts, a deck of shapes, a picture and a code file', async () => {
        await p.getByRole('button', { name: 'Back to board' }).click().catch(() => {});
        await p.reload();
        await createTicket(s, { title: 'Files with pictures' });
        await openTicket(s, 'ALP-1');
        await dlg().getByRole('button', { name: 'Edit description' }).click();
        await dlg().locator('[contenteditable="true"]').first().click();
        await p.keyboard.type('Files to look at:');
        await p.keyboard.press('Enter');
        for (const f of [pv.charts, pv.shapes, fx.png, pv.code]) await attach(f);
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        await dlg().getByText('ATTACHMENTS · 4').waitFor({ timeout: 10000 });
      });

      await s.step('Excel: eight charts are drawn over the cells, each of its kind, with title, legend and labels', async () => {
        const v = await openPreview('charts.xlsx');
        await v.getByLabel('Sheet1 sheet').waitFor({ timeout: 15000 });
        await v.getByText('Quarter').first().waitFor();
        for (const t of ['Sales by quarter', 'Stacked rows', 'Share of the whole', 'Trend from cells', 'Area of work', 'Pie of quarters', 'Doughnut', 'Scatter plot']) {
          await v.locator('svg text', { hasText: t }).first().waitFor({ timeout: 10000 });
        }
        const sheet = v.getByLabel('Sheet1 sheet');
        const charts = await sheet.locator('svg:has(text)').count();
        if (charts < 8) throw new Error(`${charts} charts drawn`);
        // the clustered bars: series names in the legend, the data labels (showVal) and the value format
        for (const t of ['Sales', 'Costs']) await v.locator('svg text', { hasText: new RegExp(`^${t}$`) }).first().waitFor();
        for (const t of ['120', '80', '150', '95']) await v.locator('svg text', { hasText: new RegExp(`^${t}$`) }).first().waitFor();
        // a chart whose series carry no values reads them from the cells (the line chart): Units and Price
        await v.locator('svg text', { hasText: /^Units$/ }).first().waitFor();
        await v.locator('svg text', { hasText: /^Price$/ }).first().waitFor();
        // bars are rects, the line and the area are paths, the pie is wedges
        const rects = await sheet.locator('svg rect').count();
        const paths = await sheet.locator('svg path, svg polyline, svg polygon').count();
        if (rects < 10 || paths < 6) throw new Error(`marks: ${rects} rects, ${paths} paths`);
        await v.getByRole('searchbox', { name: 'Search cells' }).fill('Q3');
        await v.getByText('Q3').first().waitFor();
        await closePreview();
      });

      await s.step('PowerPoint: the preset shapes, a custom shape with a gradient, connectors with arrowheads and a group are drawn', async () => {
        const v = await openPreview('shapes.pptx');
        await v.getByText(/Slide 1 of 2/).waitFor({ timeout: 15000 });
        const canvas = v.getByTestId('slide-canvas').last();
        await canvas.waitFor();
        await v.getByRole('button', { name: /^Slide 1: Shapes gallery/ }).waitFor();
        await v.getByRole('button', { name: /^Slide 2: Chart and table/ }).waitFor();
        // 74 preset shapes: the plain ones are boxes, the others each draw paths
        const svgs = await canvas.locator('svg').count();
        const paths = await canvas.locator('svg path').count();
        if (svgs < 60 || paths < 70) throw new Error(`${svgs} drawings, ${paths} paths`);
        // arrowheads of the connector with both ends, the dashed custom shape and its gradient
        if ((await canvas.locator('marker').count()) < 3) throw new Error('no arrowheads');
        if ((await canvas.locator('linearGradient').count()) < 1) throw new Error('no gradient');
        if ((await canvas.locator('path[stroke-dasharray]').count()) < 2) throw new Error('no dashed lines');
        await canvas.getByText('Shapes gallery').waitFor();
        s.note('slide 1 drawings', { svgs: svgs > 60, paths: paths > 70 });
      });

      await s.step('PowerPoint: the second slide has a table and two charts; the outline mode lists the text', async () => {
        const v = viewer();
        await v.getByRole('button', { name: /^Slide 2: Chart and table/ }).click();
        const canvas = v.getByTestId('slide-canvas').last();
        await canvas.getByText('Chart and table').waitFor();
        await canvas.getByText('Region').waitFor();
        await canvas.getByText('1234').waitFor();
        await canvas.locator('svg text', { hasText: 'Sales by quarter' }).waitFor();
        await canvas.locator('svg text', { hasText: 'Pie of quarters' }).waitFor();
        // the pie's wedges carry the colours of their points
        const wedges = await canvas.locator('svg path[fill="#C0504D"], svg path[fill="#9BBB59"]').count();
        if (wedges < 2) throw new Error(`${wedges} coloured wedges`);
        await v.getByTestId('slides-mode').click();
        await v.getByText('Showing the outline.').waitFor();
        await closePreview();
      });

      await s.step('Picture: fit, zoom, actual size, rotate, background and the keys of the viewer', async () => {
        const v = await openPreview('pattern.png');
        const img = v.getByRole('img', { name: 'pattern.png' }).first();
        await img.waitFor({ timeout: 15000 });
        const bar = v.getByRole('toolbar', { name: 'Image controls' });
        const zoom = bar.locator('[aria-live="polite"]');
        const label = async () => (await zoom.innerText()).trim();
        const labelIs = async (re, what) => { await until(async () => re.test(await label()), `the zoom label to be ${what}`).catch(async (e) => { throw new Error(`${e.message}; it is "${await label()}"`); }); };
        await labelIs(/^Fit$/, 'Fit');
        await bar.getByRole('button', { name: 'Zoom in' }).click();
        await labelIs(/^\d+%$/, 'a percentage');
        await bar.getByRole('button', { name: 'Zoom out' }).click();
        await bar.getByRole('button', { name: 'Fit' }).click();
        await labelIs(/^Fit$/, 'Fit again');
        await bar.getByRole('button', { name: '100%' }).click();
        await labelIs(/^(100%|Fit)$/, '100%');
        await bar.getByRole('button', { name: 'Rotate' }).click();
        await until(async () => /rotate\(90deg\)/.test((await img.getAttribute('style')) || ''), 'the picture to turn');
        await p.keyboard.press('r');
        await until(async () => /rotate\(180deg\)/.test((await img.getAttribute('style')) || ''), 'the second turn by key');
        await p.keyboard.press('0');
        await labelIs(/^Fit$/, 'Fit by key');
        await p.keyboard.press('+');
        await labelIs(/^\d+%$/, 'a percentage by key');
        await p.keyboard.press('-');
        // the stage: a double click toggles between fitting and a zoom
        await v.locator('[class*="imageStage"]').dblclick();
        await until(async () => (await label()) !== '', 'the label after a double click');
        await v.getByRole('button', { name: 'Background' }).click();
        await v.getByRole('menuitemradio', { name: 'Light' }).click();
        await v.getByRole('button', { name: 'Background' }).click();
        await v.getByRole('menuitemradio', { name: 'Checkerboard' }).click();
        await v.getByRole('button', { name: 'Background' }).click();
        await v.getByRole('menuitemradio', { name: 'Checkerboard' }).and(p.locator('[aria-checked="true"]')).waitFor();
        await v.getByRole('button', { name: /^(Copy image|Copied|Copy failed)$/ }).click();
        await v.getByRole('button', { name: /^(Copied|Copy failed)$/ }).waitFor();
        await v.getByRole('button', { name: 'Details' }).click();
        const aside = p.getByRole('complementary', { name: 'Details' });
        await aside.getByText('48 × 32').waitFor();
        await closePreview();
      });

      await s.step('Code: the file is shown with its text and its own search', async () => {
        const v = await openPreview('tool.py');
        const body = v.getByLabel('File contents');
        await body.waitFor({ timeout: 15000 });
        await body.getByText('class Cart').waitFor();
        await v.getByRole('searchbox', { name: 'Search in file' }).fill('price');
        await v.getByRole('button', { name: 'Next match' }).click();
        await v.getByRole('button', { name: 'Previous match' }).click();
        await closePreview();
      });
    } finally {
      cleanFixtures(fx);
    }
  },
};
