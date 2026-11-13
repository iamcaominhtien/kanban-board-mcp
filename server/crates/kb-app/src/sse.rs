//! `GET /events`: board events as Server-Sent Events.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::stream;

use kb_base::events::{self, Subscriber};

/// Removes the subscriber when the stream is dropped (the client went away).
struct Guard(Arc<Subscriber>);

impl Drop for Guard {
    fn drop(&mut self) {
        events::unsubscribe(&self.0);
    }
}

/// Stream board events to the client: `: connected`, then one `data:` block per event, with a `: ping` comment
/// every 30 seconds of silence.
pub async fn sse_events() -> Response {
    let guard = Guard(events::subscribe());
    let first = stream::once(async { Ok::<_, std::convert::Infallible>(Bytes::from_static(b": connected\n\n")) });
    let rest = stream::unfold(guard, |guard| async move {
        let chunk = match tokio::time::timeout(Duration::from_secs(30), guard.0.recv()).await {
            Ok(event) => Bytes::from(format!("data: {event}\n\n")),
            Err(_) => Bytes::from_static(b": ping\n\n"),
        };
        Some((Ok::<_, std::convert::Infallible>(chunk), guard))
    });
    let body = Body::from_stream(futures::StreamExt::chain(first, rest));
    (
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        body,
    )
        .into_response()
}
