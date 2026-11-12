//! Request models of the diagram and sketch routes (`api/diagrams.py`; the sketch routes take forms, read in
//! `api/sketches.rs`). The responses are the dicts the services build.

use serde::Deserialize;

/// Request body to save a new diagram.
#[derive(Debug, Clone, Deserialize)]
pub struct DiagramCreate {
    /// Name; becomes the alt text.
    #[serde(default)]
    pub label: Option<String>,
    /// The `.drawio` XML.
    pub source: String,
    /// The SVG preview.
    pub svg: String,
    /// Optional short text summary.
    #[serde(default)]
    pub summary: Option<String>,
    /// `ticket`, `comment` or `doc`.
    #[serde(default)]
    pub item_kind: Option<String>,
    /// Id of that item.
    #[serde(default)]
    pub item_id: Option<String>,
}

/// Request body to save a new version of a diagram.
#[derive(Debug, Clone, Deserialize)]
pub struct DiagramUpdate {
    /// The version the edit started from.
    pub base_version: i32,
    /// The `.drawio` XML.
    pub source: String,
    /// The SVG preview.
    pub svg: String,
    /// New name.
    #[serde(default)]
    pub label: Option<String>,
    /// New summary.
    #[serde(default)]
    pub summary: Option<String>,
}

/// Request body to choose where the draw.io editor runs.
#[derive(Debug, Clone, Deserialize)]
pub struct DiagramSettingsBody {
    /// `built-in`, `self-hosted` or `public`.
    pub mode: String,
    /// The editor's address.
    #[serde(default)]
    pub url: Option<String>,
}
