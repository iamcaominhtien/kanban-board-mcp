//! The guides the Docs tools return: design, diagram, docs, ticket, the shared guides and one per role.

use serde_json::json;

use super::{Call, Fixtures, dr, finish, golden};
use crate::{Run, common};

fn calls() -> Vec<Call> {
    vec![
        dr("design_guide", "design_guide", json!({})),
        dr("design_guide: a parameter it does not use", "design_guide", json!({"project_id": "x"})),
        dr("diagram_guide", "diagram_guide", json!({})),
        dr("diagram_guide: a parameter it does not use", "diagram_guide", json!({"query": "x"})),
        dr("docs_guide", "docs_guide", json!({})),
        dr("docs_guide: a parameter it does not use", "docs_guide", json!({"page_id": "x"})),
        dr("ticket_guide", "ticket_guide", json!({})),
        dr("ticket_guide: a parameter it does not use", "ticket_guide", json!({"query": "dev"})),
        dr("guides", "guides", json!({})),
        dr("guides: a parameter it does not use", "guides", json!({"query": "dev"})),
        dr("role_guide: the roles", "role_guide", json!({})),
        dr("role_guide: a blank query", "role_guide", json!({"query": "   "})),
        dr("role_guide: dev", "role_guide", json!({"query": "dev"})),
        dr("role_guide: in other case", "role_guide", json!({"query": " QA "})),
        dr("role_guide: a role with a space", "role_guide", json!({"query": "user tester"})),
        dr("role_guide: a role with a dash", "role_guide", json!({"query": "Tech-Writer"})),
        dr("role_guide: ba (it has templates)", "role_guide", json!({"query": "ba"})),
        dr("role_guide: pm", "role_guide", json!({"query": "pm"})),
        dr("role_guide: triage", "role_guide", json!({"query": "triage"})),
        dr("role_guide: reviewer", "role_guide", json!({"query": "reviewer"})),
        dr("role_guide: devops", "role_guide", json!({"query": "devops"})),
        dr("role_guide: security", "role_guide", json!({"query": "security"})),
        dr("role_guide: data analyst", "role_guide", json!({"query": "data_analyst"})),
        dr("role_guide: designer", "role_guide", json!({"query": "designer"})),
        dr("role_guide: a role that does not exist", "role_guide", json!({"query": "wizard"})),
        dr("role_guide: a role with quotes", "role_guide", json!({"query": "it's a 'role'"})),
        dr("role_guide: a parameter it does not use", "role_guide", json!({"query": "dev", "page_id": "x"})),
    ]
}

#[tokio::test]
async fn docs_guides_answer_as_python_does() {
    let s = common::start().await;
    let f = Fixtures::new();
    let mut run = Run::new(s.mcp());
    run.run(calls()).await;
    let folders = f.folders(&[(s.dir().to_string_lossy().into_owned(), "<dir>")]);
    let got = finish(run, &folders);
    golden("mcp_tool_calls_docs_guides.json", &got);
}
