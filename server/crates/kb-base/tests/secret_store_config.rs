//! Which key store a program uses when `KANBAN_SECRET_STORE` is not given to it: the one the desktop app recorded in
//! the config file. This test is alone in its file because the settings folder is read once per process.

use kb_base::secrets;

#[test]
#[allow(unsafe_code)]
fn a_program_without_the_variable_reads_the_store_the_app_recorded() {
    let dir = tempfile::tempdir().expect("tmp");
    // the only test of this process: the folder is in place before anything reads it
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path());
        std::env::remove_var("KANBAN_SECRET_STORE");
    }
    // nothing recorded: the key file
    assert_eq!(secrets::store_kind(), "file");
    // the desktop app starts with the variable and records it
    unsafe { std::env::set_var("KANBAN_SECRET_STORE", "keychain") };
    secrets::record_store();
    assert!(
        std::fs::read_to_string(dir.path().join("config.json"))
            .expect("config")
            .contains("\"secret_store\": \"keychain\"")
    );
    // an editor's MCP process has no variable: it reads what was recorded
    unsafe { std::env::remove_var("KANBAN_SECRET_STORE") };
    assert_eq!(secrets::store_kind(), "keychain");
    // a variable that is set still wins
    unsafe { std::env::set_var("KANBAN_SECRET_STORE", "file") };
    assert_eq!(secrets::store_kind(), "file");
}
