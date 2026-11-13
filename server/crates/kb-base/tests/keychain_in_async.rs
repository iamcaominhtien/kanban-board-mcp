//! The keychain asked from the app's async runtime (a request, the start of the server). On Linux the Secret Service
//! client used to panic there ("Cannot start a runtime from within a runtime"), which stopped the server at its start
//! when the board in use was on a database server with a saved password. Alone in its file: it sets the variable.

use kb_base::secrets;

#[tokio::test(flavor = "multi_thread")]
#[allow(unsafe_code)]
async fn the_keychain_answers_or_refuses_without_stopping_the_app() {
    let dir = tempfile::tempdir().expect("tmp");
    // the only test of this process: the variables are set before anything reads them
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path());
        std::env::set_var("KANBAN_AI_KEY_FILE", dir.path().join("ai-secret.key"));
        std::env::set_var("KANBAN_SECRET_STORE", "keychain");
    }
    // a computer without a keychain says so; one with a keychain encrypts: neither panics
    match secrets::encrypt("a database password") {
        Ok(token) => assert_eq!(secrets::decrypt(Some(&token)).as_deref(), Some("a database password")),
        Err(err) => assert_eq!(err.0, secrets::KEYCHAIN_DENIED),
    }
    assert_eq!(secrets::decrypt(Some("not a token")), None);
}
