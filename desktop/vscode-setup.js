const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Returns the path to VS Code's user-level mcp.json, or null if VS Code is not installed.
 */
function getVSCodeMcpConfigPath() {
  let configDir;
  if (process.platform === 'win32') {
    configDir = path.join(process.env.APPDATA || '', 'Code', 'User');
  } else if (process.platform === 'darwin') {
    configDir = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  } else {
    // Linux
    configDir = path.join(os.homedir(), '.config', 'Code', 'User');
  }

  // Check if VS Code user config directory exists
  if (!fs.existsSync(configDir)) {
    return null;
  }

  return path.join(configDir, 'mcp.json');
}

/**
 * Safely reads and parses a JSON file. Returns {} on missing or invalid JSON.
 */
function readJsonSafe(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Register the kanban-board MCP server in VS Code's mcp.json.
 * - Safe merge: never overwrites existing server entries.
 * - Only writes if the entry doesn't already exist or the path has changed.
 * - Returns 'registered', 'already-registered', or 'vscode-not-found'.
 */
function registerMcpServer(mcpStdioBinaryPath) {
  const mcpConfigPath = getVSCodeMcpConfigPath();

  if (!mcpConfigPath) {
    console.log('[vscode-setup] VS Code not found — skipping MCP registration');
    return 'vscode-not-found';
  }

  const config = readJsonSafe(mcpConfigPath);

  // Initialize servers object if missing
  if (!config.servers) {
    config.servers = {};
  }

  // Check if already registered with the same path
  const existing = config.servers['kanban-board'];
  if (existing && existing.command === mcpStdioBinaryPath) {
    console.log('[vscode-setup] kanban-board MCP server already registered');
    return 'already-registered';
  }

  // Register or update the entry
  config.servers['kanban-board'] = {
    type: 'stdio',
    command: mcpStdioBinaryPath,
  };

  try {
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[vscode-setup] Registered kanban-board MCP server at ${mcpConfigPath}`);
    return 'registered';
  } catch (err) {
    console.error('[vscode-setup] Failed to write mcp.json:', err.message);
    return 'write-error';
  }
}

module.exports = { registerMcpServer, getVSCodeMcpConfigPath };
