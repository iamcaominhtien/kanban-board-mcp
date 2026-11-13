//! `pictures` (`services/ai/pictures.py`): the uploads a prompt names are copied into a folder of that call only. The Python
//! module has no test of its own (it is covered through the runs and the chat); the cases are written from its code.

mod common;

use kb_ai::pictures;

#[tokio::test]
async fn uploads_named_in_a_text_are_copied_to_the_calls_folder_and_listed() {
    let _lock = common::init().await;
    let uploads = std::path::PathBuf::from(std::env::var("KANBAN_UPLOADS_DIR").expect("set by common::init"));
    std::fs::create_dir_all(uploads.join("2026-11")).expect("folder");
    std::fs::create_dir_all(uploads.join("_private")).expect("folder");
    std::fs::write(uploads.join("2026-11/pic.png"), b"PNG").expect("file");
    std::fs::write(uploads.join("2026-11/other.png"), b"PNG2").expect("file");
    std::fs::write(uploads.join("_private/secret.png"), b"SECRET").expect("file");
    let key = format!("run_{}", kb_base::time::uuid4_hex());
    let text = "See ![a](/uploads/2026-11/pic.png) and ![b](/uploads/2026-11/pic.png) and /uploads/_private/secret.png and \
                ![c](/uploads/2026-11/missing.png) and (/uploads/2026-11/other.png) and /uploads/../etc/passwd";
    let (staged, folder) = pictures::stage(text, &key).expect("stage");
    let folder = folder.expect("a folder");
    assert_eq!(std::path::PathBuf::from(&folder), pictures::folder_for(&key));
    assert!(folder.ends_with(&format!("kanban-ai-pictures/{key}")));
    assert!(staged.starts_with(&format!(
        "{text}\n\nPictures and files in the text above, as files on this computer: open each with Read"
    )));
    assert!(staged.contains(&format!("\n- /uploads/2026-11/pic.png → {folder}/pic.png")));
    assert!(staged.contains(&format!("\n- /uploads/2026-11/other.png → {folder}/other.png")));
    assert_eq!(staged.matches("pic.png →").count(), 1, "each upload once");
    assert!(!staged.contains("secret") || !staged.contains("→ ") || !staged.contains("_private/secret.png →"));
    assert!(!staged.contains("missing.png →") && !staged.contains("passwd →"));
    assert_eq!(std::fs::read(format!("{folder}/pic.png")).expect("copy"), b"PNG");
    assert!(!std::path::Path::new(&format!("{folder}/secret.png")).exists());
    // a second call with the same key keeps the copy it has
    std::fs::write(format!("{folder}/pic.png"), b"EDITED").expect("file");
    pictures::stage(text, &key).expect("stage");
    assert_eq!(std::fs::read(format!("{folder}/pic.png")).expect("copy"), b"EDITED");
    // nothing to copy: the text as it was, no folder
    assert_eq!(pictures::stage("no pictures here", &key).expect("stage"), ("no pictures here".to_string(), None));
    assert_eq!(pictures::stage("", &key).expect("stage"), (String::new(), None));
    // the key becomes a safe folder name
    assert!(pictures::folder_for("run/../x y").ends_with("kanban-ai-pictures/run____x_y"));
    assert_eq!(pictures::folder_for(&"k".repeat(200)).file_name().expect("name").len(), 80);
    let _ = std::fs::remove_dir_all(folder);
}
