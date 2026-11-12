//! One open sign-in (`SignIn`), the messages its windows get (`Queue`) and the open sign-ins by account (`SESSIONS`).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

use portable_pty::MasterPty;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::read_screen;

/// The messages of one window: the newest 500, the oldest dropped when it does not keep up
/// (`asyncio.Queue(maxsize=500)`).
#[derive(Default)]
pub struct Queue {
    items: Mutex<VecDeque<Value>>,
    news: tokio::sync::Notify,
}

impl Queue {
    const MAX: usize = 500;

    pub(super) fn put(&self, message: Value) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if items.len() >= Self::MAX {
            items.pop_front();
        }
        items.push_back(message);
        drop(items);
        self.news.notify_one();
    }

    /// The next message, if one waits (`q.get_nowait()`).
    pub fn get_nowait(&self) -> Option<Value> {
        self.items.lock().unwrap_or_else(|e| e.into_inner()).pop_front()
    }

    /// The next message (`await q.get()`).
    pub async fn get(&self) -> Value {
        loop {
            if let Some(message) = self.get_nowait() {
                return message;
            }
            self.news.notified().await;
        }
    }
}

/// `codecs.getincrementaldecoder("utf-8")("replace")`: text out of pieces that may end in the middle of a character.
#[derive(Default)]
pub(super) struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    pub(super) fn decode(&mut self, data: &[u8]) -> String {
        self.pending.extend_from_slice(data);
        let bytes = std::mem::take(&mut self.pending);
        let mut out = String::new();
        let mut rest = &bytes[..];
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(&String::from_utf8_lossy(valid));
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            rest = &after[n..];
                        }
                        None => {
                            // the start of a character whose end has not arrived
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

pub(super) struct State {
    pub(super) master: Option<Box<dyn MasterPty + Send>>,
    pub(super) input: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    pub(super) pid: Option<i32>,
    pub(super) exit: Option<watch::Receiver<Option<i32>>>,
    pub(super) buffer: Vec<u8>,
    pub(super) decoder: Decoder,
    pub(super) watchers: Vec<Arc<Queue>>,
    pub(super) exit_code: Option<i32>,
    /// None while open | exited | cancelled | done
    pub(super) ended: Option<String>,
    pub(super) signed_in: bool,
    pub(super) duplicate_of: Option<String>,
    pub(super) account: Option<Value>,
    pub(super) poller: Option<tokio::task::JoinHandle<()>>,
    pub(super) exiter: Option<tokio::task::JoinHandle<()>>,
    pub(super) orphan: Option<tokio::task::JoinHandle<()>>,
}

/// One open sign-in: the process, its output and the people watching it.
pub struct SignIn {
    /// The account being signed in.
    pub account_id: String,
    /// Who started it.
    pub by: String,
    /// The login command.
    pub argv: Vec<String>,
    /// When it started (`time.time()`).
    pub started: f64,
    /// The account was signed in before: its status says so at once, so "signed in" only counts once the CLI's login
    /// has ended (Claude Code and Codex end by themselves; for the others the person presses Done)
    pub was_signed_in: bool,
    /// Windows: the login runs in a console window of its own, not in a terminal the app shows
    pub console: bool,
    state: Mutex<State>,
}

impl SignIn {
    /// A sign-in with no process yet (`SignIn(account_id, by, argv)`).
    pub fn new(account_id: &str, by: &str, argv: Vec<String>) -> Arc<Self> {
        Self::with(account_id, by, argv, false, false)
    }

    pub(super) fn with(account_id: &str, by: &str, argv: Vec<String>, was_signed_in: bool, console: bool) -> Arc<Self> {
        Arc::new(Self {
            account_id: account_id.to_string(),
            by: by.to_string(),
            argv,
            started: kb_base::time::epoch(),
            was_signed_in,
            console,
            state: Mutex::new(State {
                master: None,
                input: None,
                pid: None,
                exit: None,
                buffer: Vec::new(),
                decoder: Decoder::default(),
                watchers: Vec::new(),
                exit_code: None,
                ended: None,
                signed_in: false,
                duplicate_of: None,
                account: None,
                poller: None,
                exiter: None,
                orphan: None,
            }),
        })
    }

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The login's pid (`session.proc.pid`).
    pub fn pid(&self) -> Option<i32> {
        self.lock().pid
    }

    /// The login's exit code once it has ended, as `session.proc.poll()` gives it (minus the signal that ended it).
    pub fn poll(&self) -> Option<i32> {
        self.lock().exit.as_ref().and_then(|exit| *exit.borrow())
    }

    /// None while open | exited | cancelled | done
    pub fn ended(&self) -> Option<String> {
        self.lock().ended.clone()
    }

    /// The exit code the window is shown (set when the login ended by itself).
    pub fn exit_code(&self) -> Option<i32> {
        self.lock().exit_code
    }

    /// Whether the CLI said the account is signed in, and this sign-in may say so.
    pub fn signed_in(&self) -> bool {
        self.lock().signed_in
    }

    /// The name of another account with the same login, when there is one.
    pub fn duplicate_of(&self) -> Option<String> {
        self.lock().duplicate_of.clone()
    }

    /// The account as the window shows it, once the CLI was asked.
    pub fn account(&self) -> Option<Value> {
        self.lock().account.clone()
    }

    /// Send a message to every window attached.
    pub fn publish(&self, message: &Value) {
        let watchers = self.lock().watchers.clone();
        for q in watchers {
            q.put(message.clone());
        }
    }

    /// What the window shows besides the terminal.
    pub fn state(&self) -> Value {
        let state = self.lock();
        let screen = read_screen(&String::from_utf8_lossy(&state.buffer), state.signed_in);
        json!({
            "type": "state",
            "running": state.ended.is_none(),
            "ended": state.ended,
            "exit_code": state.exit_code,
            "signed_in": state.signed_in,
            "duplicate_of": state.duplicate_of,
            "elapsed": (kb_base::time::epoch() - self.started) as i64,
            "account": state.account,
            "phase": screen.phase,
            "url": screen.url,
        })
    }
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<SignIn>>>> = LazyLock::new(Mutex::default);

pub(super) fn sessions() -> std::sync::MutexGuard<'static, HashMap<String, Arc<SignIn>>> {
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The sign-in last opened for an account, open or just ended (`SESSIONS.get(account_id)`).
pub fn session(account_id: &str) -> Option<Arc<SignIn>> {
    sessions().get(account_id).cloned()
}

/// The open sign-in of an account, if any.
pub fn active(account_id: &str) -> Option<Arc<SignIn>> {
    session(account_id).filter(|s| s.ended().is_none())
}

/// Who is signing in to this account right now.
pub fn signing_in_by(account_id: &str) -> Option<String> {
    active(account_id).map(|s| s.by.clone())
}
