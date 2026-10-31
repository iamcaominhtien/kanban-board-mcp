"""Every AI that writes for people is told how to link: tickets by key, Docs pages as [[Title]]."""

from models import AiAssistSettings, AiMember, AiProjectSettings
from services.ai.assist import prompts
from services.ai.context import LINK_RULE, RunContext, rules_block


def test_the_rule_names_both_kinds_of_link():
    assert (
        "YU-12" in LINK_RULE
        and "[[Page title]]" in LINK_RULE
        and "[[Page title#Section]]" in LINK_RULE
    )


def test_the_board_ai_chat_editor_and_docs_ai_share_one_system_prompt_with_the_rule():
    # chat, ticket drafts, the editor helper, the Idea AI and the Docs AI all start from prompts.system
    assert LINK_RULE in prompts.system("PM", "Project", AiAssistSettings())
    assert LINK_RULE in prompts.system(
        "PM", "Project", AiAssistSettings(), "extra rules", tools=True
    )


def test_a_run_of_an_ai_member_gets_the_rule_in_its_rules_block():
    ctx = RunContext("run_1", "m1", "PM", "p1", "KAN-1", "An Nguyen", "work")
    for mode in ("work", "ask"):
        ctx.mode = mode
        block = rules_block(
            ctx,
            AiMember(),
            AiProjectSettings(),
            project_name="Project",
            ticket_status="todo",
        )
        assert LINK_RULE in block
