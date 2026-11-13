//! Test harness of the Python-to-Rust migration: starts the Python reference server or the Rust server as a child
//! process on temporary folders and gives the test an HTTP client, an MCP client and an SSE reader.
//!
//! Every test is black-box; `PARITY_TARGET=python|rust` (default `rust`) picks the server. Each server gets its own
//! config folder, database path, log, workspace and uploads folders inside one temporary folder, and every inherited
//! `KANBAN_*` variable is removed from its environment, so a developer's own settings never reach it.

mod client;
mod dump;
mod mcp;
mod normalize;
mod server;

pub use client::{Client, Events, Resp};
pub use mcp::{Mcp, ToolResult};
pub use normalize::normalize;
pub use server::{
    Options, Server, Target, morning_zone, rust_binary_available, server_hours_east, skip_unless_available, target,
};
