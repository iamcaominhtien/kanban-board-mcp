// The application menu, built as plain data so it can be tested per platform without Electron.
// main.js turns the template into a native menu and decides what each command does (see menu-actions in main.js).

const REPO_URL = 'https://github.com/iamcaominhtien/kanban-board-mcp';
const LINKS = {
  docs: `${REPO_URL}#readme`,
  releases: `${REPO_URL}/releases`,
  issues: `${REPO_URL}/issues`,
  featureRequest: `${REPO_URL}/issues/new?template=feature_request.md`,
};

// Views in the order of the View menu. `accelerator` digits are Cmd/Ctrl+1..6.
const VIEWS = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'docs', label: 'Docs' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'ideas', label: 'Idea Space' },
];

/**
 * Builds the menu template (the array `Menu.buildFromTemplate` takes, with an `id` on every item).
 *
 * @param {object} ctx
 * @param {'darwin'|'win32'|'linux'} ctx.platform
 * @param {string} ctx.appName - "Kanban Board"
 * @param {string} ctx.version - the running version, for "What's New in x"
 * @param {boolean} ctx.backendRunning - items that need data are greyed while it is not
 * @param {boolean} ctx.windowOpen - false on macOS after the last window is closed
 * @param {string|null} ctx.currentView - one of VIEWS ids, shown with a check mark
 * @param {{checking: boolean, availableVersion: string|null}} ctx.update
 * @param {(command: string, payload?: object) => void} ctx.dispatch - called by every command item
 */
function buildMenuTemplate(ctx) {
  const { platform, appName, version, backendRunning, windowOpen, currentView, update, dispatch } = ctx;
  const mac = platform === 'darwin';
  const win = platform === 'win32';

  // `needs` lists what an item cannot work without: the window (it talks to the page) and/or the backend (it needs data).
  const enabledFor = (needs = []) =>
    (!needs.includes('window') || windowOpen) && (!needs.includes('backend') || backendRunning);

  const command = (id, label, opts = {}) => {
    const { accelerator, needs = ['window'], payload, ...rest } = opts;
    const item = { id, label, enabled: enabledFor(needs), click: () => dispatch(id, payload), ...rest };
    if (accelerator) item.accelerator = accelerator;
    return item;
  };
  const role = (id, r, extra = {}) => ({ id, role: r, ...extra });
  const sep = (id) => ({ id, type: 'separator' });
  const BACKEND = ['window', 'backend'];

  const checkForUpdates = update.availableVersion
    ? command('check-updates', `Install Update ${update.availableVersion}…`, {
        needs: ['window'],
        // opens Settings › Updates, which has the download button
        payload: { page: 'updates' },
      })
    : {
        id: 'check-updates',
        label: update.checking ? 'Checking for Updates…' : 'Check for Updates…',
        enabled: !update.checking,
        click: () => dispatch('check-updates'),
      };
  const settings = command('settings', 'Settings…', { accelerator: 'CmdOrCtrl+,', needs: BACKEND });
  const about = mac
    ? role('about', 'about', { label: `About ${appName}` })
    : { id: 'about', label: `About ${appName}`, enabled: windowOpen, click: () => dispatch('about') };

  const create = [
    command('new-ticket', 'New Ticket', { accelerator: 'CmdOrCtrl+N', needs: BACKEND }),
    command('new-idea', 'New Idea', { accelerator: 'CmdOrCtrl+Shift+N', needs: BACKEND }),
    command('new-doc', 'New Doc Page', { accelerator: 'CmdOrCtrl+Alt+N', needs: BACKEND }),
    command('new-project', 'New Project…', { needs: BACKEND }),
  ];
  const importExport = [
    command('import-data', 'Import Data…', { needs: BACKEND }),
    command('export-data', 'Export Data…', { needs: BACKEND }),
  ];

  const file = {
    id: 'file',
    label: 'File',
    submenu: mac
      ? [
          ...create,
          sep('file-sep-1'),
          ...importExport,
          sep('file-sep-2'),
          // The only way back to a window once the last one is closed (the app keeps running on macOS)
          { id: 'new-window', label: 'New Window', enabled: !windowOpen, click: () => dispatch('new-window') },
          role('close', 'close', { label: 'Close Window' }),
        ]
      : [
          ...create,
          sep('file-sep-1'),
          ...importExport,
          sep('file-sep-2'),
          settings,
          sep('file-sep-3'),
          role('quit', 'quit', { label: 'Exit', accelerator: win ? 'Alt+F4' : 'Ctrl+Q' }),
        ],
  };

  const edit = {
    id: 'edit',
    label: 'Edit',
    submenu: [
      role('undo', 'undo'),
      role('redo', 'redo'),
      sep('edit-sep-1'),
      role('cut', 'cut'),
      role('copy', 'copy'),
      role('paste', 'paste'),
      role('paste-and-match-style', 'pasteAndMatchStyle'),
      role('select-all', 'selectAll'),
      sep('edit-sep-2'),
      // Not Cmd/Ctrl+F: the Docs page already uses that for Find in page
      command('find-board', 'Find in Board', { accelerator: 'CmdOrCtrl+Shift+F', needs: BACKEND }),
    ],
  };

  const view = {
    id: 'view',
    label: 'View',
    submenu: [
      ...VIEWS.map((v, i) =>
        command(`view-${v.id}`, v.label, {
          accelerator: `CmdOrCtrl+${i + 1}`,
          needs: BACKEND,
          type: 'radio',
          checked: currentView === v.id,
          payload: { view: v.id },
        }),
      ),
      sep('view-sep-1'),
      command('ask-ai', 'Ask AI', { accelerator: 'CmdOrCtrl+J', needs: BACKEND }),
      sep('view-sep-2'),
      role('reset-zoom', 'resetZoom', { label: 'Actual Size' }),
      role('zoom-in', 'zoomIn'),
      role('zoom-out', 'zoomOut'),
      sep('view-sep-3'),
      role('toggle-full-screen', 'togglefullscreen', { label: mac ? 'Enter Full Screen' : 'Toggle Full Screen' }),
      sep('view-sep-4'),
      // A menu accelerator only works while this app is in front (it used to be a system-wide shortcut)
      role('toggle-dev-tools', 'toggleDevTools', { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I' }),
    ],
  };

  const windowMenu = {
    id: 'window',
    label: 'Window',
    submenu: mac
      ? [role('minimize', 'minimize'), role('zoom', 'zoom'), sep('window-sep-1'), role('front', 'front')]
      : [
          role('minimize', 'minimize'),
          { id: 'maximize', label: 'Maximize', enabled: windowOpen, click: () => dispatch('maximize') },
          role('close-window', 'close'),
        ],
  };

  const help = [
    command('shortcuts', 'Keyboard Shortcuts', { accelerator: 'CmdOrCtrl+/', needs: ['window'] }),
    { id: 'docs', label: 'Documentation', click: () => dispatch('open-link', { url: LINKS.docs }) },
    command('whats-new', `What's New in ${version}`, { needs: ['window'] }),
    sep('help-sep-1'),
    command('setup-ai', 'Set Up AI…', { needs: BACKEND, payload: { page: 'ai' } }),
    command('setup-mcp', 'Set Up MCP…', { needs: BACKEND, payload: { page: 'integrations' } }),
    sep('help-sep-2'),
    command('report-issue', 'Report an Issue…', { needs: ['window'] }),
    { id: 'request-feature', label: 'Request a Feature…', click: () => dispatch('open-link', { url: LINKS.featureRequest }) },
    sep('help-sep-3'),
    { id: 'open-logs', label: mac ? 'Show Logs in Finder' : 'Open Logs Folder', click: () => dispatch('open-logs') },
    command('export-logs', 'Export Logs…', { needs: BACKEND, payload: { page: 'diagnostics' } }),
    { id: 'open-data', label: 'Open Data Folder', click: () => dispatch('open-data') },
    { id: 'copy-diagnostics', label: 'Copy Diagnostics Info', click: () => dispatch('copy-diagnostics') },
  ];
  if (!mac) help.push(sep('help-sep-4'), checkForUpdates, about);

  // The standard Help role gives macOS its menu search box
  const helpMenu = mac
    ? { id: 'help', label: 'Help', role: 'help', submenu: help }
    : { id: 'help', label: 'Help', submenu: help };

  const template = [];
  if (mac) {
    template.push({
      id: 'app',
      label: appName,
      submenu: [
        about,
        checkForUpdates,
        sep('app-sep-1'),
        settings,
        sep('app-sep-2'),
        role('services', 'services'),
        sep('app-sep-3'),
        role('hide', 'hide'),
        role('hide-others', 'hideOthers'),
        role('unhide', 'unhide'),
        sep('app-sep-4'),
        role('quit', 'quit'),
      ],
    });
  }
  template.push(file, edit, view, windowMenu, helpMenu);
  return template;
}

// Commands the main process handles itself; every other id is sent to the page as `app-command`.
const MAIN_COMMANDS = new Set(['open-logs', 'open-data', 'copy-diagnostics', 'new-window', 'maximize', 'check-updates']);
// Items that open a Settings page: id -> the page and the `data-setting` anchor to scroll to
const SETTINGS_TARGETS = {
  settings: {},
  'setup-ai': { page: 'ai' },
  'setup-mcp': { page: 'integrations' },
  'export-logs': { page: 'diagnostics', setting: 'logs' },
  'import-data': { page: 'storage', setting: 'import' },
  'export-data': { page: 'storage', setting: 'export' },
};

/**
 * Says what a clicked item does: `{type: 'link', url}`, `{type: 'main', name}` or `{type: 'renderer', message}`
 * (the message the page's `app-command` handler gets).
 */
function resolveCommand(id, payload = {}) {
  if (id === 'open-link') return { type: 'link', url: payload.url };
  // "Install Update x…" is the same item as "Check for Updates…" and opens Settings › Updates
  if (id === 'check-updates' && payload.page) return { type: 'renderer', message: { command: 'settings', page: payload.page } };
  if (MAIN_COMMANDS.has(id)) return { type: 'main', name: id };
  if (SETTINGS_TARGETS[id]) return { type: 'renderer', message: { command: 'settings', ...SETTINGS_TARGETS[id] } };
  if (id.startsWith('view-')) return { type: 'renderer', message: { command: 'view', view: id.slice(5) } };
  return { type: 'renderer', message: { command: id } };
}

/**
 * The text "Copy Diagnostics Info" puts on the clipboard: versions and system facts only.
 * Never tickets, Docs, paths, keys or logs.
 */
function buildDiagnosticsText(info) {
  return [
    `${info.appName} ${info.version}`,
    `Backend: ${info.backendRunning ? 'running' : 'not running'}`,
    `System: ${info.osName} ${info.osVersion} (${info.arch})`,
    `Electron ${info.electron} · Chromium ${info.chrome}`,
    `Language: ${info.language}`,
  ].join('\n');
}

/** Every item (not separators) of a template, flattened, for tests and for lookups by id. */
function flattenItems(template) {
  const out = [];
  for (const entry of template) {
    if (entry.type !== 'separator' && !entry.submenu) out.push(entry);
    if (entry.submenu) out.push(...flattenItems(entry.submenu));
  }
  return out;
}

module.exports = { buildMenuTemplate, flattenItems, resolveCommand, buildDiagnosticsText, SETTINGS_TARGETS, LINKS, REPO_URL, VIEWS };
