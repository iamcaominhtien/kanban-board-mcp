//! The plan: which pages, under which parents, with which titles (`services/docs_import.py` lines 126-387).

use std::collections::{HashMap, HashSet};

use kb_db::Session;
use kb_db::entities::docs_page;
use kb_doctext::docs_text::{Reference, parse_references};
use serde_json::{Map, Value, json};

use super::{Entry, MAX_FILES, parse_file};
use crate::docs::{MAX_TITLE, all_pages, get_page, project};
use crate::util::casefold;
use crate::{Result, docs_err};

/// A page to create: a folder placeholder or a file, with its parent.
#[derive(Debug, Clone)]
pub struct Node {
    /// The folder path, or the folder path and the file name.
    pub key: Vec<String>,
    /// The page title.
    pub title: String,
    /// The page text.
    pub body: String,
    /// The folder it sits in (`None` at the top).
    pub parent_key: Option<Vec<String>>,
    /// The file (an index of a folder, or the file of a page) as an index into the entries.
    pub entry: Option<usize>,
    /// A folder that already exists is reused.
    pub existing_id: Option<String>,
    /// The page made for it.
    pub page_id: Option<String>,
}

/// `_unique`: `Title (copy)`, `Title (copy 2)`... the first that is not taken (casefolded).
fn unique(title: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(&casefold(title)) {
        return title.to_string();
    }
    let mut n = 1;
    loop {
        let cand = if n == 1 { format!("{title} (copy)") } else { format!("{title} (copy {n})") };
        if !taken.contains(&casefold(&cand)) {
            return cand;
        }
        n += 1;
    }
}

/// `existing` pages by parent and casefolded title (a later page of the same title replaces the earlier).
type Children = HashMap<Option<String>, HashMap<String, docs_page::Model>>;

/// The nodes of a plan, and which key points at which (a later node with the same key replaces the earlier one in
/// the dictionary of Python; the arena keeps both, as Python's list does).
struct Nodes {
    arena: Vec<Node>,
    by_key: HashMap<Vec<String>, usize>,
}

impl Nodes {
    fn get(&self, key: &Option<Vec<String>>) -> Option<usize> {
        key.as_ref().and_then(|k| self.by_key.get(k).copied())
    }
}

/// What `build_plan` gives: the entries, the nodes in creation order (indices into `arena`), the arena and the
/// summary.
pub struct Plan {
    /// One per uploaded file.
    pub entries: Vec<Entry>,
    /// The nodes, folders first.
    pub arena: Vec<Node>,
    /// The order in which pages are created: indices into `arena`.
    pub ordered: Vec<usize>,
    /// The counts of the plan.
    pub summary: Map<String, Value>,
}

/// Validate the files and plan the pages to create, folders included.
///
/// `files` are `(path, bytes)` pairs; `parent_id` the page to import under (None for the top level); `on_conflict`
/// `copy` (create a duplicate) or `skip` when a page with the same title exists. Fails with 422 for a bad
/// `on_conflict`, no files, too many files or a parent in another project.
pub async fn build_plan(
    session: &Session,
    project_id: &str,
    files: &[(String, Vec<u8>)],
    parent_id: Option<&str>,
    on_conflict: &str,
) -> Result<Plan> {
    if on_conflict != "copy" && on_conflict != "skip" {
        return docs_err(422, "bad_conflict", "on_conflict must be copy or skip");
    }
    project(session, project_id, false).await?;
    if files.is_empty() {
        return docs_err(422, "no_files", "Choose at least one Markdown file");
    }
    if files.len() > MAX_FILES {
        return docs_err(422, "too_many_files", format!("At most {MAX_FILES} files can be imported at once"));
    }
    if let Some(parent_id) = parent_id {
        let parent = get_page(session, parent_id, false, false).await?;
        if parent.project_id != project_id {
            return docs_err(422, "bad_parent", "Parent belongs to another project");
        }
    }

    let mut entries: Vec<Entry> = Vec::new();
    for (i, (path, data)) in files.iter().enumerate() {
        entries.push(parse_file(i, path, data)?);
    }
    let good: Vec<usize> = (0..entries.len()).filter(|&i| entries[i].error.is_none()).collect();

    // titles already used under each existing parent (None = top level)
    let existing = all_pages(session, project_id, false).await?;
    let mut children: Children = HashMap::new();
    for p in &existing {
        children.entry(p.parent_id.clone()).or_default().insert(casefold(&p.title), p.clone());
    }

    // an index.md / README.md becomes its folder's body (index.md wins over README.md)
    let mut folder_index: HashMap<Vec<String>, usize> = HashMap::new();
    let mut by_index = good.clone();
    by_index.sort_by(|&a, &b| {
        let key = |i: usize| {
            let e = &entries[i];
            (e.segments.last().is_some_and(|s| s.to_lowercase().starts_with("readme")), e.path.clone())
        };
        key(a).cmp(&key(b))
    });
    for &i in &by_index {
        if entries[i].is_index {
            let folder = entries[i].segments[..entries[i].segments.len() - 1].to_vec();
            folder_index.entry(folder).or_insert(i);
        }
    }

    let mut nodes = Nodes { arena: Vec::new(), by_key: HashMap::new() };
    let mut order: Vec<Vec<String>> = Vec::new();

    for &i in &good {
        let segs = &entries[i].segments;
        let folders = &segs[..segs.len() - 1];
        for depth in 1..=folders.len() {
            let key: Vec<String> = folders[..depth].to_vec();
            if nodes.by_key.contains_key(&key) {
                continue;
            }
            let idx = folder_index.get(&key).copied();
            let title = match idx {
                Some(ix)
                    if entries[ix].explicit_title && entries[ix].title.as_deref().is_some_and(|t| !t.is_empty()) =>
                {
                    entries[ix].title.clone().unwrap_or_default()
                }
                _ => key[key.len() - 1].clone(),
            };
            let parent_key = if key.len() > 1 { Some(key[..key.len() - 1].to_vec()) } else { None };
            nodes.arena.push(Node {
                key: key.clone(),
                title: title.chars().take(MAX_TITLE).collect(),
                body: idx.map(|ix| entries[ix].body.clone()).unwrap_or_default(),
                parent_key,
                entry: idx,
                existing_id: None,
                page_id: None,
            });
            nodes.by_key.insert(key.clone(), nodes.arena.len() - 1);
            order.push(key);
        }
    }

    // resolve folders against existing pages (reuse) and decide each node's real parent id
    let children_of = |nodes: &Nodes, parent: Option<usize>| -> HashMap<String, docs_page::Model> {
        let pid: Option<String> = match parent {
            None => parent_id.map(str::to_string),
            Some(p) => match &nodes.arena[p].existing_id {
                Some(id) => Some(id.clone()),
                None => return HashMap::new(),
            },
        };
        children.get(&pid).cloned().unwrap_or_default()
    };

    let mut taken_new: HashMap<Option<Vec<String>>, HashSet<String>> = HashMap::new();
    for key in &order {
        let ni = nodes.by_key[key];
        let parent = nodes.get(&nodes.arena[ni].parent_key);
        let hit = children_of(&nodes, parent).get(&casefold(&nodes.arena[ni].title)).map(|p| p.id.clone());
        if let Some(id) = hit {
            let node = &mut nodes.arena[ni];
            node.existing_id = Some(id);
            if let Some(ix) = node.entry.take() {
                // the folder already exists: its index file becomes a normal child page
                entries[ix].is_index = false;
                node.body = String::new();
            }
        }
        let node = &nodes.arena[ni];
        taken_new.entry(node.parent_key.clone()).or_default().insert(casefold(&node.title));
    }

    let mut file_nodes: Vec<usize> = Vec::new();
    let mut by_name = good.clone();
    by_name.sort_by_cached_key(|&i| entries[i].segments.iter().map(|s| casefold(s)).collect::<Vec<_>>());
    for i in by_name {
        let segs = entries[i].segments.clone();
        let folder_key: Vec<String> = segs[..segs.len() - 1].to_vec();
        if entries[i].is_index && folder_index.get(&folder_key) == Some(&i) {
            if let Some(&ni) = nodes.by_key.get(&folder_key) {
                if nodes.arena[ni].entry == Some(i) {
                    entries[i].page_path = Some(titles_of(&nodes, ni));
                    continue;
                }
            }
        }
        let folder_opt: Option<Vec<String>> = if folder_key.is_empty() { None } else { Some(folder_key.clone()) };
        let parent = nodes.get(&folder_opt);
        let mut taken: HashSet<String> = children_of(&nodes, parent).keys().cloned().collect();
        taken.extend(taken_new.entry(folder_opt.clone()).or_default().iter().cloned());
        let mut title = entries[i].title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".to_string());
        if taken.contains(&casefold(&title)) {
            if on_conflict == "skip" {
                entries[i].skipped = true;
                entries[i].messages.push(format!("Skipped: a page titled '{title}' already exists"));
                continue;
            }
            let new_title = unique(&title, &taken);
            entries[i].messages.push(format!("A page titled '{title}' already exists: imported as '{new_title}'"));
            title = new_title;
        }
        taken_new.entry(folder_opt.clone()).or_default().insert(casefold(&title));
        nodes.arena.push(Node {
            key: segs.clone(),
            title,
            body: entries[i].body.clone(),
            parent_key: folder_opt,
            entry: Some(i),
            existing_id: None,
            page_id: None,
        });
        let ni = nodes.arena.len() - 1;
        nodes.by_key.insert(segs, ni);
        file_nodes.push(ni);
        entries[i].page_path = Some(titles_of(&nodes, ni));
    }

    let mut folder_order = order.clone();
    folder_order.sort_by_key(Vec::len);
    let mut ordered: Vec<usize> = folder_order.iter().map(|k| nodes.by_key[k]).collect();
    ordered.extend(file_nodes);

    // links: resolved when a page with that title exists or is created by this import
    let mut known: HashSet<String> = existing.iter().map(|p| casefold(&p.title)).collect();
    known.extend(
        ordered.iter().filter(|&&n| nodes.arena[n].existing_id.is_none()).map(|&n| casefold(&nodes.arena[n].title)),
    );
    for &i in &good {
        if entries[i].skipped {
            continue;
        }
        let mut unresolved: Vec<String> = Vec::new();
        let mut resolved = 0;
        for r in parse_references(&entries[i].body) {
            let Reference::Page(r) = r else { continue };
            let target = casefold(r.title.rsplit('/').next().unwrap_or("").trim_matches(kb_base::pytext::is_space));
            if known.contains(&target) {
                resolved += 1;
            } else if !unresolved.contains(&r.title) {
                unresolved.push(r.title.clone());
            }
        }
        entries[i].resolved = resolved;
        if !unresolved.is_empty() {
            let n = unresolved.len();
            entries[i].messages.push(format!("{n} link{} not found yet", if n != 1 { "s" } else { "" }));
        }
        entries[i].unresolved = unresolved;
    }
    // folder pages created from an index file carry their links to the file entry too
    let count = |f: &dyn Fn(&Entry) -> bool| entries.iter().filter(|e| f(e)).count();
    let mut summary = Map::new();
    summary.insert("pages".into(), json!(ordered.iter().filter(|&&n| nodes.arena[n].existing_id.is_none()).count()));
    summary.insert("links_resolved".into(), json!(good.iter().map(|&i| entries[i].resolved).sum::<usize>()));
    summary.insert(
        "links_unresolved_total".into(),
        json!(good.iter().map(|&i| entries[i].unresolved.len()).sum::<usize>()),
    );
    summary.insert("skipped".into(), json!(count(&|e| e.skipped)));
    summary.insert("errors".into(), json!(count(&|e| e.error.is_some())));
    summary.insert(
        "bytes".into(),
        json!(entries.iter().filter(|e| e.error.is_none() && !e.skipped).map(|e| e.size).sum::<usize>()),
    );
    Ok(Plan { entries, arena: nodes.arena, ordered, summary })
}

/// `_titles_of`: the titles from the top folder to the node.
fn titles_of(nodes: &Nodes, node: usize) -> Vec<String> {
    let mut titles = vec![nodes.arena[node].title.clone()];
    let mut cur = node;
    while let Some(parent) = nodes.arena[cur].parent_key.as_ref().and_then(|k| nodes.by_key.get(k)).copied() {
        cur = parent;
        titles.insert(0, nodes.arena[cur].title.clone());
    }
    titles
}

/// `_file_report`.
pub fn file_report(e: &Entry) -> Value {
    if let Some(error) = &e.error {
        return json!({
            "path": e.path,
            "page_path": null,
            "title": null,
            "status": "error",
            "links_resolved": 0,
            "links_unresolved": [],
            "message": error,
        });
    }
    let message = e.messages.join("; ");
    json!({
        "path": e.path,
        "page_path": if e.skipped { Value::Null } else { json!(e.page_path) },
        "title": if e.skipped {
            Value::Null
        } else {
            match e.page_path.as_ref().and_then(|p| p.last()) {
                Some(t) => json!(t),
                None => json!(e.title),
            }
        },
        "status": if e.messages.is_empty() { "ok" } else { "warning" },
        "links_resolved": e.resolved,
        "links_unresolved": e.unresolved,
        "message": if message.is_empty() { Value::Null } else { json!(message) },
    })
}

/// Report what an import would create without writing anything: the per-file report plus the summary counts.
pub async fn dry_run(
    session: &Session,
    project_id: &str,
    files: &[(String, Vec<u8>)],
    parent_id: Option<&str>,
    on_conflict: &str,
) -> Result<Map<String, Value>> {
    let plan = build_plan(session, project_id, files, parent_id, on_conflict).await?;
    let mut out = Map::new();
    out.insert("files".into(), Value::Array(plan.entries.iter().map(file_report).collect()));
    out.extend(plan.summary);
    Ok(out)
}
