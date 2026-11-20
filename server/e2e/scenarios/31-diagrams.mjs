import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { makeFixtures, cleanFixtures } from '../lib/fixtures.mjs';
import { ensureProject, createTicket, openTicket, newDocPage, home } from '../lib/ui.mjs';

// The app ships no draw.io editor here, so the scenario runs a stand-in: a small web server on a free local port that
// answers with a page speaking draw.io's embed protocol (init / load / autosave / save / export over postMessage).
// The page shows the loaded XML in a textarea; typing in it posts an `autosave`, the "Ctrl+S" button posts a `save`.
// The Settings screen points the editor address at it (self-hosted mode); the board's own check reaches it with a TCP
// connection, so it has to be a real listener (a browser-side route would not be seen by the server).
const STAND_IN = `<!doctype html><meta charset="utf-8"><title>Stand-in draw.io</title>
<body style="font:14px sans-serif;margin:8px">
<h3 style="margin:0 0 6px">Stand-in draw.io editor</h3>
<textarea id="xml" rows="14" cols="90" aria-label="Diagram XML"></textarea><br>
<button id="ctrls" type="button">Ctrl+S</button> <span id="state" role="status">waiting</span>
<script>
const send = (m) => parent.postMessage(JSON.stringify(m), '*');
const ta = document.getElementById('xml');
const state = document.getElementById('state');
const enc = (s) => btoa(unescape(encodeURIComponent(s)));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function svg() {
  const vals = [...ta.value.matchAll(/ value="([^"]+)"/g)].map((m) => m[1]);
  const text = vals.map((v, i) => '<text x="12" y="' + (28 + i * 22) + '" font-size="16">' + esc(v) + '</text>').join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140" viewBox="0 0 320 140"><rect x="1" y="1" width="318" height="138" fill="#fff" stroke="#2e6f40"/>' + text + '</svg>';
}
window.addEventListener('message', (e) => {
  if (e.source !== parent || typeof e.data !== 'string') return;
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.action === 'load') { ta.value = m.xml; state.textContent = 'loaded ' + (m.title || ''); send({ event: 'load' }); }
  else if (m.action === 'export') {
    const body = m.format === 'svg' ? svg() : ta.value;
    send({ event: 'export', format: m.format, data: 'data:' + (m.format === 'svg' ? 'image/svg+xml' : 'application/xml') + ';base64,' + enc(body) });
  }
});
ta.addEventListener('input', () => send({ event: 'autosave', xml: ta.value }));
document.getElementById('ctrls').addEventListener('click', () => send({ event: 'save', xml: ta.value }));
send({ event: 'init' });
</script>`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function standIn(port) {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(STAND_IN); });
  const sockets = new Set();
  srv.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  return {
    start: () => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); }),
    stop: () => new Promise((resolve) => { for (const c of sockets) c.destroy(); srv.listening ? srv.close(() => resolve()) : resolve(); }),
  };
}

export default {
  name: 'Diagrams: draw.io editor (stand-in), save, versions, exports, import, drop, settings',
  async run(s) {
    const p = s.page;
    const fx = makeFixtures();
    const port = await freePort();
    const editorUrl = `http://127.0.0.1:${port}`;
    const editor = standIn(port);
    const base = s.server.base;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const ed = () => p.getByRole('dialog', { name: 'Diagram editor' });
    const frame = () => p.frameLocator('iframe[title="draw.io editor"]');
    const xmlBox = () => frame().getByRole('textbox', { name: 'Diagram XML' });
    const source = fs.readFileSync(fx.drawio, 'utf8');
    const edited = source.replace('value="Start"', 'value="Begin"');
    const api = async (path, opts) => {
      const r = await p.request.fetch(`${base}${path}`, opts);
      return { status: r.status(), json: await r.json().catch(() => null) };
    };
    const download = async (click) => {
      const [dl] = await Promise.all([p.waitForEvent('download'), click()]);
      return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
    };
    const must = (cond, msg) => { if (!cond) throw new Error(msg); };
    let projectId = '';
    let diagramId = '';
    let editorOpen = false;
    // settings: Integrations > Diagrams (draw.io)
    const diagSettings = () => p.getByTestId('diagram-settings');
    // the app sidebar's gear (the Docs editor also has a 'Settings' button, so the role and name alone are ambiguous)
    const openDiagramSettings = async () => {
      if (!(await p.getByRole('navigation', { name: 'Settings pages' }).count())) await p.locator('button[title="Settings"][class*="_sidebarIcon"]').click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Integrations', exact: true }).click();
      await diagSettings().waitFor();
    };
    const openEditorWait = async () => { await frame().getByRole('textbox', { name: 'Diagram XML' }).waitFor({ timeout: 15000 }); };
    // wait until the stand-in's textarea holds `text` (a textarea's value is not text content, so poll it)
    const waitXml = async (text) => {
      const fr = await (await p.locator('iframe[title="draw.io editor"]').elementHandle()).contentFrame();
      await fr.waitForFunction((x) => document.getElementById('xml')?.value.includes(x), text, { timeout: 8000 });
    };
    const typeXml = async (xml) => { await xmlBox().fill(xml); };
    const embed = () => dlg().getByTestId('diagram-embed').first();
    const hoverEmbed = async () => { await embed().hover(); };
    const reloadTicket = async () => {
      await p.reload();
      await p.getByText('Design the login flow').first().waitFor({ timeout: 15000 });
      await dlg().waitFor({ timeout: 2500 }).catch(() => {});
      if (!(await dlg().count())) await openTicket(s, 'ALP-1');
    };
    const goTicket = async () => {
      if (!(await dlg().count())) await openTicket(s, 'ALP-1');
    };

    try {
      await s.step('set up: a project with a ticket and the draw.io settings pointed at a dead address', async () => {
        await ensureProject(s);
        await createTicket(s, { title: 'Design the login flow' });
        projectId = (await api('/projects')).json[0].id;
        await p.locator('button[title="Settings"][class*="_sidebarIcon"]').click();
        await openDiagramSettings();
        await diagSettings().getByRole('radio', { name: /Self-hosted/ }).waitFor();
      });

      await s.step('settings: choosing Public hides the address, Self-hosted shows it; Save is off until something changes', async () => {
        const c = diagSettings();
        const save = c.getByRole('button', { name: 'Save', exact: true });
        await c.getByRole('radio', { name: /Public diagrams.net/ }).check();
        await c.getByRole('textbox', { name: 'Editor address' }).waitFor({ state: 'detached' });
        await c.getByRole('radio', { name: /Self-hosted/ }).check();
        await c.getByRole('textbox', { name: 'Editor address' }).waitFor();
        s.note('Save disabled when nothing changed', await save.isDisabled());
      });

      await s.step('settings: save an editor address nobody answers at', async () => {
        const c = diagSettings();
        await c.getByRole('textbox', { name: 'Editor address' }).fill(editorUrl);
        await c.getByRole('button', { name: 'Save', exact: true }).click();
        await c.getByText('Saved', { exact: true }).waitFor();
        const got = await api('/diagrams/settings');
        must(got.json.mode === 'self-hosted' && got.json.url === editorUrl, `settings not stored: ${JSON.stringify(got.json)}`);
        s.note('settings after save', { mode: got.json.mode, builtIn: got.json.builtInAvailable ?? got.json.built_in_available });
      });

      await s.step('ticket: a new diagram while no editor answers shows "Editor could not be reached" with the admin hint', async () => {
        // the page waits for the server's check before loading the editor, so the dead address is never loaded (the
        // iframe used to start loading it at the same time as the check)
        const deadLoads = [];
        const onReq = (r) => { if (r.url().startsWith(editorUrl)) deadLoads.push(r.url()); };
        p.on('request', onReq);
        await home(s);
        await openTicket(s, 'ALP-1');
        await dlg().getByRole('button', { name: 'Edit description' }).click();
        await dlg().locator('[contenteditable="true"]').first().click();
        await p.keyboard.type('Login flow:');
        await p.keyboard.press('Enter');
        await dlg().getByRole('button', { name: 'Diagram' }).click();
        await p.getByRole('menuitem', { name: 'New draw.io drawing' }).click();
        await ed().getByText('Editor could not be reached').waitFor();
        await ed().getByText('For admins: no draw.io editor is running').click();
        await ed().getByText(editorUrl).waitFor();
        await ed().getByRole('button', { name: 'Use the public editor' }).waitFor();
        p.off('request', onReq);
        must(deadLoads.length === 0, `the dead editor address was loaded: ${deadLoads.join(', ')}`);
      });

      await s.step('no editor: Download .drawio hands over the empty drawing, Retry still finds nothing', async () => {
        const f = await download(() => ed().getByRole('button', { name: 'Download .drawio' }).click());
        must(/\.drawio$/.test(f.name) && f.data.toString().includes('<mxfile'), `unexpected download ${f.name}`);
        s.note('local download name', f.name);
        await ed().getByRole('button', { name: 'Retry' }).click();
        await ed().getByText('Editor could not be reached').waitFor();
      });

      await s.step('no editor: start the stand-in, Retry opens it and the blank drawing loads', async () => {
        await editor.start();
        await ed().getByRole('button', { name: 'Retry' }).click();
        await openEditorWait();
        await frame().getByText(/^loaded Untitled-diagram\.drawio/).waitFor();
        await ed().getByRole('button', { name: 'Save to page' }).waitFor();
        await p.waitForFunction(() => !document.querySelector('[data-testid="diagram-editor-unreachable"]'));
        must(!(await ed().getByRole('button', { name: 'Save to page' }).isDisabled()), 'Save should be enabled once loaded');
        s.note('blank drawing is the empty mxfile', (await xmlBox().inputValue()).includes('<mxCell id="1" parent="0"/>'));
      });

      await s.step('editor: retitle, draw (autosave from the editor) and the header says a draft is kept', async () => {
        await ed().getByRole('textbox', { name: 'Diagram title' }).fill('Login flow');
        await typeXml(source);
        await ed().getByText('Draft kept in this browser').waitFor();
        must(await ed().getByText('Saves to:').count() === 1, 'the header should say where it saves to');
        const keys = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kanban.diagram.draft.')));
        must(keys.length === 1, `expected one draft in localStorage, got ${keys.length}`);
      });

      await s.step('editor: Export menu gives .drawio, .svg and a 2x PNG', async () => {
        const open = () => ed().getByRole('button', { name: 'Export' }).click();
        await open();
        const x = await download(() => p.getByRole('menuitem', { name: /Editable file/ }).click());
        must(x.name === 'Login-flow.drawio' && x.data.toString().includes('value="Start"'), `drawio export wrong: ${x.name}`);
        await open();
        const v = await download(() => p.getByRole('menuitem', { name: /Vector image/ }).click());
        must(v.name === 'Login-flow.svg' && v.data.toString().includes('<svg'), `svg export wrong: ${v.name}`);
        await open();
        const g = await download(() => p.getByRole('menuitem', { name: /Image, 2/ }).click());
        must(g.name === 'Login-flow.png' && g.data[1] === 0x50 && g.data[2] === 0x4e, `png export wrong: ${g.name}`);
        s.note('png size 2x of 320x140', { bytesAbove100: g.data.length > 100 });
      });

      await s.step('editor: Save to page creates the diagram and puts it into the description', async () => {
        await ed().getByRole('button', { name: 'Save to page' }).click();
        await ed().waitFor({ state: 'detached' });
        await dlg().locator('[data-diagram]').first().waitFor();
        diagramId = await dlg().locator('[data-diagram]').first().getAttribute('data-diagram');
        const keys = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kanban.diagram.draft.')));
        must(keys.length === 0, 'the draft should be gone after saving');
        // leave the description editor so the text is saved
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        await embed().waitFor();
      });

      await s.step('api: the stored .drawio and the picture are what the editor sent', async () => {
        const d = await api(`/diagrams/${diagramId}?source=true`);
        must(d.status === 200 && d.json.label === 'Login flow' && d.json.version === 1, `diagram ${JSON.stringify(d.json).slice(0, 200)}`);
        must(d.json.source.includes('value="Start"'), 'source not stored');
        must(d.json.itemKind === 'ticket' || d.json.item_kind === 'ticket', 'diagram should belong to the ticket');
        const svg = await p.request.get(`${base}/diagrams/${diagramId}/svg`);
        must((await svg.text()).includes('Start'), 'svg preview should be the editor\'s picture');
        const dl = await p.request.get(`${base}/diagrams/${diagramId}/download?format=drawio`);
        must((await dl.text()) === source, 'download should return the stored source');
        s.note('diagram after first save', { version: d.json.version, previewKind: d.json.previewKind ?? d.json.preview_kind, empty: d.json.empty });
      });

      await s.step('reload: the ticket still shows the diagram with its footer', async () => {
        await reloadTicket();
        await embed().waitFor();
        await embed().getByText('Login flow').waitFor();
        await embed().getByText(/^Added by/).waitFor();
        must(await embed().locator('img').evaluate((i) => i.complete && i.naturalWidth > 0), 'diagram picture should have loaded');
      });

      await s.step('reopen: Edit loads the stored drawing; Cancel with changes asks, Keep editing stays, Discard leaves', async () => {
        await hoverEmbed();
        await dlg().getByRole('toolbar', { name: 'Diagram actions' }).getByRole('button', { name: 'Edit' }).click();
        await openEditorWait();
        must((await xmlBox().inputValue()) === source, 'the editor should open on the stored source');
        await typeXml(edited);
        await ed().getByText('Draft kept in this browser').waitFor();
        await ed().getByRole('button', { name: 'Cancel' }).click();
        const ask = p.getByRole('alertdialog', { name: 'Discard your changes?' });
        await ask.waitFor();
        await ask.getByRole('button', { name: 'Keep editing' }).click();
        await ask.waitFor({ state: 'detached' });
        await ed().getByRole('button', { name: 'Cancel' }).click();
        await ask.getByRole('button', { name: 'Discard' }).click();
        await ed().waitFor({ state: 'detached' });
        const d = await api(`/diagrams/${diagramId}`);
        must(d.json.version === 1, 'discarding must not save');
      });

      await s.step('reopen: an unsaved draft comes back ("Restored your unsaved draft"), Discard draft returns to the stored one', async () => {
        await hoverEmbed();
        await dlg().getByRole('toolbar', { name: 'Diagram actions' }).getByRole('button', { name: 'Edit' }).click();
        await openEditorWait();
        await typeXml(edited);
        await ed().getByText('Draft kept in this browser').waitFor();
        // close the tab-like layer without discarding: leave the draft by reloading the page
        await reloadTicket();
        await hoverEmbed();
        await dlg().getByRole('toolbar', { name: 'Diagram actions' }).getByRole('button', { name: 'Edit' }).click();
        await ed().getByText('Restored your unsaved draft from this browser.').waitFor();
        await openEditorWait();
        await frame().getByText(/^loaded Login-flow\.drawio/).waitFor();
        must((await xmlBox().inputValue()).includes('value="Begin"'), 'the draft should be loaded');
        await ed().getByRole('button', { name: 'Discard draft' }).click();
        await ed().getByText('Restored your unsaved draft from this browser.').waitFor({ state: 'detached' });
        await waitXml('value="Start"');
      });

      await s.step('editor: Ctrl+S inside the editor saves a new version (v2) and the footer says Edited', async () => {
        await typeXml(edited);
        await ed().getByText('Draft kept in this browser').waitFor();
        await frame().getByRole('button', { name: 'Ctrl+S' }).click();
        await ed().waitFor({ state: 'detached' });
        await embed().getByText(/^Edited by/).waitFor();
        const d = await api(`/diagrams/${diagramId}?source=true`);
        must(d.json.version === 2 && d.json.source.includes('value="Begin"'), `v2 expected: ${d.json.version}`);
      });

      await s.step('conflict: someone saves a newer version, Save shows the banner and "Reload theirs" loads theirs', async () => {
        await hoverEmbed();
        await dlg().getByRole('toolbar', { name: 'Diagram actions' }).getByRole('button', { name: 'Edit' }).click();
        await openEditorWait();
        await typeXml(source.replace('value="End"', 'value="Mine"'));
        await ed().getByText('Draft kept in this browser').waitFor();
        const theirs = source.replace('value="End"', 'value="Theirs"');
        const put = await api(`/diagrams/${diagramId}`, { method: 'PUT', data: { baseVersion: 2, base_version: 2, source: theirs, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', label: 'Login flow' } });
        must(put.status === 200, `side save failed ${put.status} ${JSON.stringify(put.json)}`);
        await ed().getByRole('button', { name: 'Save to page' }).click();
        await ed().getByTestId('diagram-conflict').waitFor();
        await ed().getByRole('button', { name: 'Reload theirs' }).click();
        await ed().getByTestId('diagram-conflict').waitFor({ state: 'detached' });
        await waitXml('value="Theirs"');
      }, { expectConsole: true });

      await s.step('conflict: a second newer version, "Save as copy" keeps mine as a new diagram', async () => {
        await typeXml(source.replace('value="End"', 'value="Mine too"'));
        const put = await api(`/diagrams/${diagramId}`, { method: 'PUT', data: { baseVersion: 3, base_version: 3, source: source.replace('value="End"', 'value="Theirs 2"'), svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' } });
        must(put.status === 200, `side save failed ${put.status}`);
        await ed().getByRole('button', { name: 'Save to page' }).click();
        await ed().getByTestId('diagram-conflict').waitFor();
        await ed().getByRole('button', { name: 'Save as copy' }).click();
        await ed().waitFor({ state: 'detached' });
        const list = await api(`/projects/${projectId}/diagrams`);
        const labels = (list.json?.diagrams ?? list.json ?? []).map((d) => d.label);
        s.note('diagram labels after the copy', labels);
        must(labels.some((l) => /\(copy\)$/.test(l)), `a "(copy)" diagram should exist: ${JSON.stringify(labels)}`);
      }, { expectConsole: true });

      await s.step('viewer: the full-size view opens from the toolbar, zooms with the buttons and keys, and closes with Escape', async () => {
        await goTicket();
        await hoverEmbed();
        await dlg().getByRole('button', { name: 'View full size' }).first().click();
        const v = p.getByRole('dialog', { name: /, full size$/ });
        await v.waitFor();
        const zoom = v.locator('[aria-live="polite"]');
        await zoom.getByText('100%').waitFor();
        await v.getByRole('button', { name: 'Zoom in' }).click();
        await zoom.getByText('120%').waitFor();
        await v.getByRole('button', { name: 'Zoom out' }).click();
        await zoom.getByText('100%').waitFor();
        await p.keyboard.press('+');
        await zoom.getByText('120%').waitFor();
        await p.keyboard.press('-');
        await p.keyboard.press('=');
        await zoom.getByText('120%').waitFor();
        await v.getByRole('button', { name: 'Reset zoom' }).click();
        await zoom.getByText('100%').waitFor();
        const cv = v.getByTestId('diagram-canvas');
        const bb = await cv.boundingBox();
        await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await p.mouse.wheel(0, -300);
        await p.waitForFunction(() => /^(1[1-9]\d|[2-9]\d\d)%$/.test(document.querySelector('[role="dialog"][aria-label$="full size"] [aria-live="polite"]')?.textContent || ''));
        await p.keyboard.press('0');
        await zoom.getByText('100%').waitFor();
        await p.mouse.down();
        await p.mouse.move(bb.x + bb.width / 2 + 60, bb.y + bb.height / 2 + 30, { steps: 5 });
        await p.mouse.up();
      });

      await s.step('viewer: its Download menu gives .drawio, .svg and PNG; Copy as image toasts; the close button leaves', async () => {
        const v = p.getByRole('dialog', { name: /, full size$/ });
        const menu = () => v.getByRole('menu', { name: 'Download' });
        await v.getByRole('button', { name: 'Download' }).click();
        const x = await download(() => menu().getByRole('menuitem', { name: /Editable file/ }).click());
        must(/\.drawio$/.test(x.name) && x.data.toString().includes('<mxfile'), `viewer drawio ${x.name}`);
        await v.getByRole('button', { name: 'Download' }).click();
        const sv = await download(() => menu().getByRole('menuitem', { name: /Vector image/ }).click());
        must(/\.svg$/.test(sv.name) && sv.data.toString().includes('<svg'), `viewer svg ${sv.name}`);
        await v.getByRole('button', { name: 'Download' }).click();
        const g = await download(() => menu().getByRole('menuitem', { name: /Image, 2/ }).click());
        must(/\.png$/.test(g.name), `viewer png ${g.name}`);
        await v.getByRole('button', { name: 'Download' }).click();
        await menu().getByRole('menuitem', { name: 'Copy as image' }).click();
        await p.getByText('Copied as image').first().waitFor();
        await v.getByRole('button', { name: 'Close' }).click();
        await v.waitFor({ state: 'detached' });
      });

      await s.step('embed: clicking the picture opens the viewer, Escape closes only the viewer', async () => {
        await embed().locator('img').click();
        const v = p.getByRole('dialog', { name: /, full size$/ });
        await v.waitFor();
        await p.keyboard.press('Escape');
        await v.waitFor({ state: 'detached' });
        await dlg().waitFor();
      });

      await s.step('embed: the Download menu (.drawio, .svg, PNG, Copy as image) and Copy link', async () => {
        await hoverEmbed();
        const tb = dlg().getByRole('toolbar', { name: 'Diagram actions' }).first();
        const menu = () => dlg().getByRole('menu', { name: 'Download' });
        await tb.getByRole('button', { name: 'Download' }).click();
        const x = await download(() => menu().getByRole('menuitem', { name: /Editable file/ }).click());
        must(x.data.toString().includes('<mxfile'), 'embed drawio download');
        await tb.getByRole('button', { name: 'Download' }).click();
        const sv = await download(() => menu().getByRole('menuitem', { name: /Vector image/ }).click());
        must(sv.data.toString().includes('<svg'), 'embed svg download');
        await tb.getByRole('button', { name: 'Download' }).click();
        const g = await download(() => menu().getByRole('menuitem', { name: /Image, 2/ }).click());
        must(g.data[1] === 0x50, 'embed png download');
        await tb.getByRole('button', { name: 'Download' }).click();
        await menu().getByRole('menuitem', { name: 'Copy as image' }).click();
        await p.getByText('Copied as image').first().waitFor();
        await tb.getByRole('button', { name: 'Copy link' }).click();
        await p.getByText('Link copied').first().waitFor();
        await tb.getByRole('button', { name: 'Download' }).click();
        await menu().waitFor();
        await p.keyboard.press('Escape');
        await menu().waitFor({ state: 'detached' });
        await dlg().waitFor();
      });

      await s.step('embed: a diagram with a text summary offers "Text summary"', async () => {
        const saved = await api(`/projects/${projectId}/diagrams`, {
          method: 'POST',
          data: { label: 'With summary', source, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="5" y="30">Start to End</text></svg>', summary: 'Start leads to End.', itemKind: 'ticket', item_kind: 'ticket' },
        });
        must(saved.status === 201 || saved.status === 200, `create failed ${saved.status} ${JSON.stringify(saved.json)}`);
        // click at the top left, on the first paragraph: the middle of the button is the diagram, which swallows clicks
        await dlg().getByRole('button', { name: 'Edit description' }).click({ position: { x: 4, y: 4 } });
        const ce = dlg().locator('[contenteditable="true"]').first();
        await ce.click({ position: { x: 10, y: 10 } });
        await p.keyboard.press('Control+End');
        await p.keyboard.press('Enter');
        await p.keyboard.type(`[With summary](diagram:${saved.json.id})`);
        await p.keyboard.press('Enter');
        await dlg().getByText('Description', { exact: true }).first().click();
        await s.settle(2500);
        const e2 = dlg().locator(`[data-diagram="${saved.json.id}"]`).first();
        await e2.waitFor();
        await e2.getByText('Text summary').click();
        await e2.getByText('Start leads to End.').waitFor();
      });

      await s.step('close the ticket, open the Docs page editor and add a diagram with the /diagram command', async () => {
        await dlg().getByRole('button', { name: 'Close', exact: true }).click();
        await dlg().waitFor({ state: 'detached' });
        await p.getByRole('button', { name: 'Docs', exact: true }).click();
        await p.getByRole('complementary', { name: /^Docs space/ }).waitFor();
        await newDocPage(s, 'Architecture');
        const body = p.locator('.dk-editor [contenteditable="true"]').first();
        await body.click();
        await p.keyboard.type('Overview');
        await p.keyboard.press('Enter');
        await p.keyboard.type('/diagram');
        await p.getByRole('option', { name: /New draw\.io drawing/ }).first().click().catch(async () => { await p.getByText('New draw.io drawing').first().click(); });
        await openEditorWait();
        await ed().getByText('Docs ›').waitFor();
        await ed().getByRole('textbox', { name: 'Diagram title' }).fill('System context');
        await typeXml(source.replace('value="End"', 'value="Database"'));
        await ed().getByText('Draft kept in this browser').waitFor();
        await ed().getByRole('button', { name: 'Save to page' }).click();
        await ed().waitFor({ state: 'detached' });
        await p.getByTestId('diagram-embed').first().waitFor();
      });

      await s.step('docs page: the diagram belongs to the page (API) and the saved page keeps the line', async () => {
        const id = await p.getByTestId('diagram-embed').first().getAttribute('data-diagram');
        const d = await api(`/diagrams/${id}`);
        must((d.json.itemKind ?? d.json.item_kind) === 'doc', `diagram should belong to the doc: ${JSON.stringify(d.json).slice(0, 200)}`);
        await p.getByText(/^Saved/).waitFor();
        await s.settle(2500);
      });

      await s.step('docs page: "Import .drawio file" from the slash menu opens the file in the editor', async () => {
        const body = p.locator('.dk-editor [contenteditable="true"]').first();
        await body.click();
        await p.keyboard.press('Control+End');
        await p.keyboard.press('Enter');
        await p.keyboard.type('/import');
        const [chooser] = await Promise.all([
          p.waitForEvent('filechooser'),
          p.getByRole('option', { name: /Import \.drawio file/ }).first().click().catch(async () => { await p.getByText('Import .drawio file').first().click(); }),
        ]);
        await chooser.setFiles(fx.drawio);
        await openEditorWait();
        await frame().getByText(/^loaded flow\.drawio/).waitFor();
        must((await xmlBox().inputValue()) === source, 'the imported file should be loaded unchanged');
        await ed().getByRole('button', { name: 'Save to page' }).click();
        await ed().waitFor({ state: 'detached' });
        await p.getByTestId('diagram-embed').nth(1).waitFor();
      });

      const fileDrag = async (name, text, type) => {
        await p.evaluate(({ name, text, type }) => {
          const dt = new DataTransfer();
          dt.items.add(new File([text], name, { type }));
          window.__dt = dt;
          const el = document.querySelector('[data-testid="editor-scroll"]');
          el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        }, { name, text, type });
      };

      await s.step('docs page: dragging a diagram file over the page shows the drop zone; dropping opens it in the editor', async () => {
        await fileDrag('dropped.drawio', source.replace('value="End"', 'value="Dropped"'), '');
        const zone = p.getByTestId('diagram-drop-zone');
        await zone.getByText('Drop a diagram file here').waitFor();
        await p.evaluate(() => {
          document.querySelector('[data-testid="diagram-drop-zone"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
        });
        await zone.waitFor({ state: 'detached' });
        await openEditorWait();
        await frame().getByText(/^loaded dropped\.drawio/).waitFor();
        must((await xmlBox().inputValue()).includes('value="Dropped"'), 'dropped file should be loaded');
        await ed().getByRole('button', { name: 'Cancel' }).click();
        await ed().waitFor({ state: 'detached' });
      });

      await s.step('docs page: the drop zone\'s "Choose file" opens the picker and the pick opens in the editor', async () => {
        await fileDrag('picked.drawio', source, '');
        const zone = p.getByTestId('diagram-drop-zone');
        await zone.getByText('Drop a diagram file here').waitFor(); // the zone itself is a 0-height sticky box
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), zone.getByRole('button', { name: 'Choose file' }).click()]);
        await chooser.setFiles(fx.drawio);
        await openEditorWait();
        await frame().getByText(/^loaded flow\.drawio/).waitFor();
        await ed().getByRole('button', { name: 'Cancel' }).click();
        await ed().waitFor({ state: 'detached' });
        await p.evaluate(() => document.querySelector('[data-testid="editor-scroll"]').dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: window.__dt })));
        await zone.waitFor({ state: 'detached' });
      });

      await s.step('docs page: a file that is not a draw.io diagram is refused with a toast', async () => {
        const input = p.getByTestId('diagram-file-input');
        await input.setInputFiles({ name: 'notes.drawio', mimeType: 'text/plain', buffer: Buffer.from('just some words') });
        await p.getByText("Couldn't import the file").first().waitFor();
        await p.getByText('This is not a draw.io file').first().waitFor();
        await input.setInputFiles({ name: 'plain.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
        await p.getByText(/This SVG has no draw\.io data/).first().waitFor();
      });

      await s.step('docs page: an SVG exported from draw.io (with its data) imports', async () => {
        const content = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${content}" width="10" height="10"></svg>`;
        await p.getByTestId('diagram-file-input').setInputFiles({ name: 'exported.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
        await openEditorWait();
        await frame().getByText(/^loaded exported\.drawio/).waitFor();
        must((await xmlBox().inputValue()) === source, 'the SVG\'s embedded XML should be loaded');
        await ed().getByRole('button', { name: 'Cancel' }).click();
        await ed().waitFor({ state: 'detached' });
      });

      await s.step('docs page: reload, the page still shows both diagrams and the viewer opens from one', async () => {
        // (the publishDoc helper waits for a lone "Edit" button, but the page's diagrams have Edit buttons too)
        await p.getByRole('button', { name: 'Publish', exact: true }).click();
        const pub = p.getByRole('dialog', { name: 'Publish page' });
        await pub.getByRole('textbox', { name: 'Version note' }).fill('With diagrams');
        await pub.getByRole('button', { name: /^Publish v\d+/ }).click();
        await pub.waitFor({ state: 'detached' });
        await p.getByTestId('edit-page').waitFor();
        await p.reload();
        await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
        await p.getByRole('button', { name: 'Docs', exact: true }).click();
        await p.getByRole('complementary', { name: /^Docs space/ }).waitFor();
        await p.getByRole('tree').getByRole('treeitem', { name: /Architecture/ }).first().click();
        await p.getByRole('heading', { name: 'Architecture', level: 1 }).waitFor();
        await p.getByTestId('diagram-embed').nth(1).waitFor({ timeout: 15000 });
        await p.getByTestId('diagram-embed').first().getByText('System context').waitFor();
        await p.getByTestId('diagram-embed').first().hover();
        await p.getByTestId('diagram-embed').first().getByRole('button', { name: 'View full size' }).click();
        const v = p.getByRole('dialog', { name: 'System context, full size' });
        await v.waitFor();
        await p.keyboard.press('Escape');
        await v.waitFor({ state: 'detached' });
      });

      await s.step('docs page: a drawing over 2 MB is refused with "Too large", Back to editor keeps the edits', async () => {
        await p.getByTestId('edit-page').click();
        const first = p.getByTestId('diagram-embed').first();
        await first.waitFor();
        await first.hover();
        await first.getByRole('button', { name: 'Edit' }).click();
        await openEditorWait();
        await typeXml(source.replace('value="Start"', `value="${'x'.repeat(2 * 1024 * 1024 + 10)}"`));
        await ed().getByText('Draft kept in this browser').waitFor();
        await ed().getByRole('button', { name: 'Save to page' }).click();
        await ed().getByTestId('diagram-too-large').waitFor();
        await ed().getByTestId('diagram-too-large').getByText('Too large').waitFor();
        await ed().getByRole('button', { name: 'Back to editor' }).click();
        await ed().getByTestId('diagram-too-large').waitFor({ state: 'detached' });
        await ed().getByRole('button', { name: 'Cancel' }).click();
        await p.getByRole('alertdialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click();
        await ed().waitFor({ state: 'detached' });
      }, { expectConsole: true });

      await s.step('no editor again: the stand-in stops; Edit on a saved diagram offers Download .drawio from the server', async () => {
        await editor.stop();
        const first = p.getByTestId('diagram-embed').first();
        await first.hover();
        await first.getByRole('button', { name: 'Edit' }).click();
        await ed().getByText('Editor could not be reached').waitFor();
        const f = await download(() => ed().getByRole('link', { name: 'Download .drawio' }).click());
        must(f.data.toString().includes('<mxfile'), 'server download for the saved diagram');
        await ed().getByRole('button', { name: 'Close' }).click();
        await ed().waitFor({ state: 'detached' });
      });

      await s.step('settings: switch to Public, the address field goes away, the setting is stored, then back to the stand-in', async () => {
        await p.locator('button[title="Settings"][class*="_sidebarIcon"]').click();
        await openDiagramSettings();
        const c = diagSettings();
        await c.getByRole('radio', { name: /Public diagrams.net/ }).check();
        await c.getByRole('button', { name: 'Save', exact: true }).click();
        await c.getByText('Saved', { exact: true }).waitFor();
        const pub = await api('/diagrams/settings');
        must(pub.json.mode === 'public', `mode should be public: ${JSON.stringify(pub.json)}`);
        must(pub.json.sendsDrawingsToThirdParty === true || pub.json.sends_drawings_to_third_party === true, 'public editor sends drawings to a third party');
        await c.getByRole('radio', { name: /Self-hosted/ }).check();
        await c.getByRole('textbox', { name: 'Editor address' }).fill(editorUrl);
        await c.getByRole('button', { name: 'Save', exact: true }).click();
        await c.getByText('Saved', { exact: true }).waitFor();
        const back = await api('/diagrams/settings');
        must(back.json.mode === 'self-hosted' && back.json.url === editorUrl, 'settings back to self-hosted');
      });

      await s.step('settings: an address that is not http(s) is refused by the server', async () => {
        const c = diagSettings();
        await c.getByRole('textbox', { name: 'Editor address' }).fill('ftp://nowhere');
        await c.getByRole('button', { name: 'Save', exact: true }).click();
        await c.getByText('The editor address must start with http:// or https://').waitFor();
        await c.getByRole('textbox', { name: 'Editor address' }).fill(editorUrl);
      }, { expectConsole: true });
    } finally {
      await editor.stop().catch(() => {});
      cleanFixtures(fx);
    }
  },
};
