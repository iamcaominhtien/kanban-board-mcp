"""What an AI is told about the look of a frame: a short process and a checklist, in one place.

``BRIEF`` goes into the "Ask AI" job's rules; ``SHORT`` into the MCP instructions an agent gets on connect
(``kanban_mcp/instructions.py``). The longer version for people and for Claude Code is the `canvas-design` skill
(``.claude/skills/canvas-design/SKILL.md``); keep the three in step.
"""

SHORT = (
    "Design a frame, don't just fill it: (1) write realistic copy (names, numbers, dates; never lorem ipsum); "
    "(2) set tokens first, in a shared tokens.css or one :root, and reuse them in every frame: one accent colour, "
    "tinted neutrals, soft success / warning / danger tints, a 4-8-12-16-24-32 spacing scale, 2 or 3 radii, one font "
    "with a type scale (12/14/16/20/28/34) and weights 400/600/700; (3) one primary action per screen, clear "
    "hierarchy by size, weight and colour (not boxes), 16-20 px side margins, 44 px tap targets, phone actions in "
    "the thumb zone; (4) icons are inline SVG, never emoji; (5) draw the states too (selected, disabled, empty, "
    "loading, error); (6) text contrast 4.5:1 and never colour alone for a state; (7) before you send, squint: is the "
    "title and the main action what you see first, is every gap from the scale, does it hold at 390, 820 and 1280?"
)

BRIEF = (
    "Design quality (a frame is a design, not a data dump). Work in this order:\n"
    "1. Brief: who it is for, the one job of the screen, the device. Write realistic copy: real names, numbers, "
    "dates, never lorem ipsum.\n"
    "2. Tokens first: put colours, spacing, radii, type and shadows in :root variables (or one shared tokens.css) and "
    "use only those, so every frame looks like one product. One accent colour; neutrals tinted slightly toward it; "
    "soft tints for success, warning and danger; spacing 4/8/12/16/24/32; radii 8/12/16; one font family, sizes "
    "12/14/16/20/28/34, weights 400/600/700; two shadow levels at most.\n"
    "3. Layout: mobile first on an 8 px grid, 16 to 20 px side margins, group related things by proximity, one "
    "primary action per screen (on a phone in the lower half), tap targets at least 44 px.\n"
    "4. Hierarchy: make the title and the main action the first things seen, using size, weight and colour rather "
    "than borders and boxes; muted colour for meta text; no text under 12 px.\n"
    "5. Details: icons are inline SVG with one stroke width, never emoji; draw every state (default, pressed or "
    "hover, selected, disabled, empty, loading, error); an empty state says what to do next.\n"
    "6. Colour and access: text contrast at least 4.5:1 (3:1 for large text), never colour alone to show a state, "
    "visible focus.\n"
    "7. Avoid: lorem ipsum, more than one accent, decorative gradients, shadows on everything, long centred text, "
    "grey placeholder boxes in place of content.\n"
    "8. Check before you answer: squint (is the title and main action what you see first?), every gap and size "
    "comes from the scale, the page holds at 390, 820 and 1280 px, and what you changed matches what was asked."
)
