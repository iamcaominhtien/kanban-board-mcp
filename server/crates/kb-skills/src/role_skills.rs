//! One skill per role (issue #273): how a good professional in that role works on this board.
//!
//! A persona holds at most 1000 characters, which is who the role is and what it must never do. The craft does not
//! fit there: how a PM splits a Story, what makes a criterion checkable, how a Dev proves a fix, what a reviewer
//! looks for, how QA leaves evidence. Each role's craft is a skill of the board's own plugin
//! (`services/ai/board_skills.py`) that only a member of that role gets, and its prompt tells it to open the skill
//! first. Agents outside Claude Code read the same text with `docs_read(action='role_guide', query=<role>)`.
//!
//! How every role works a ticket, proves it and asks is in the shared skills (`shared_skills`, issue #277), and how
//! the roles work together in `working-together` there: a role skill does not repeat them. The Designer's skill is
//! the canvas design guide (`canvas-design`). The texts are in `text/roles/`.

use crate::ba_templates;
use crate::shared_skills::header;

/// One role skill: (role, name, description, text).
pub type RoleSkill = (&'static str, &'static str, &'static str, &'static str);

/// The triage role's skill.
pub const TRIAGE: RoleSkill =
    ("triage", "role-triage", include_str!("text/roles/triage.description.txt"), include_str!("text/roles/triage.md"));

/// The pm role's skill.
pub const PM: RoleSkill =
    ("pm", "role-pm", include_str!("text/roles/pm.description.txt"), include_str!("text/roles/pm.md"));

/// The ba role's skill.
pub const BA: RoleSkill =
    ("ba", "role-ba", include_str!("text/roles/ba.description.txt"), include_str!("text/roles/ba.md"));

/// The dev role's skill.
pub const DEV: RoleSkill =
    ("dev", "role-dev", include_str!("text/roles/dev.description.txt"), include_str!("text/roles/dev.md"));

/// The reviewer role's skill.
pub const REVIEWER: RoleSkill = (
    "reviewer",
    "role-reviewer",
    include_str!("text/roles/reviewer.description.txt"),
    include_str!("text/roles/reviewer.md"),
);

/// The qa role's skill.
pub const QA: RoleSkill =
    ("qa", "role-qa", include_str!("text/roles/qa.description.txt"), include_str!("text/roles/qa.md"));

/// The user_tester role's skill.
pub const USER_TESTER: RoleSkill = (
    "user_tester",
    "role-user-tester",
    include_str!("text/roles/user_tester.description.txt"),
    include_str!("text/roles/user_tester.md"),
);

/// The tech_writer role's skill.
pub const TECH_WRITER: RoleSkill = (
    "tech_writer",
    "role-tech-writer",
    include_str!("text/roles/tech_writer.description.txt"),
    include_str!("text/roles/tech_writer.md"),
);

/// The devops role's skill.
pub const DEVOPS: RoleSkill =
    ("devops", "role-devops", include_str!("text/roles/devops.description.txt"), include_str!("text/roles/devops.md"));

/// The security role's skill.
pub const SECURITY: RoleSkill = (
    "security",
    "role-security-reviewer",
    include_str!("text/roles/security.description.txt"),
    include_str!("text/roles/security.md"),
);

/// The data_analyst role's skill.
pub const DATA_ANALYST: RoleSkill = (
    "data_analyst",
    "role-data-analyst",
    include_str!("text/roles/data_analyst.description.txt"),
    include_str!("text/roles/data_analyst.md"),
);

/// `ROLE_SKILLS`: in the order the board lists them.
pub const ROLE_SKILLS: [RoleSkill; 11] =
    [TRIAGE, PM, BA, DEV, REVIEWER, QA, USER_TESTER, TECH_WRITER, DEVOPS, SECURITY, DATA_ANALYST];

/// `SKILL_OF_ROLE`: the skill of each role, in order; the Designer's craft is the canvas design guide
/// (`services/canvas_design.py`).
pub fn skill_of_role() -> Vec<(&'static str, &'static str)> {
    let mut out: Vec<(&'static str, &'static str)> =
        ROLE_SKILLS.iter().map(|(role, name, _d, _b)| (*role, *name)).collect();
    out.push(("designer", "canvas-design"));
    out
}

/// Each role skill's SKILL.md: `{name: text}`.
pub fn skill_files() -> Vec<(String, String)> {
    ROLE_SKILLS.iter().map(|(_r, name, desc, body)| (name.to_string(), header(name, desc) + body)).collect()
}

/// The files a role skill carries beside its SKILL.md: `{skill: {relative path: bytes}}` (the BA's templates).
pub fn extra_files() -> Vec<(String, Vec<(String, &'static [u8])>)> {
    vec![("role-ba".to_string(), ba_templates::files())]
}

/// The role skills' names, in order.
pub fn names() -> Vec<&'static str> {
    ROLE_SKILLS.iter().map(|(_r, name, _d, _b)| *name).collect()
}

/// The role a role skill is for, or None (a shared skill).
pub fn role_of_skill(name: &str) -> Option<&'static str> {
    ROLE_SKILLS.iter().find(|(_r, n, _d, _b)| *n == name).map(|(role, _n, _d, _b)| *role)
}

/// A role's guide without its header, for an agent outside Claude Code (the Designer's is the design guide).
pub fn guide(role: &str) -> Option<&'static str> {
    ROLE_SKILLS.iter().find(|(r, _n, _d, _b)| *r == role).map(|(_r, _n, _d, body)| *body)
}
