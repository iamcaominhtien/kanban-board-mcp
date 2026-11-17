//! Rich Docs embeds and uploads (phase 5): cleaning the HTML of HTML embeds when a page is saved, uploads of
//! pictures, videos and files with their limits and checks, link previews for "Embed from link", and the inline
//! preview of Word, Excel and CSV files.

pub mod html;
pub mod link;
pub mod preview;
pub mod upload;

pub use html::{SanitizedHtml, sanitize_doc, sanitize_embed_html};
pub use link::link_preview;
pub use preview::file_preview;
pub use upload::receive as receive_upload;
