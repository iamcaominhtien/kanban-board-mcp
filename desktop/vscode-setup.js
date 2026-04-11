const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Returns the path to VS Code's user-level mcp.json, or null if VS Code is not installed.
 */
function getVSCodeUserConfigDir({
  platform = process.platform,
  homeDir = os.homedir(),
  appData = process.env.APPDATA,
  existsSync = fs.existsSync,
} = {}) {
  const platforms = {
    win32: () => appData ? path.join(appData, 'Code', 'User') : null,
    darwin: () => path.join(homeDir, 'Library', 'Application Support', 'Code', 'User'),
    linux: () => path.join(homeDir, '.config', 'Code', 'User')
  };

  const getDir = platforms[platform] || platforms.linux;
  const configDir = getDir();
  if (!configDir) return null;

  return existsSync(configDir) ? configDir : null;
}

function getVSCodeMcpConfigPath(options = {}) {
  const configDir = getVSCodeUserConfigDir(options);
  return configDir ? path.join(configDir, 'mcp.json') : null;
}

/**
 * Safely reads and parses a JSON file.
 * Returns {} if the file does not exist.
 * Returns null if the file exists but is corrupt — caller must not overwrite.
 */
function readJsonSafe(
  filePath,
  { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}
) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null; // file exists but is corrupt — caller must not overwrite
  }
}

function mergeMcpConfig(config, mcpStdioBinaryPath, dbPath) {
  const nextConfig = { ...config, servers: { ...(config.servers || {}) } };
  const existing = nextConfig.servers['kanban-board'];

  if (existing?.command === mcpStdioBinaryPath && existing?.env?.KANBAN_DB_PATH === dbPath) {
    return { result: 'already-registered', config: nextConfig };
  }

  nextConfig.servers['kanban-board'] = {
    type: 'stdio',
    command: mcpStdioBinaryPath,
    ...(dbPath ? { env: { KANBAN_DB_PATH: dbPath } } : {})
  };

  return { result: 'registered', config: nextConfig };
}

function writeJsonAtomic(
  filePath,
  payload,
  {
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    unlinkSync = fs.unlinkSync,
  } = {}
) {
  const tmpPath = filePath + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Register the kanban-board MCP server in VS Code's mcp.json.
 * - Safe merge: never overwrites existing server entries.
 * - Only writes if the entry doesn't already exist or the path has changed.
 * - Returns one of:
 *   'registered'         — entry was created or updated successfully
 *   'already-registered' — entry already exists with the same path
 *   'vscode-not-found'   — VS Code user config directory not found
 *   'parse-error'        — mcp.json exists but could not be parsed
 *   'write-error'        — atomic write to disk failed
 */
function registerMcpServer(
  mcpStdioBinaryPath,
  dbPath,
  {
    getConfigPath = getVSCodeMcpConfigPath,
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    unlinkSync = fs.unlinkSync,
  } = {}
) {
  const mcpConfigPath = getConfigPath();

  if (!mcpConfigPath) {
    console.log('[vscode-setup] VS Code not found — skipping MCP registration');
    return 'vscode-not-found';
  }

  const config = readJsonSafe(mcpConfigPath, { existsSync, readFileSync });
  if (config === null) {
    console.error('[vscode-setup] mcp.json is corrupt — skipping to avoid data loss');
    return 'parse-error';
  }

  const mergeResult = mergeMcpConfig(config, mcpStdioBinaryPath, dbPath);
  if (mergeResult.result === 'already-registered') {
    console.log('[vscode-setup] kanban-board MCP server already registered');
    return 'already-registered';
  }

  if (
    writeJsonAtomic(mcpConfigPath, mergeResult.config, {
      writeFileSync,
      renameSync,
      unlinkSync,
    })
  ) {
    console.log(`[vscode-setup] Registered kanban-board MCP server at ${mcpConfigPath}`);
    return 'registered';
  }

  console.error('[vscode-setup] Failed to write mcp.json');
  return 'write-error';
}

module.exports = {
  getVSCodeMcpConfigPath,
  getVSCodeUserConfigDir,
  mergeMcpConfig,
  readJsonSafe,
  registerMcpServer,
  writeJsonAtomic,
};
