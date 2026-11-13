//! Files the server keeps and serves: the uploads folder (`uploads.py`), the draw.io editor shipped with the app
//! (`services/drawio_bundle.py`), and `FileResponse`, the way Starlette answers a request with a file (content type,
//! length, validators, `Content-Disposition`, byte ranges), which every route that serves a file goes through.

pub mod drawio_bundle;
pub mod file_response;
pub mod mimetypes;
pub mod pathlib;
pub mod uploads;

pub use file_response::{FileResponse, file_response};
