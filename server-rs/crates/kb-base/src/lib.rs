//! What every area of the server shares: configuration, time and JSON in the formats the Python server stored,
//! errors as the REST API answers them, the per-task context (who is acting), and the event bus.

pub mod activity;
pub mod api_secret;
pub mod config;
pub mod ctx;
pub mod error;
pub mod events;
pub mod pyjson;
pub mod routes;
pub mod secrets;
pub mod time;
pub mod version;

pub use error::{ApiError, ApiResult};
pub use routes::Routes;
