//! The sign-in state of an account: asking its CLI who is signed in, writing the answer into the row (`apply`, the
//! state machine), and what follows for the members that run as the account. In `accounts.py` these are the functions
//! from `_apply` to `sign_out`.

use std::sync::Arc;

use kb_ai::profiles::{self, Profile};
use kb_ai::store::{now_iso, parse_iso, save};
use kb_base::events;
use kb_db::Session;
use kb_db::entities::ai_account;
use kb_db::sea_orm::DbErr;

use super::{Error, get, list_all, members_of, profile_of};

/// Write a CLI answer into the row. Returns True when the account has just been found signed out (`_apply`).
pub fn apply(account: &mut ai_account::Model, status: Option<&profiles::Status>, found: bool) -> bool {
    let before = account.status.clone();
    let now = now_iso();
    account.checked_at = Some(now.clone());
    if !found {
        account.status = "cli_missing".to_string();
        account.status_detail = Some("CLI not installed".to_string());
    } else {
        let Some(status) = status else {
            return false; // the CLI did not answer: keep what we knew
        };
        let text = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
        if status.signed_in {
            account.status = "signed_in".to_string();
            account.status_detail = Some(status.detail.clone()).filter(|d| !d.is_empty());
            account.email = text(&status.email).or_else(|| account.email.take());
            account.plan = text(&status.plan).or_else(|| account.plan.take());
            account.method = text(&status.method).or_else(|| account.method.take());
            account.signed_out_at = None;
            account.signed_out_how = None;
        } else {
            account.status = "needs_sign_in".to_string();
            account.status_detail =
                Some(if status.detail.is_empty() { "Not signed in".to_string() } else { status.detail.clone() });
        }
    }
    account.updated_at = now;
    before == "signed_in" && account.status == "needs_sign_in"
}

/// The name of the Python exception a failed profile call stands for (`type(exc).__name__`).
fn exception_name(e: &profiles::Error) -> &'static str {
    match e {
        profiles::Error::Fail(_) => "Fail",
        profiles::Error::Timeout => "TimeoutExpired",
        profiles::Error::Io(e) => match e.kind() {
            std::io::ErrorKind::NotFound => "FileNotFoundError",
            std::io::ErrorKind::PermissionDenied => "PermissionError",
            _ => "OSError",
        },
    }
}

/// Ask the account's CLI whether it is signed in. Returns (answer or None if it did not answer, CLI found) (`_ask`).
async fn ask(account: &ai_account::Model) -> Result<(Option<profiles::Status>, bool), Error> {
    let profile = profile_of(account).await?;
    if profile.base().binary.as_deref().is_none_or(str::is_empty) {
        return Ok((None, false));
    }
    // a CLI that crashes or hangs is not "signed in"
    let answer = tokio::task::spawn_blocking(move || profile.prepare().and_then(|()| profile.check())).await;
    let status = match answer {
        Ok(Ok(status)) => status,
        Ok(Err(exc)) => profiles::Status {
            signed_in: false,
            detail: format!("The CLI did not answer ({})", exception_name(&exc)),
            ..profiles::Status::default()
        },
        Err(_) => profiles::Status {
            signed_in: false,
            detail: "The CLI did not answer (RuntimeError)".to_string(),
            ..profiles::Status::default()
        },
    };
    Ok((Some(status), true))
}

/// Members on an account follow its sign-in: signed out holds them all, signed in frees them all (a queued run
/// then starts on the next tick). One sign-in, fixed once.
pub async fn follow(session: &Session, account: &ai_account::Model) -> Result<(), DbErr> {
    for mut m in members_of(session, &account.id).await? {
        if account.status == "needs_sign_in" && m.health != "not_logged_in" {
            m.health = "not_logged_in".to_string();
            m.health_detail = Some(format!("The account {} needs to sign in.", account.name));
        } else if account.status == "signed_in" && m.health == "not_logged_in" {
            m.health = "ok".to_string();
            m.health_detail = None;
        } else {
            continue;
        }
        m.checked_at = Some(now_iso());
        save(session, m).await?;
    }
    session.commit().await
}

/// Ask the CLI whether this account is signed in (never reads the login) and remember the answer. A sign-in that
/// has just ended is recorded once, with how it was found (`check` or `run`).
pub async fn check(session: &Session, mut account: ai_account::Model, how: &str) -> Result<ai_account::Model, Error> {
    let (answer, found) = ask(&account).await?;
    if apply(&mut account, answer.as_ref(), found) {
        account.signed_out_at = Some(now_iso());
        account.signed_out_how = Some(how.to_string());
    }
    let account = save(session, account).await?;
    session.commit().await?;
    follow(session, &account).await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(account)
}

/// How many accounts `check_all` asks at the same time.
pub const CHECKS_AT_ONCE: usize = 3;

/// Check every account (a few at a time). With `only_stale_s`, skip those checked more recently. Returns how
/// many changed state.
pub async fn check_all(session: &Session, only_stale_s: Option<f64>) -> Result<usize, Error> {
    let now = parse_iso(Some(&now_iso()));
    let gate = Arc::new(tokio::sync::Semaphore::new(CHECKS_AT_ONCE));
    let mut todo = Vec::new();
    for a in list_all(session).await? {
        let seen = parse_iso(a.checked_at.as_deref());
        if let (Some(stale), Some(seen), Some(now)) = (only_stale_s.filter(|s| *s != 0.0), seen, now) {
            if ((now - seen).num_microseconds().unwrap_or(i64::MAX) as f64) / 1e6 < stale {
                continue;
            }
        }
        todo.push(a);
    }

    async fn one(
        gate: Arc<tokio::sync::Semaphore>,
        mut a: ai_account::Model,
    ) -> Result<(ai_account::Model, bool), Error> {
        let _permit = gate.acquire().await.map_err(|e| Error::Other(e.to_string()))?;
        let before = a.status.clone();
        let (answer, found) = ask(&a).await?;
        if apply(&mut a, answer.as_ref(), found) {
            a.signed_out_at = Some(now_iso());
            a.signed_out_how = Some("check".to_string());
        }
        let changed = a.status != before;
        Ok((a, changed))
    }

    let asked: Vec<_> = todo.into_iter().map(|a| tokio::spawn(one(gate.clone(), a))).collect();
    let mut done = Vec::new();
    let mut failed = None;
    for task in asked {
        // every answer is waited for, as `gather` does, before the first error is raised
        match task.await {
            Ok(Ok(pair)) => done.push(pair),
            Ok(Err(e)) => failed = failed.or(Some(e)),
            Err(e) => failed = failed.or(Some(Error::Other(e.to_string()))),
        }
    }
    if let Some(e) = failed {
        return Err(e);
    }
    let mut stored = Vec::new();
    let mut changed = 0;
    for (a, was_changed) in done {
        stored.push(save(session, a).await?);
        changed += usize::from(was_changed);
    }
    session.commit().await?;
    for a in &stored {
        follow(session, a).await?;
    }
    if !stored.is_empty() {
        events::publish(events::INVALIDATE, &[]).await;
    }
    Ok(changed)
}

/// A run failed with a sign-in error: the account is signed out now, and every member on it follows.
pub async fn mark_signed_out(
    session: &Session,
    mut account: ai_account::Model,
    how: &str,
    detail: Option<&str>,
) -> Result<ai_account::Model, Error> {
    if account.status == "needs_sign_in" {
        return Ok(account);
    }
    account.status = "needs_sign_in".to_string();
    account.status_detail = Some(detail.filter(|d| !d.is_empty()).unwrap_or("Session expired").to_string());
    account.signed_out_at = Some(now_iso());
    account.signed_out_how = Some(how.to_string());
    account.updated_at = now_iso();
    let account = save(session, account).await?;
    session.commit().await?;
    follow(session, &account).await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(account)
}

/// A call of a profile that runs the CLI, off the event loop (`asyncio.to_thread`).
pub(super) async fn in_thread(profile: Box<dyn Profile>, call: fn(&dyn Profile)) -> Result<(), Error> {
    tokio::task::spawn_blocking(move || call(profile.as_ref())).await.map_err(|e| Error::Other(e.to_string()))
}

/// The CLI forgets the login; the account stays in the list.
pub async fn sign_out(session: &Session, account_id: &str) -> Result<ai_account::Model, Error> {
    let mut account = get(session, account_id).await?;
    let profile = profile_of(&account).await?;
    in_thread(profile, |p| p.sign_out()).await?;
    account.status = "needs_sign_in".to_string();
    account.status_detail = Some("Signed out".to_string());
    account.signed_out_at = None;
    account.signed_out_how = None;
    account.email = None;
    account.plan = None;
    account.updated_at = now_iso();
    let account = save(session, account).await?;
    session.commit().await?;
    follow(session, &account).await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(account)
}
