'use strict';
/**
 * Headless diagram export: `Kanban Board --export-svg in.drawio out.svg --editor-url http://localhost:8080`.
 *
 * The server asks the desktop app for this when an AI agent saves a diagram (nobody has a window open to ask the
 * draw.io editor for the picture). The app starts without a backend or a visible window, loads the editor in a hidden
 * window that may only talk to the editor's own origin, asks it for an SVG (the same renderer a person gets when they
 * save) and writes the file. It reuses the Chromium that Electron already ships, so nothing extra is installed.
 */

const fs = require('fs');

const EXPORT_TIMEOUT_MS = 60000;

// Same page script as server/services/diagram_export.py: the editor's embed protocol, driven from a page on the
// editor's origin, with the editor in a frame because it only talks to a parent window.
const PAGE_SCRIPT = `
(xml, editorUrl, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the editor did not answer')), timeoutMs);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1400px;height:900px;border:0';
  const send = (m) => frame.contentWindow.postMessage(JSON.stringify(m), '*');
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || typeof e.data !== 'string') return;
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.event === 'init') send({ action: 'load', xml });
    else if (m.event === 'load') send({ action: 'export', format: 'svg' });
    else if (m.event === 'export') { clearTimeout(timer); resolve(m.data); }
  });
  frame.src = editorUrl + '/?embed=1&proto=json&spin=0&ui=min&noSaveBtn=1&noExitBtn=1&libraries=0&lang=en';
  document.body.appendChild(frame);
})
`;

/**
 * Reads `--export-svg <input> <output> [--editor-url <url>]` from the command line.
 * @returns {{input: string, output: string, editorUrl: string} | null} null when this is a normal start.
 */
function parseExportArgs(argv) {
  const at = argv.indexOf('--export-svg');
  if (at === -1) return null;
  const input = argv[at + 1];
  const output = argv[at + 2];
  if (!input || !output || input.startsWith('--') || output.startsWith('--')) return { error: 'usage: --export-svg <input.drawio> <output.svg> --editor-url <url>' };
  const u = argv.indexOf('--editor-url');
  const editorUrl = u === -1 ? '' : argv[u + 1] || '';
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(editorUrl)) return { error: '--editor-url must be an http(s) address' };
  return { input, output, editorUrl: editorUrl.replace(/\/+$/, '') };
}

/** Only the editor's own origin (and inline data) may load in the hidden window. */
function isAllowedUrl(url, editorUrl) {
  if (/^(data|blob|about):/.test(url)) return true;
  try {
    return new URL(url).origin === new URL(editorUrl).origin;
  } catch {
    return false;
  }
}

/** The text of the editor's `data:image/svg+xml` answer. */
function decodeSvgData(data) {
  const comma = data.indexOf(',');
  const head = data.slice(0, comma);
  const body = data.slice(comma + 1);
  return head.includes(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
}

/**
 * Runs the export in a hidden window and returns the SVG text.
 * @param {object} electron  The `electron` module (injected so the pure helpers stay testable).
 */
async function exportSvg(electron, { xml, editorUrl, timeoutMs = EXPORT_TIMEOUT_MS }) {
  const { BrowserWindow } = electron;
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, offscreen: false },
  });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedUrl(details.url, editorUrl) });
  });
  try {
    await win.loadURL(`${editorUrl}/clear.html`);
    const script = `(${PAGE_SCRIPT})(${JSON.stringify(xml)}, ${JSON.stringify(editorUrl)}, ${timeoutMs})`;
    const data = await win.webContents.executeJavaScript(script, true);
    return decodeSvgData(data);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** The whole command: read the file, export, write the file, quit with 0 or 1. */
async function runExportCli(electron, args) {
  const { app } = electron;
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  try {
    if (args.error) throw new Error(args.error);
    const xml = fs.readFileSync(args.input, 'utf8');
    const svg = await exportSvg(electron, { xml, editorUrl: args.editorUrl });
    fs.writeFileSync(args.output, svg, 'utf8');
    app.exit(0);
  } catch (err) {
    process.stderr.write(`export-svg failed: ${err && err.message ? err.message : err}\n`);
    app.exit(1);
  }
}

module.exports = { PAGE_SCRIPT, parseExportArgs, isAllowedUrl, decodeSvgData, exportSvg, runExportCli };
