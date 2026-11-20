//! The plain Markdown flavour: a reader that reproduces the Docs editor (marked + `@tiptap/markdown` + the
//! editor's extensions) and the writer the editor stores pages with.

pub mod block;
pub mod build;
pub mod html;
pub mod inline;
pub mod token;
pub mod write;
