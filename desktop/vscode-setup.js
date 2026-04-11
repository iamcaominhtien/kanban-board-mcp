const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Returns the path to VS Code's user-level mcp.json, or null if VS Code is not installed.
 */
function getVSCodeMcpConfigPath() {
  const platforms = {
    win32: () => process.env.APPDATA ? path.join(process.env.APPDATA, 'Code', 'User') : null,
    darwin: () => path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User'),
    linux: () => path.join(os.homedir(), '.config', 'Code', 'User')
  };

  const getDir = platforms[process.platform] || platforms.linux;
  const configDir = getDir();
  if (!configDir) return null;

  return fs.existsSync(configDir) ? path.join(configDir, 'mcp.json') : null;
}

/**
 * Safely reads and parses a JSON file.
 * Returns {} if the file does not exist.
 * Returns null if the file exists but is corrupt — caller must not overwrite.
 */
function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null; // file exists but is corrupt — caller must not overwrite
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
function registerMcpServer(mcpStdioBinaryPath) {
  const mcpConfigPath = getVSCodeMcpConfigPath();

  if (!mcpConfigPath) {
    console.log('[vscode-setup] VS Code not found — skipping MCP registration');
    return 'vscode-not-found';
  }

  const config = readJsonSafe(mcpConfigPath);
  if (config === null) {
    console.error('[vscode-setup] mcp.json is corrupt — skipping to avoid data loss');
    return 'parse-error';
  }
  config.servers = config.servers || {};

  // Check if already registered with the same path
  const existing = config.servers['kanban-board'];
  if (existing?.command === mcpStdioBinaryPath) {
    console.log('[vscode-setup] kanban-board MCP server already registered');
    return 'already-registered';
  }

  // Register or update the entry
  config.servers['kanban-board'] = {
    type: 'stdio',
    command: mcpStdioBinaryPath,
  };

  try {
    const tmpPath = mcpConfigPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpPath, mcpConfigPath);
    console.log(`[vscode-setup] Registered kanban-board MCP server at ${mcpConfigPath}`);
    return 'registered';
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    console.error('[vscode-setup] Failed to write mcp.json:', err.message);
    return 'write-error';
  }
}

module.exports = { registerMcpServer, getVSCodeMcpConfigPath };
