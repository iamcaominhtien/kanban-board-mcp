//! Pages: create, read, update, edit, move, duplicate, delete, the bin, versions, links, search, import, upload,
//! tickets from a page and assign.

use serde_json::json;

use super::{Call, Fixtures, call, dr, dw, dwk, finish, golden, keep, run_with_files};
use crate::{Run, common};

const SPEC: &str = "## Overview\n\nThe API is REST.\n\n## Endpoints\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n\n### Errors\n\n401 when the token is missing.\n\n## Limits\n\nRate limits are not enforced yet.\n";

fn setup() -> Vec<Call> {
    vec![
        keep("setup: project", "manage_project", json!({"action": "create", "name": "Docs", "prefix": "DOC"}), "p"),
        keep(
            "setup: other project",
            "manage_project",
            json!({"action": "create", "name": "Other", "prefix": "OTH"}),
            "p2",
        ),
        keep(
            "setup: a ticket",
            "manage_ticket",
            json!({"action": "create", "project_id": "$p", "title": "Rate limit", "type": "task"}),
            "t1",
        ),
    ]
}

/// Arguments both tools refuse, before any page exists.
fn refused_arguments() -> Vec<Call> {
    vec![
        call("read: no arguments", "docs_read", json!({})),
        dr("read: an unknown action", "nope", json!({})),
        call("read: action null", "docs_read", json!({"action": null})),
        call("read: action a number", "docs_read", json!({"action": 5})),
        call("read: action in other case", "docs_read", json!({"action": "List"})),
        call("read: an unknown argument", "docs_read", json!({"action": "list", "project": "x"})),
        call("read: two errors at once", "docs_read", json!({"action": "nope", "limit": "many", "refs": 5})),
        call(
            "read: limit text",
            "docs_read",
            json!({"action": "search", "project_id": "$p", "query": "x", "limit": "many"}),
        ),
        call(
            "read: scope unknown",
            "docs_read",
            json!({"action": "search", "project_id": "$p", "query": "x", "scope": "web"}),
        ),
        call("read: state unknown", "docs_read", json!({"action": "comments", "page_id": "x", "state": "closed"})),
        call(
            "read: refs not a list",
            "docs_read",
            json!({"action": "check_links", "project_id": "$p", "refs": "[[A]]"}),
        ),
        dr("list: nothing else", "list", json!({})),
        dr("list: null counts as left out", "list", json!({"project_id": null})),
        dr("list: a parameter it does not use", "list", json!({"project_id": "$p", "page_id": "x"})),
        dr("list: two parameters it does not use", "list", json!({"project_id": "$p", "query": "x", "limit": 5})),
        dr("list: a project that does not exist", "list", json!({"project_id": "nope"})),
        dr("list: an empty project", "list", json!({"project_id": "$p"})),
        dr("get: nothing else", "get", json!({})),
        dr("get: a page that does not exist", "get", json!({"page_id": "nope"})),
        dr("get: a parameter it does not use", "get", json!({"page_id": "x", "version": 1})),
        dr("search: nothing else", "search", json!({})),
        dr("search: no query", "search", json!({"project_id": "$p"})),
        dr("search: an empty project", "search", json!({"project_id": "$p", "query": "buckets"})),
        dr("search: a project that does not exist", "search", json!({"project_id": "nope", "query": "x"})),
        dr("search: a blank query", "search", json!({"project_id": "$p", "query": "   "})),
        dr("versions: nothing else", "versions", json!({})),
        dr("versions: a page that does not exist", "versions", json!({"page_id": "nope"})),
        dr("version: no version", "version", json!({"page_id": "x"})),
        dr("version: a page that does not exist", "version", json!({"page_id": "nope", "version": 1})),
        dr("recycle_bin: nothing else", "recycle_bin", json!({})),
        dr("recycle_bin: empty", "recycle_bin", json!({"project_id": "$p"})),
        dr("recycle_bin: a project that does not exist", "recycle_bin", json!({"project_id": "nope"})),
        dr("check_links: no refs", "check_links", json!({"project_id": "$p"})),
        dr("check_links: not a link", "check_links", json!({"project_id": "$p", "refs": ["plain words"]})),
        dr("check_links: an empty list", "check_links", json!({"project_id": "$p", "refs": []})),
        dw("write: no arguments", "", json!({})),
        call("write: no arguments at all", "docs_write", json!({})),
        dw("write: an unknown action", "nope", json!({})),
        call("write: action null", "docs_write", json!({"action": null})),
        call("write: an unknown argument", "docs_write", json!({"action": "create", "folder": "x"})),
        call(
            "write: two errors at once",
            "docs_write",
            json!({"action": "nope", "publish": "maybe", "base_version": "v2"}),
        ),
        dw("create: nothing else", "create", json!({})),
        dw("create: no title", "create", json!({"project_id": "$p"})),
        dw("create: no project", "create", json!({"title": "A"})),
        dw("create: a parameter it does not use", "create", json!({"project_id": "$p", "title": "A", "page_id": "x"})),
        dw(
            "create: a parameter of the other actions",
            "create",
            json!({"project_id": "$p", "title": "A", "section": "x"}),
        ),
        dw(
            "create: two parameters of the other actions",
            "create",
            json!({"project_id": "$p", "title": "A", "mode": "append", "find": "x"}),
        ),
        dw("create: a project that does not exist", "create", json!({"project_id": "nope", "title": "A"})),
        dw("create: an empty title", "create", json!({"project_id": "$p", "title": "  "})),
        dw("create: a long title", "create", json!({"project_id": "$p", "title": "t".repeat(201)})),
        dw(
            "create: a parent that does not exist",
            "create",
            json!({"project_id": "$p", "title": "A", "parent_id": "nope"}),
        ),
        dw(
            "create: a picture that is not there",
            "create",
            json!({"project_id": "$p", "title": "Pics", "markdown": "![shot](/no/such/shot.png)"}),
        ),
        dw(
            "items: only the light actions take them",
            "create",
            json!({"project_id": "$p", "title": "A", "items": [{"title": "B"}]}),
        ),
        dw("items: not a list", "comment", json!({"page_id": "x", "body": "y", "items": "text"})),
        dw("items: an empty list", "comment", json!({"page_id": "x", "body": "y", "items": []})),
        dw(
            "items: too many",
            "comment",
            json!({"page_id": "x", "items": (0..26).map(|i| json!({"body": format!("c{i}")})).collect::<Vec<_>>()}),
        ),
        dw("update: nothing else", "update", json!({})),
        dw("update: no base_version", "update", json!({"page_id": "x", "markdown": "y"})),
        dw(
            "update: a page that does not exist",
            "update",
            json!({"page_id": "nope", "markdown": "y", "base_version": 1}),
        ),
        dw(
            "update: a parameter it does not use",
            "update",
            json!({"page_id": "x", "markdown": "y", "base_version": 1, "kind": "write"}),
        ),
        dw("move: nothing else", "move", json!({})),
        dw("move: a page that does not exist", "move", json!({"page_id": "nope"})),
        dw("duplicate: a page that does not exist", "duplicate", json!({"page_id": "nope"})),
        dw("delete: a page that does not exist", "delete", json!({"page_id": "nope"})),
        dw("restore: a page that does not exist", "restore", json!({"page_id": "nope"})),
        dw("restore_version: no version", "restore_version", json!({"page_id": "x"})),
        dw("restore_version: a page that does not exist", "restore_version", json!({"page_id": "nope", "version": 1})),
        dw("edit: no page", "edit", json!({"markdown": "x"})),
        dw("edit: a page that does not exist", "edit", json!({"page_id": "nope", "markdown": "x", "section": "A"})),
        dw(
            "edit: a parameter it does not use",
            "edit",
            json!({"page_id": "x", "markdown": "x", "kind": "write", "title": "t"}),
        ),
        dw("edit: items and one edit", "edit", json!({"page_id": "x", "markdown": "x", "items": [{"markdown": "y"}]})),
        dw("edit: items not a list", "edit", json!({"page_id": "x", "items": "text"})),
        dw("edit: items empty", "edit", json!({"page_id": "x", "items": []})),
        dw(
            "edit: too many items",
            "edit",
            json!({"page_id": "x", "items": (0..26).map(|i| json!({"markdown": format!("m{i}")})).collect::<Vec<_>>()}),
        ),
        dw("upload: nothing", "upload", json!({})),
        dw("upload: both a path and data", "upload", json!({"path": "/x.png", "data": "AAAA", "name": "x.png"})),
        dw("upload: data without a name", "upload", json!({"data": "AAAA"})),
        dw("upload: data that is not base64", "upload", json!({"data": "not base64!", "name": "x.png"})),
        dw("upload: a parameter it does not use", "upload", json!({"path": "/x.png", "title": "x"})),
        dw("upload: section without a page", "upload", json!({"data": "AAAA", "name": "x.png", "section": "A"})),
        dw("upload: body without a ticket", "upload", json!({"data": "AAAA", "name": "x.png", "body": "text"})),
        dw("tickets: no page", "tickets", json!({})),
        dw("tickets: a parameter it does not use", "tickets", json!({"page_id": "x", "title": "t"})),
        dw("tickets: a page that does not exist", "tickets", json!({"page_id": "nope"})),
        dw("assign: no page", "assign", json!({})),
        dw("assign: no member", "assign", json!({"page_id": "x"})),
        dw("assign: no kind", "assign", json!({"page_id": "x", "member_id": "m"})),
        dw(
            "assign: a parameter it does not use",
            "assign",
            json!({"page_id": "x", "member_id": "m", "kind": "write", "title": "t"}),
        ),
        dw("assign: a kind that is not one", "assign", json!({"page_id": "x", "member_id": "m", "kind": "read"})),
        dw(
            "assign: a page that does not exist",
            "assign",
            json!({"page_id": "nope", "member_id": "m", "kind": "write"}),
        ),
        dw("import: nothing else", "import", json!({})),
        dw("import: a path that does not exist", "import", json!({"project_id": "$p", "path": "/no/such/folder"})),
    ]
}

fn pages(f: &Fixtures) -> Vec<Call> {
    vec![
        dwk("create: Runbook", "create", json!({"project_id": "$p", "title": "Runbook", "markdown": SPEC}), "pg1"),
        dwk(
            "create: a child",
            "create",
            json!({"project_id": "$p", "title": "Child", "markdown": "Body\n", "parent_id": "$pg1"}),
            "pg2",
        ),
        dwk("create: a page with no body", "create", json!({"project_id": "$p", "title": "Empty page"}), "pg3"),
        dwk("create: the same title again", "create", json!({"project_id": "$p", "title": "Runbook"}), "pg4"),
        dwk(
            "create: in the other project",
            "create",
            json!({"project_id": "$p2", "title": "Elsewhere", "markdown": "## A\nx"}),
            "pg5",
        ),
        dw(
            "create: a parent of another project",
            "create",
            json!({"project_id": "$p", "title": "Lost", "parent_id": "$pg5"}),
        ),
        dwk(
            "create: a title with a link and quotes",
            "create",
            json!({"project_id": "$p", "title": "Limits \"v2\" & more", "markdown": "See [[Runbook#Limits]] and [[Ghost]] and $t1."}),
            "pg6",
        ),
        dwk(
            "create: a picture that exists",
            "create",
            json!({"project_id": "$p", "title": "Pictures", "markdown": format!("![shot]({})\n\nand [notes]({})", f.path("pic.png"), f.path("notes.txt"))}),
            "pg7",
        ),
        dw(
            "create: a key file is never copied",
            "create",
            json!({"project_id": "$p", "title": "Keys", "markdown": format!("![k]({})", f.path("secret.pem"))}),
        ),
        dr("list: the tree", "list", json!({"project_id": "$p"})),
        dr("list: the other project", "list", json!({"project_id": "$p2"})),
        dr("get: Runbook", "get", json!({"page_id": "$pg1"})),
        dr("get: a section", "get", json!({"page_id": "$pg1", "section": "Endpoints"})),
        dr("get: a section by slug", "get", json!({"page_id": "$pg1", "section": "errors"})),
        dr("get: a section that is not there", "get", json!({"page_id": "$pg1", "section": "Billing"})),
        dr("get: the page with a link", "get", json!({"page_id": "$pg6"})),
        dr("get: a page with a picture", "get", json!({"page_id": "$pg7"})),
        dr("get: the page that is linked to", "get", json!({"page_id": "$pg1"})),
        dw("update: stale base_version", "update", json!({"page_id": "$pg1", "markdown": "x", "base_version": 5})),
        dw("update: base_version 0", "update", json!({"page_id": "$pg1", "markdown": "x", "base_version": 0})),
        dw(
            "update: replace the text",
            "update",
            json!({"page_id": "$pg1", "markdown": SPEC.replace("not enforced yet", "100 per minute"), "base_version": 1, "note": "Rate limits"}),
        ),
        dw(
            "update: and rename",
            "update",
            json!({"page_id": "$pg3", "markdown": "## A\nfilled\n", "base_version": 1, "title": "Filled page"}),
        ),
        dw(
            "update: rename to the same title",
            "update",
            json!({"page_id": "$pg3", "markdown": "## A\nfilled again\n", "base_version": 2, "title": " Filled page "}),
        ),
        dw(
            "update: rename to a title in use",
            "update",
            json!({"page_id": "$pg3", "markdown": "x", "base_version": 3, "title": "Runbook"}),
        ),
        dw(
            "update: a draft only",
            "update",
            json!({"page_id": "$pg3", "markdown": "## A\nmy draft\n", "base_version": 3, "publish": false}),
        ),
        dw(
            "update: a draft with a stale base",
            "update",
            json!({"page_id": "$pg3", "markdown": "x", "base_version": 9, "publish": false}),
        ),
        dw(
            "update: too large",
            "update",
            json!({"page_id": "$pg3", "markdown": "x".repeat(1_000_001), "base_version": 3}),
        ),
        dr("get: after the update", "get", json!({"page_id": "$pg1"})),
        dr("get: with an unpublished draft", "get", json!({"page_id": "$pg3"})),
        dw(
            "edit: an unpublished draft is never dropped",
            "edit",
            json!({"page_id": "$pg3", "markdown": "z", "mode": "append"}),
        ),
        dw(
            "update: publish over the draft",
            "update",
            json!({"page_id": "$pg3", "markdown": "## A\npublished\n", "base_version": 3}),
        ),
        dr("versions: Runbook", "versions", json!({"page_id": "$pg1"})),
        dr("versions: a page with one", "versions", json!({"page_id": "$pg2"})),
        dr("version: the first", "version", json!({"page_id": "$pg1", "version": 1})),
        dr("version: a diff", "version", json!({"page_id": "$pg1", "version": 1, "compare_to": 2})),
        dr("version: a diff backwards", "version", json!({"page_id": "$pg1", "version": 2, "compare_to": 1})),
        dr("version: one that does not exist", "version", json!({"page_id": "$pg1", "version": 9})),
        dr(
            "version: a diff with one that does not exist",
            "version",
            json!({"page_id": "$pg1", "version": 1, "compare_to": 9}),
        ),
        dw("restore_version: the first", "restore_version", json!({"page_id": "$pg1", "version": 1})),
        dw("restore_version: one that does not exist", "restore_version", json!({"page_id": "$pg1", "version": 9})),
        dr("versions: after the restore", "versions", json!({"page_id": "$pg1"})),
        // --- edit
        dw(
            "edit: replace a section",
            "edit",
            json!({"page_id": "$pg1", "section": "Limits", "markdown": "Rate limits are 100 per minute."}),
        ),
        dw(
            "edit: replace a section by slug with its heading",
            "edit",
            json!({"page_id": "$pg1", "section": "limits", "markdown": "## Limits and quotas\n\nSee the plan."}),
        ),
        dw(
            "edit: append to a section",
            "edit",
            json!({"page_id": "$pg1", "section": "Endpoints", "markdown": "| POST | /tickets |", "mode": "append"}),
        ),
        dw(
            "edit: prepend to a section",
            "edit",
            json!({"page_id": "$pg1", "section": "Overview", "markdown": "> [!NOTE]\n> Draft.", "mode": "prepend"}),
        ),
        dw(
            "edit: after a section",
            "edit",
            json!({"page_id": "$pg1", "section": "Overview", "markdown": "## Auth\n\nTokens.", "mode": "after"}),
        ),
        dw(
            "edit: before a section",
            "edit",
            json!({"page_id": "$pg1", "section": "Auth", "markdown": "## Intro\n\nHi.", "mode": "before"}),
        ),
        dw(
            "edit: a section that is not there",
            "edit",
            json!({"page_id": "$pg1", "section": "Billing", "markdown": "x"}),
        ),
        dw(
            "edit: a passage",
            "edit",
            json!({"page_id": "$pg1", "find": "100 per minute", "markdown": "200 per minute"}),
        ),
        dw(
            "edit: a passage that is not there",
            "edit",
            json!({"page_id": "$pg1", "find": "nothing like this", "markdown": "x"}),
        ),
        dw("edit: a passage that is not unique", "edit", json!({"page_id": "$pg1", "find": "per", "markdown": "x"})),
        dw(
            "edit: a passage with a mode",
            "edit",
            json!({"page_id": "$pg1", "find": "Tokens.", "markdown": "More tokens.", "mode": "after"}),
        ),
        dw(
            "edit: section and find",
            "edit",
            json!({"page_id": "$pg1", "section": "Auth", "find": "Tokens.", "markdown": "x"}),
        ),
        dw("edit: no text", "edit", json!({"page_id": "$pg1", "section": "Auth"})),
        dw(
            "edit: a mode that does not exist",
            "edit",
            json!({"page_id": "$pg1", "section": "Auth", "markdown": "x", "mode": "swap"}),
        ),
        dw(
            "edit: the end of the page",
            "edit",
            json!({"page_id": "$pg1", "markdown": "## Appendix\n\nLast.", "mode": "append"}),
        ),
        dw("edit: the end of the page, replace", "edit", json!({"page_id": "$pg1", "markdown": "x"})),
        dw("edit: nothing changes", "edit", json!({"page_id": "$pg1", "find": "Last.", "markdown": "Last."})),
        dw(
            "edit: several in one version",
            "edit",
            json!({"page_id": "$pg1", "note": "Two edits", "items": [{"section": "Appendix", "markdown": "Final words.", "mode": "append"}, {"find": "Final words.", "markdown": "Final words!"}]}),
        ),
        dw(
            "edit: several, one fails",
            "edit",
            json!({"page_id": "$pg1", "items": [{"section": "Appendix", "markdown": "ok", "mode": "append"}, {"section": "Nope", "markdown": "x"}]}),
        ),
        dw("edit: an item that is not an object", "edit", json!({"page_id": "$pg1", "items": ["text"]})),
        dw(
            "edit: an item with a key it does not use",
            "edit",
            json!({"page_id": "$pg1", "items": [{"markdown": "x", "title": "t"}]}),
        ),
        dw(
            "edit: a stale base_version",
            "edit",
            json!({"page_id": "$pg1", "base_version": 99, "section": "Appendix", "markdown": "x"}),
        ),
        dw(
            "edit: a base_version of 0",
            "edit",
            json!({"page_id": "$pg1", "base_version": 0, "section": "Appendix", "markdown": "x"}),
        ),
        dw(
            "edit: from an older version, other section",
            "edit",
            json!({"page_id": "$pg1", "base_version": 2, "section": "Appendix", "markdown": "From v2.", "mode": "append"}),
        ),
        dw(
            "edit: from an older version, changed section",
            "edit",
            json!({"page_id": "$pg1", "base_version": 2, "section": "Limits and quotas", "markdown": "x"}),
        ),
        dw(
            "edit: without publishing",
            "edit",
            json!({"page_id": "$pg1", "section": "Appendix", "markdown": "Draft words.", "mode": "append", "publish": false}),
        ),
        dr("get: after the edits", "get", json!({"page_id": "$pg1"})),
        // --- move, duplicate, delete
        dw("move: under another page", "move", json!({"page_id": "$pg3", "parent_id": "$pg1"})),
        dw("move: into itself", "move", json!({"page_id": "$pg1", "parent_id": "$pg1"})),
        dw("move: into its own sub-page", "move", json!({"page_id": "$pg1", "parent_id": "$pg3"})),
        dw("move: under a page of another project", "move", json!({"page_id": "$pg3", "parent_id": "$pg5"})),
        dw("move: to the top level after a sibling", "move", json!({"page_id": "$pg3", "after_id": "$pg2"})),
        dw(
            "move: after a page that is not a sibling",
            "move",
            json!({"page_id": "$pg3", "parent_id": "$pg1", "after_id": "$pg5"}),
        ),
        dw("move: after a page that does not exist", "move", json!({"page_id": "$pg3", "after_id": "nope"})),
        dw("move: under a page that does not exist", "move", json!({"page_id": "$pg3", "parent_id": "nope"})),
        dwk("duplicate: with its sub-pages", "duplicate", json!({"page_id": "$pg1", "include_children": true}), "dup"),
        dwk("duplicate: with a title", "duplicate", json!({"page_id": "$pg2", "title": "Copy of the child"}), "dup2"),
        dwk("duplicate: alone", "duplicate", json!({"page_id": "$pg1"}), "dup3"),
        dr("list: after the copies", "list", json!({"project_id": "$p"})),
        dw("delete: the copy", "delete", json!({"page_id": "$dup"})),
        dw("delete: a page that is already in the bin", "delete", json!({"page_id": "$dup"})),
        dr("recycle_bin: the copy", "recycle_bin", json!({"project_id": "$p"})),
        dr("get: a deleted page", "get", json!({"page_id": "$dup"})),
        dw("restore: the copy", "restore", json!({"page_id": "$dup"})),
        dw("restore: a page that is not in the bin", "restore", json!({"page_id": "$dup"})),
        dr("recycle_bin: empty again", "recycle_bin", json!({"project_id": "$p"})),
        dw("delete: with sub-pages", "delete", json!({"page_id": "$pg1"})),
        dr("recycle_bin: the tree", "recycle_bin", json!({"project_id": "$p"})),
        dw("restore: the tree", "restore", json!({"page_id": "$pg1"})),
        // --- links, search
        dr(
            "check_links: every status",
            "check_links",
            json!({"project_id": "$p", "refs": ["[[Runbook]]", "[[Runbook#Limits and quotas]]", "[[Runbook#nope]]", "[[Ghost]]", "$t1", "DOC-99", "[[Runbook|text]]"]}),
        ),
        dr("check_links: a ticket and a page together", "check_links", json!({"project_id": "$p", "refs": ["$t1"]})),
        dr(
            "check_links: a project that does not exist",
            "check_links",
            json!({"project_id": "nope", "refs": ["[[A]]"]}),
        ),
        dr("search: a word", "search", json!({"project_id": "$p", "query": "tokens"})),
        dr("search: a phrase", "search", json!({"project_id": "$p", "query": "\"more tokens\""})),
        dr("search: an excluded word", "search", json!({"project_id": "$p", "query": "tokens -more"})),
        dr("search: a ticket key", "search", json!({"project_id": "$p", "query": "$t1"})),
        dr("search: tickets only", "search", json!({"project_id": "$p", "query": "limit", "scope": "tickets"})),
        dr("search: every project", "search", json!({"project_id": "$p", "query": "elsewhere", "scope": "all"})),
        dr("search: this project does not see the other", "search", json!({"project_id": "$p", "query": "elsewhere"})),
        dr("search: a limit", "search", json!({"project_id": "$p", "query": "a", "limit": 1})),
        dr("search: a limit of 0", "search", json!({"project_id": "$p", "query": "a", "limit": 0})),
        dr("search: a negative limit", "search", json!({"project_id": "$p", "query": "a", "limit": -1})),
        dr("search: nothing found", "search", json!({"project_id": "$p", "query": "zzzzqqq"})),
        dr("search: only an excluded word", "search", json!({"project_id": "$p", "query": "-tokens"})),
        dr("search: a fuzzy title", "search", json!({"project_id": "$p", "query": "runbok"})),
    ]
}

fn files_and_import(f: &Fixtures) -> Vec<Call> {
    let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
    vec![
        // --- upload
        dw("upload: data", "upload", json!({"data": b64, "name": "flow.png"})),
        dw("upload: data of a name with brackets", "upload", json!({"data": b64, "name": "a[1] b.png"})),
        dw("upload: a text as data", "upload", json!({"data": "aGVsbG8K", "name": "hello.txt"})),
        dw("upload: a type the board does not store", "upload", json!({"data": "aGVsbG8K", "name": "tool.exe"})),
        dw("upload: a name without an extension", "upload", json!({"data": "aGVsbG8K", "name": "README"})),
        dw("upload: a key", "upload", json!({"data": "aGVsbG8K", "name": "id_rsa.pem"})),
        dw("upload: a path", "upload", json!({"path": f.path("pic.png")})),
        dw("upload: a path with a name", "upload", json!({"path": f.path("notes.txt"), "name": "trace.txt"})),
        dw("upload: a path that does not exist", "upload", json!({"path": "/no/such/file.png"})),
        dw("upload: a relative path", "upload", json!({"path": "qa/shot.png"})),
        dw("upload: a key by path", "upload", json!({"path": f.path("secret.pem")})),
        dw("upload: a folder", "upload", json!({"path": f.path("canvas")})),
        dw("upload: onto a page, at the end", "upload", json!({"data": b64, "name": "end.png", "page_id": "$pg2"})),
        dw(
            "upload: onto a page, in a section",
            "upload",
            json!({"data": b64, "name": "sec.png", "page_id": "$pg1", "section": "Overview"}),
        ),
        dw(
            "upload: onto a page, after a passage",
            "upload",
            json!({"data": "aGVsbG8K", "name": "after.txt", "page_id": "$pg1", "find": "Tokens."}),
        ),
        dw(
            "upload: onto a page, before a passage",
            "upload",
            json!({"data": "aGVsbG8K", "name": "before.txt", "page_id": "$pg1", "find": "Tokens.", "mode": "before"}),
        ),
        dw(
            "upload: onto a page that does not exist",
            "upload",
            json!({"data": b64, "name": "x.png", "page_id": "nope"}),
        ),
        dw(
            "upload: onto a section that is not there",
            "upload",
            json!({"data": b64, "name": "x.png", "page_id": "$pg1", "section": "Billing"}),
        ),
        dw(
            "upload: onto a page from an older version",
            "upload",
            json!({"data": b64, "name": "old.png", "page_id": "$pg2", "base_version": 99}),
        ),
        dw(
            "upload: onto a ticket",
            "upload",
            json!({"data": b64, "name": "t.png", "ticket_id": "$t1", "body": "The shot", "author": "Reviewer"}),
        ),
        dw(
            "upload: onto a ticket without a text",
            "upload",
            json!({"data": "aGVsbG8K", "name": "log.txt", "ticket_id": "$t1"}),
        ),
        dw(
            "upload: onto a ticket that does not exist",
            "upload",
            json!({"data": b64, "name": "x.png", "ticket_id": "NOPE-1"}),
        ),
        dw(
            "upload: onto a page and a ticket",
            "upload",
            json!({"data": b64, "name": "both.png", "page_id": "$pg2", "ticket_id": "$t1"}),
        ),
        dr("get: the page with the files", "get", json!({"page_id": "$pg2"})),
        dr("get: the section with a file", "get", json!({"page_id": "$pg1", "section": "Overview"})),
        call("upload: the ticket afterwards", "get_ticket", json!({"ticket_id": "$t1", "view": "comments"})),
        // --- import
        dw("import: a folder", "import", json!({"project_id": "$p", "path": f.path("import")})),
        dw("import: a file", "import", json!({"project_id": "$p", "path": f.path("single.md")})),
        dw("import: a folder without Markdown", "import", json!({"project_id": "$p", "path": f.path("empty")})),
        dw("import: a file that is not Markdown", "import", json!({"project_id": "$p", "path": f.path("notes.txt")})),
        dw("import: drafts", "import", json!({"project_id": "$p", "path": f.path("import"), "publish": false})),
        dw(
            "import: under a page",
            "import",
            json!({"project_id": "$p", "path": f.path("single.md"), "parent_id": "$pg2"}),
        ),
        dw(
            "import: under a page that does not exist",
            "import",
            json!({"project_id": "$p", "path": f.path("single.md"), "parent_id": "nope"}),
        ),
        dw(
            "import: a project that does not exist",
            "import",
            json!({"project_id": "nope", "path": f.path("single.md")}),
        ),
        dr("list: after the imports", "list", json!({"project_id": "$p"})),
        // --- tickets from a page
        dwk(
            "tickets: a page with tasks",
            "create",
            json!({"project_id": "$p", "title": "Plan", "markdown": "## Todo\n\n- [ ] Write the spec\n- [ ] Review the spec\n- [x] Done already\n- Action: Ask the owner\n- [ ] Has a ticket DOC-1\n\n## Notes\n\nNothing here.\n"}),
            "plan",
        ),
        dw("tickets: from the checklist", "tickets", json!({"page_id": "$plan"})),
        dr("tickets: the page afterwards", "get", json!({"page_id": "$plan"})),
        dw("tickets: nothing left", "tickets", json!({"page_id": "$plan"})),
        dw("tickets: from a passage with nothing", "tickets", json!({"page_id": "$plan", "find": "Nothing here"})),
        dwk(
            "tickets: another page",
            "create",
            json!({"project_id": "$p", "title": "Plan two", "markdown": "- [ ] First thing\n- [ ] Second thing\n"}),
            "plan2",
        ),
        dw("tickets: only a passage", "tickets", json!({"page_id": "$plan2", "find": "First thing"})),
        dw(
            "tickets: drafts",
            "tickets",
            json!({"page_id": "$plan2", "items": [{"title": "Second thing"}, {"title": "A new one", "text": "Not on the page", "type": "bug", "status": "todo"}]}),
        ),
        dw("tickets: drafts that are not a list", "tickets", json!({"page_id": "$plan2", "items": "text"})),
        dw(
            "tickets: too many drafts",
            "tickets",
            json!({"page_id": "$plan2", "items": (0..31).map(|i| json!({"title": format!("d{i}")})).collect::<Vec<_>>()}),
        ),
        dw("tickets: a draft without a title", "tickets", json!({"page_id": "$plan2", "items": [{"text": "x"}]})),
        dw(
            "tickets: a draft with a key it does not use",
            "tickets",
            json!({"page_id": "$plan2", "items": [{"title": "x", "color": "red"}]}),
        ),
        dw(
            "tickets: a draft with a status that does not exist",
            "tickets",
            json!({"page_id": "$plan2", "items": [{"title": "x", "status": "someday"}]}),
        ),
        dw(
            "tickets: without marking the page",
            "tickets",
            json!({"page_id": "$pg2", "publish": false, "items": [{"title": "Loose"}]}),
        ),
        call("tickets: the tickets afterwards", "list_tickets", json!({"project_id": "$p"})),
    ]
}

#[tokio::test]
async fn docs_pages_answer_as_python_does() {
    let s = common::start().await;
    let f = Fixtures::new();
    let mut run = Run::new(s.mcp());
    run.run(setup()).await;
    run.run(refused_arguments()).await;
    run.run(pages(&f)).await;
    run_with_files(&mut run, files_and_import(&f)).await;
    let folders = f.folders(&[(s.dir().to_string_lossy().into_owned(), "<dir>")]);
    let got = finish(run, &folders);
    golden("mcp_tool_calls_docs_pages.json", &got);
}
