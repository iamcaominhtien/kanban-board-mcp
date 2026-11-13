//! Docs text and access rules shared by the areas that read or write Docs (`services/docs_text.py`,
//! `services/docs_anchors.py`, `docs_checklist.py`, `docs_edit.py`, `docs_templates.py`, `docs_guide.py`,
//! `services/docs_access.py`).

pub mod docs_access;
pub mod docs_anchors;
pub mod docs_checklist;
pub mod docs_edit;
pub mod docs_guide;
pub mod docs_templates;
pub mod docs_text;
pub mod pystr;
mod pyuni_tables;
