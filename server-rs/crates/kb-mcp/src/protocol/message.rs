//! JSON-RPC messages as the MCP SDK reads them.
//!
//! The SDK validates what it receives twice, with Pydantic models: first as a `JSONRPCMessage` (a request, a
//! notification, a response or an error), then, for a request, as one of the requests a client may send
//! (`ClientRequest`: the method with its parameters). The first failure is answered by the transport with the text
//! of the `ValidationError`; the second with `Invalid request parameters`. Both are reproduced here.

use serde_json::{Map, Value};

use crate::pydantic::LineError;

/// A message that is valid JSON-RPC.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A request: it gets a reply with its `id`.
    Request {
        /// The request id: an integer or text, echoed in the reply.
        id: Value,
        /// The method (`tools/call`).
        method: String,
        /// The parameters; `None` when left out or `null`.
        params: Option<Map<String, Value>>,
    },
    /// A notification: accepted, never answered.
    Notification {
        /// The method (`notifications/initialized`).
        method: String,
        /// The parameters; `None` when left out or `null`.
        params: Option<Map<String, Value>>,
    },
    /// A response or an error to a request of the server (it sends none): accepted and dropped.
    Reply,
}

const MEMBERS: [&str; 4] = ["JSONRPCRequest", "JSONRPCNotification", "JSONRPCResponse", "JSONRPCError"];

fn loc(member: &str, path: &[&str]) -> Vec<String> {
    std::iter::once(member).chain(path.iter().copied()).map(str::to_string).collect()
}

fn missing(member: &str, field: &str, whole: &Value, errors: &mut Vec<LineError>) {
    errors.push(LineError::new(&loc(member, &[field]), "missing", "Field required", whole));
}

/// `method: str`.
fn check_method(member: &str, object: &Map<String, Value>, whole: &Value, errors: &mut Vec<LineError>) {
    match object.get("method") {
        None => missing(member, "method", whole, errors),
        Some(Value::String(_)) => {}
        Some(other) => {
            errors.push(LineError::new(
                &loc(member, &["method"]),
                "string_type",
                "Input should be a valid string",
                other,
            ));
        }
    }
}

/// `params: dict[str, Any] | None = None`.
fn check_params(member: &str, object: &Map<String, Value>, errors: &mut Vec<LineError>) {
    match object.get("params") {
        None | Some(Value::Null | Value::Object(_)) => {}
        Some(other) => {
            errors.push(LineError::new(
                &loc(member, &["params"]),
                "dict_type",
                "Input should be a valid dictionary",
                other,
            ));
        }
    }
}

/// `jsonrpc: Literal["2.0"]`.
fn check_jsonrpc(member: &str, object: &Map<String, Value>, whole: &Value, errors: &mut Vec<LineError>) {
    match object.get("jsonrpc") {
        None => missing(member, "jsonrpc", whole, errors),
        Some(Value::String(version)) if version == "2.0" => {}
        Some(other) => {
            errors.push(LineError::new(&loc(member, &["jsonrpc"]), "literal_error", "Input should be '2.0'", other));
        }
    }
}

/// Whether a value is a request id: a strict integer (not `true`, not `1.0`) or text.
pub fn is_request_id(value: &Value) -> bool {
    match value {
        Value::String(_) => true,
        Value::Number(n) => !n.is_f64(),
        _ => false,
    }
}

/// `id: RequestId` (`Annotated[int, Field(strict=True)] | str`).
fn check_id(member: &str, object: &Map<String, Value>, whole: &Value, errors: &mut Vec<LineError>) {
    match object.get("id") {
        None => missing(member, "id", whole, errors),
        Some(id) if is_request_id(id) => {}
        Some(other) => {
            errors.push(LineError::new(
                &loc(member, &["id", "int"]),
                "int_type",
                "Input should be a valid integer",
                other,
            ));
            errors.push(LineError::new(
                &loc(member, &["id", "str"]),
                "string_type",
                "Input should be a valid string",
                other,
            ));
        }
    }
}

/// `error: ErrorData` (`code: int`, `message: str`, `data: Any`).
fn check_error(member: &str, object: &Map<String, Value>, whole: &Value, errors: &mut Vec<LineError>) {
    let error = match object.get("error") {
        None => return missing(member, "error", whole, errors),
        Some(Value::Object(error)) => error,
        Some(other) => {
            let msg = "Input should be a valid dictionary or instance of ErrorData";
            errors.push(LineError::new(&loc(member, &["error"]), "model_type", msg, other));
            return;
        }
    };
    let inner = Value::Object(error.clone());
    match error.get("code") {
        None => errors.push(LineError::new(&loc(member, &["error", "code"]), "missing", "Field required", &inner)),
        Some(code) => {
            let schema = serde_json::json!({"type": "integer"});
            let mut found = Vec::new();
            let args: Map<String, Value> = [("code".to_string(), code.clone())].into_iter().collect();
            let model = serde_json::json!({"properties": {"code": schema}});
            if let Err(list) = crate::validation::check_arguments(&model, &args) {
                found = list;
            }
            for mut e in found {
                e.loc = loc(member, &["error", "code"]);
                errors.push(e);
            }
        }
    }
    match error.get("message") {
        None => errors.push(LineError::new(&loc(member, &["error", "message"]), "missing", "Field required", &inner)),
        Some(Value::String(_)) => {}
        Some(other) => errors.push(LineError::new(
            &loc(member, &["error", "message"]),
            "string_type",
            "Input should be a valid string",
            other,
        )),
    }
}

/// Read a parsed JSON value as a `JSONRPCMessage`. The errors are those of every member of the union, in order,
/// as Pydantic lists them when none fits.
pub fn classify(raw: &Value) -> Result<Incoming, Vec<LineError>> {
    let Value::Object(object) = raw else {
        return Err(MEMBERS
            .iter()
            .map(|member| {
                let msg = format!("Input should be a valid dictionary or instance of {member}");
                LineError::new(&[member.to_string()], "model_type", msg, raw)
            })
            .collect());
    };
    let params = || object.get("params").and_then(Value::as_object).cloned();
    let method = || object.get("method").and_then(Value::as_str).unwrap_or_default().to_string();

    let mut request = Vec::new();
    check_method(MEMBERS[0], object, raw, &mut request);
    check_params(MEMBERS[0], object, &mut request);
    check_jsonrpc(MEMBERS[0], object, raw, &mut request);
    check_id(MEMBERS[0], object, raw, &mut request);
    if request.is_empty() {
        let id = object.get("id").cloned().unwrap_or(Value::Null);
        return Ok(Incoming::Request { id, method: method(), params: params() });
    }

    let mut notification = Vec::new();
    check_method(MEMBERS[1], object, raw, &mut notification);
    check_params(MEMBERS[1], object, &mut notification);
    check_jsonrpc(MEMBERS[1], object, raw, &mut notification);
    if notification.is_empty() {
        return Ok(Incoming::Notification { method: method(), params: params() });
    }

    let mut response = Vec::new();
    check_jsonrpc(MEMBERS[2], object, raw, &mut response);
    check_id(MEMBERS[2], object, raw, &mut response);
    match object.get("result") {
        None => missing(MEMBERS[2], "result", raw, &mut response),
        Some(Value::Object(_)) => {}
        Some(other) => response.push(LineError::new(
            &loc(MEMBERS[2], &["result"]),
            "dict_type",
            "Input should be a valid dictionary",
            other,
        )),
    }
    if response.is_empty() {
        return Ok(Incoming::Reply);
    }

    let mut error = Vec::new();
    check_jsonrpc(MEMBERS[3], object, raw, &mut error);
    check_id(MEMBERS[3], object, raw, &mut error);
    check_error(MEMBERS[3], object, raw, &mut error);
    if error.is_empty() {
        return Ok(Incoming::Reply);
    }

    Err([request, notification, response, error].concat())
}

/// A request a client may send, with what the server needs of its parameters.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientRequest {
    /// `ping`.
    Ping,
    /// `initialize`.
    /// `protocolVersion` as text (`None` when the client sent a number).
    Initialize {
        protocol_version: Option<String>,
    },
    ListTools,
    CallTool {
        name: String,
        arguments: Map<String, Value>,
    },
    ListResources,
    ListResourceTemplates,
    ListPrompts,
    ReadResource {
        uri: String,
    },
    GetPrompt {
        name: String,
    },
    /// A request the SDK knows and FastMCP has no handler for (`Method not found`).
    Unhandled,
}

fn is_text(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(_)))
}

fn text_or_none(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null | Value::String(_)))
}

fn object_or_none(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null | Value::Object(_)))
}

/// `RequestParams`: `_meta` is an object whose `progressToken` is text or an integer, `task` an object whose `ttl`
/// is a strict integer.
fn base_params_ok(params: &Map<String, Value>) -> bool {
    let meta_ok = match params.get("_meta") {
        None | Some(Value::Null) => true,
        Some(Value::Object(meta)) => match meta.get("progressToken") {
            None | Some(Value::Null | Value::String(_)) => true,
            // `str | int` in lax mode: an integer, a boolean, or a float without a fraction
            Some(Value::Bool(_)) => true,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f.fract() == 0.0),
            Some(_) => false,
        },
        Some(_) => false,
    };
    let task_ok = match params.get("task") {
        None | Some(Value::Null) => true,
        Some(Value::Object(task)) => match task.get("ttl") {
            None | Some(Value::Null) => true,
            Some(Value::Number(n)) => !n.is_f64(),
            Some(_) => false,
        },
        Some(_) => false,
    };
    meta_ok && task_ok
}

/// `AnyUrl` with `host_required=False`, as far as it matters here: a scheme, then anything.
fn is_url(value: Option<&Value>) -> bool {
    let Some(Value::String(text)) = value else { return false };
    let Some((scheme, rest)) = text.split_once(':') else { return false };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && !rest.is_empty()
}

/// `ClientCapabilities`: each known capability is an object (or left out); `experimental` holds objects.
fn capabilities_ok(value: Option<&Value>) -> bool {
    let Some(Value::Object(capabilities)) = value else { return false };
    let experimental_ok = match capabilities.get("experimental") {
        None | Some(Value::Null) => true,
        Some(Value::Object(entries)) => entries.values().all(Value::is_object),
        Some(_) => false,
    };
    let roots_ok = match capabilities.get("roots") {
        None | Some(Value::Null) => true,
        Some(Value::Object(roots)) => {
            let mut errors = Vec::new();
            let model =
                serde_json::json!({"properties": {"listChanged": {"anyOf": [{"type": "boolean"}, {"type": "null"}]}}});
            let given: Map<String, Value> =
                roots.iter().filter(|(k, _)| *k == "listChanged").map(|(k, v)| (k.clone(), v.clone())).collect();
            if let Err(list) = crate::validation::check_arguments(&model, &given) {
                errors = list;
            }
            errors.is_empty()
        }
        Some(_) => false,
    };
    experimental_ok
        && roots_ok
        && ["sampling", "elicitation", "tasks"].iter().all(|key| object_or_none(capabilities.get(*key)))
}

/// `Implementation`: `name` and `version` are text.
fn implementation_ok(value: Option<&Value>) -> bool {
    let Some(Value::Object(info)) = value else { return false };
    is_text(info.get("name"))
        && is_text(info.get("version"))
        && text_or_none(info.get("title"))
        && text_or_none(info.get("websiteUrl"))
        && matches!(info.get("icons"), None | Some(Value::Null | Value::Array(_)))
}

const LOGGING_LEVELS: [&str; 8] = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

/// Read a request as one of `ClientRequest`'s; `None` is what the SDK answers with `Invalid request parameters`
/// (an unknown method, or parameters the method's model refuses).
pub fn client_request(method: &str, params: Option<&Map<String, Value>>) -> Option<ClientRequest> {
    let empty = Map::new();
    if params.is_some_and(|p| !base_params_ok(p)) {
        return None;
    }
    // requests whose `params` may be left out
    let optional = params.unwrap_or(&empty);
    let paginated = text_or_none(optional.get("cursor"));
    match method {
        "ping" => return Some(ClientRequest::Ping),
        "tools/list" => return paginated.then_some(ClientRequest::ListTools),
        "resources/list" => return paginated.then_some(ClientRequest::ListResources),
        "resources/templates/list" => return paginated.then_some(ClientRequest::ListResourceTemplates),
        "prompts/list" => return paginated.then_some(ClientRequest::ListPrompts),
        "tasks/list" => return paginated.then_some(ClientRequest::Unhandled),
        _ => {}
    }
    // the others need them
    let params = params?;
    match method {
        "initialize" => {
            let version = match params.get("protocolVersion") {
                Some(Value::String(version)) => Some(version.clone()),
                // `str | int`: a number is accepted and is never a version the SDK knows
                Some(Value::Bool(_)) => None,
                Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => None,
                _ => return None,
            };
            (capabilities_ok(params.get("capabilities")) && implementation_ok(params.get("clientInfo")))
                .then_some(ClientRequest::Initialize { protocol_version: version })
        }
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str)?;
            let arguments = match params.get("arguments") {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(arguments)) => arguments.clone(),
                Some(_) => return None,
            };
            Some(ClientRequest::CallTool { name: name.to_string(), arguments })
        }
        "resources/read" => is_url(params.get("uri"))
            .then(|| ClientRequest::ReadResource { uri: params["uri"].as_str().unwrap_or_default().to_string() }),
        "prompts/get" => {
            let name = params.get("name").and_then(Value::as_str)?;
            let arguments_ok = match params.get("arguments") {
                None | Some(Value::Null) => true,
                Some(Value::Object(arguments)) => arguments.values().all(Value::is_string),
                Some(_) => false,
            };
            arguments_ok.then(|| ClientRequest::GetPrompt { name: name.to_string() })
        }
        "resources/subscribe" | "resources/unsubscribe" => {
            is_url(params.get("uri")).then_some(ClientRequest::Unhandled)
        }
        "logging/setLevel" => params
            .get("level")
            .and_then(Value::as_str)
            .is_some_and(|level| LOGGING_LEVELS.contains(&level))
            .then_some(ClientRequest::Unhandled),
        "completion/complete" => {
            let reference_ok = match params.get("ref") {
                Some(Value::Object(reference)) => match reference.get("type").and_then(Value::as_str) {
                    Some("ref/resource") => is_text(reference.get("uri")),
                    Some("ref/prompt") => is_text(reference.get("name")),
                    _ => false,
                },
                _ => false,
            };
            let argument_ok = match params.get("argument") {
                Some(Value::Object(argument)) => is_text(argument.get("name")) && is_text(argument.get("value")),
                _ => false,
            };
            let context_ok = match params.get("context") {
                None | Some(Value::Null) => true,
                Some(Value::Object(context)) => match context.get("arguments") {
                    None | Some(Value::Null) => true,
                    Some(Value::Object(arguments)) => arguments.values().all(Value::is_string),
                    Some(_) => false,
                },
                Some(_) => false,
            };
            (reference_ok && argument_ok && context_ok).then_some(ClientRequest::Unhandled)
        }
        "tasks/get" | "tasks/result" | "tasks/cancel" => {
            is_text(params.get("taskId")).then_some(ClientRequest::Unhandled)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pydantic::format_errors;
    use serde_json::json;

    #[test]
    fn a_request_a_notification_and_what_is_neither() {
        let request = classify(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).expect("valid");
        assert_eq!(request, Incoming::Request { id: json!(1), method: "ping".into(), params: None });
        // an id that is not an integer or text makes it a notification (the id is an extra member there)
        for id in [json!(1.5), json!(null), json!(true), json!({})] {
            let read = classify(&json!({"jsonrpc": "2.0", "id": id, "method": "ping"})).expect("valid");
            assert_eq!(read, Incoming::Notification { method: "ping".into(), params: None });
        }
        assert_eq!(classify(&json!({"jsonrpc": "2.0", "id": 1, "result": {}})), Ok(Incoming::Reply));
        let errors = classify(&json!({"jsonrpc": "2.0", "id": 1})).expect_err("invalid");
        let text = format_errors("JSONRPCMessage", &errors);
        assert!(text.starts_with(
            "4 validation errors for JSONRPCMessage\nJSONRPCRequest.method\n  Field required [type=missing, \
             input_value={'jsonrpc': '2.0', 'id': 1}, input_type=dict]\n"
        ));
        assert_eq!(errors.len(), 4);
    }

    #[test]
    fn the_requests_a_client_may_send() {
        let object = |v: Value| v.as_object().cloned();
        assert_eq!(client_request("ping", None), Some(ClientRequest::Ping));
        assert_eq!(client_request("foo/bar", None), None);
        assert_eq!(client_request("tools/call", None), None);
        assert_eq!(client_request("tools/list", object(json!({"cursor": 5})).as_ref()), None);
        assert_eq!(client_request("tools/call", object(json!({"name": "t", "arguments": []})).as_ref()), None);
        assert_eq!(
            client_request("tools/call", object(json!({"name": "t", "arguments": null})).as_ref()),
            Some(ClientRequest::CallTool { name: "t".into(), arguments: Map::new() })
        );
        assert_eq!(
            client_request("logging/setLevel", object(json!({"level": "info"})).as_ref()),
            Some(ClientRequest::Unhandled)
        );
        assert_eq!(client_request("logging/setLevel", object(json!({"level": "loud"})).as_ref()), None);
    }
}
