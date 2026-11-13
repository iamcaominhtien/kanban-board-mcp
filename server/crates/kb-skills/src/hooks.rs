//! Calls into areas that are above this crate (the Python code imports them late, inside a function). The upper
//! crate registers itself at startup; while a hook is not set the call is skipped.

use std::sync::OnceLock;

use async_trait::async_trait;

/// The board's MCP server, as far as Settings calls it (`api/settings.py` `_tool_count`, which imports `main` late
/// and counts `main.mcp.list_tools()`).
#[async_trait]
pub trait McpToolsHook: Send + Sync {
    /// The number of tools the server exposes (`len(await main.mcp.list_tools())`).
    async fn tool_count(&self) -> usize;
}

static MCP_TOOLS: OnceLock<Box<dyn McpToolsHook>> = OnceLock::new();

/// Register the MCP server (once, at startup; a second call is ignored).
pub fn set_mcp_tools_hook(hook: Box<dyn McpToolsHook>) {
    let _ = MCP_TOOLS.set(hook);
}

/// The MCP server, when its crate has registered itself.
pub fn mcp_tools() -> Option<&'static dyn McpToolsHook> {
    MCP_TOOLS.get().map(|hook| hook.as_ref())
}

/// `_tool_count()`: the number of tools; 0 while the MCP server has not registered itself.
pub async fn tool_count() -> usize {
    match mcp_tools() {
        Some(hook) => hook.tool_count().await,
        None => 0,
    }
}
