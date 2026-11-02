"""What an AI is told about draw.io diagrams and Sketches, and which drawing tool to use (issue #267).

Same pattern as the canvas design guide (``services/canvas_design.py``): one text in one place. Every Claude Code run of
an AI member gets it as a skill of the board's own plugin (``drawio-diagrams``, ``sketches``;
``services/ai/board_skills.py``), and any other MCP agent reads the same text with ``docs_read(diagram_guide)``; a test
checks the two are the same. The short rule for choosing the tool rides in the MCP instructions (``CHOOSING`` is the
long form, at the top of the diagram guide).

The Sketch decision, agreed in the issue: an AI reads Sketches and never draws one. A Sketch is a person's hand drawing
(pen strokes on layers); its worth is that a person drew it while thinking. An AI drawing strokes with code gives a
fake hand-drawn look that nobody can edit by its parts, and what an AI wants to show is better as a Diagram (editable
boxes and arrows) or a Canvas frame (the real screen). So the Sketch guide is about reading one and turning it into
the right drawing, with one exception: a screenshot put on a Sketch for a person to mark on.
"""

DRAWIO_HEADER = r"""---
name: drawio-diagrams
description: Draw and edit draw.io diagrams on the board (flowcharts, user flows, swimlanes, sequences, state machines, architecture, data models, plans) so they are clear, laid out on a grid, in one palette and safe to edit later, then look at the PNG and hand them in. Use when a structure or a process needs a picture, when asked for a diagram, or before changing an existing one; it also says when a Canvas or a Sketch is the better tool.
---

"""

SKETCH_HEADER = r"""---
name: sketches
description: What an AI does with a Sketch (a person's freehand drawing on the board): read it, turn it into a diagram or a canvas frame, never draw one yourself, and put a screenshot on a Sketch only for a person to mark on. Use when a ticket or page shows a sketch, or when you think of drawing one.
---

"""

CHOOSING = r"""## Which tool

| You want to show | Use | Why |
| --- | --- | --- |
| How a screen or page looks: its layout, its states, a click-through | **Canvas** (HTML frames; the `canvas-design` guide) | a real page at real widths, every state side by side |
| Boxes and arrows a team will edit: a user flow's steps and decisions, who does what, a sequence, the states of one thing, the parts of a system, a data model, a plan's dependencies | **draw.io Diagram** in the Docs page or ticket it explains | editable shape by shape, links follow their shapes, one source |
| A person's quick hand drawing, or a mark on a screenshot | **Sketch**, made by a person; you read it (`sketches` guide) | a hand drawing is a person's thinking; yours would be a fake |

- "Draw the sign-up flow and mock up its screens" is two drawings: the flow as a Diagram (steps, decisions, where each
  screen sits), the screens on a Canvas. Link each from the other's page or ticket.
- Draw only when words alone are hard to follow: more than three parts, branches, or an order that matters. A picture
  sits beside the words that explain it, never instead of them; nothing one sentence says needs one.
- A chart of numbers is neither: put it in a Docs page as a table, or as a chart frame on a Canvas.
"""

DRAWIO = (
    r"""# Drawing draw.io diagrams

A diagram on this board is a `.drawio` file (XML) that people open in the draw.io editor and change after you. It is
judged by two things: a newcomer understands it in ten seconds, and a person can move one box without the rest falling
apart. This text is what every AI on the board is given (the `DRAWIO` in `server/services/visual_guides.py`, the
`drawio-diagrams` skill; outside Claude Code, `docs_read(action='diagram_guide')`).

"""
    + CHOOSING
    + r"""
## 1. One question per diagram

Name the question the diagram answers before you draw ("What happens between Sign up and the first login?"), then pick
the kind that answers it:

| Question | Kind | Shape of it |
| --- | --- | --- |
| What are the steps and decisions? | **Flowchart** (a process, a user flow) | one direction, top to bottom or left to right; start and end as pills, steps as boxes, decisions as diamonds |
| Who does which step? | **Swimlane flowchart** | one lane per actor (person, app, server, email), steps in the lane of who does them |
| Who calls whom, in what order? | **Sequence** | lifelines across the top, messages as arrows down the page, in time order |
| What states does one thing go through? | **State machine** | rounded boxes for states, arrows labelled with the event that moves it |
| What are the parts and how do they talk? | **Architecture** (system context, containers) | groups for what is deployed or owned together; arrows labelled with what flows (HTTPS, a queue, a file) |
| What is stored and how is it related? | **Data model** (entity relationship) | one table shape per entity with its key fields; crow's-foot ends for one and many |
| What depends on what? | **Plan / dependency map** | one box per piece of work, arrows for "must come before" |

At most about 25 shapes on a page. More than that is two questions: split into pages (`<diagram>` elements, one per
page) or into an overview and a detail.

## 2. Layout on a grid

- Grid of 10: every `x`, `y`, `width` and `height` is a multiple of 10 (`gridSize="10"` on the `mxGraphModel`).
- **Standard sizes**, so the eye reads rank, not noise: step 160 x 60, decision 120 x 80, start or end 120 x 40,
  data store 120 x 70, note 160 x 60. A label that does not fit makes the box wider in steps of 40, never the text
  smaller.
- **Spacing**: 40 between shapes in a row, 80 between ranks (rows of a top-down flow, columns of a left-right one), 40
  of padding inside a group or lane.
- **The main path is a straight line.** The happy path runs down one axis with its centres aligned; branches leave to
  the side and come back. A loop back (`No` returns to the form) is routed around the outside, never across shapes.
- **Arrows** are orthogonal (`edgeStyle=orthogonalEdgeStyle`), enter and leave at the middle of a side, never cross a
  shape and cross each other as little as you can. Fix a crossing by moving shapes, not by adding bends.
- Leave room: a diagram people will extend needs free space beside its last rank.

## 3. Style from one palette

Define the styles once and reuse them by role; never invent a colour for one box. Take the project's own palette when
its other diagrams or design tokens have one (read them first: `docs_read(diagrams)`); otherwise use these:

| Role | Style |
| --- | --- |
| Step (default) | `rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#475569;fontColor=#0F172A;fontSize=13;` |
| Decision | `rhombus;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#475569;fontColor=#0F172A;fontSize=13;` |
| Start or end | `rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#F1F5F9;strokeColor=#475569;fontColor=#0F172A;fontSize=13;` |
| The focus (what this diagram is about; one or two shapes) | step style with `fillColor=#DBEAFE;strokeColor=#1D4ED8;fontStyle=1;` |
| Error or rejected path | step style with `fillColor=#FEF2F2;strokeColor=#B91C1C;` |
| Outside our system (a person, a third party) | step style with `dashed=1;` |
| Data store | `shape=cylinder3;boundedLbl=1;size=10;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#475569;fontSize=13;` |
| Group or lane | `swimlane;startSize=30;html=1;fillColor=#F8FAFC;strokeColor=#CBD5E1;fontStyle=1;fontSize=13;` (add `horizontal=0;` for a lane on the left) |
| Note | `shape=note;size=14;whiteSpace=wrap;html=1;fillColor=#FEF9C3;strokeColor=#CA8A04;fontSize=12;align=left;spacingLeft=8;` |
| Arrow | `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#475569;fontSize=12;fontColor=#334155;` |

- Colour carries one meaning each (the focus, an error path), and never alone: the label says it too. More than one
  coloured meaning gets a small legend in a corner.
- One font size for shapes (13), one for arrows and notes (12), bold only for the focus and group titles. No shadows,
  gradients or 3D.

## 4. Labels

- **Steps are verb phrases** in sentence case ("Send the confirmation email"), things are nouns ("Email service").
  Under six words; the detail goes in the text beside the diagram.
- **Decisions are questions** ("Email already used?") and every exit is labelled (`Yes` / `No`, or the cases).
- **Label an arrow** when it carries something: data, an event, a condition, a protocol. Not "next", not "then".
- The project's language, the product's words: no ticket keys, field names or abbreviations a newcomer would not
  know.
- A title at the top left (a text cell, 16, bold) when the page will be read on its own.

## 5. Groups, containers and lanes

- A shape inside a group has `parent="<group id>"`, and its `x`, `y` are **relative to the group**. Moving the group
  moves everything in it.
- A lane is a group: one per actor, all the same width (top-down) or height (left-right), side by side with no gap.
- Group only what belongs together (deployed together, owned by one team, one step's sub-steps), never just to draw
  a box around things.

## 6. Writing the file

Plain XML, never compressed, with ids that say what they are (`signup-form`, `email-valid`, `e-form-valid`): a
person and the next AI find them, and links stay readable.

```xml
<mxfile><diagram name="Sign-up"><mxGraphModel gridSize="10" grid="1"><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="landing" value="Open the sign-up page" style="STEP" vertex="1" parent="1">
    <mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>
  <mxCell id="email-valid" value="Email valid?" style="DECISION" vertex="1" parent="1">
    <mxGeometry x="60" y="180" width="120" height="80" as="geometry"/></mxCell>
  <mxCell id="e-landing-valid" style="ARROW" edge="1" parent="1" source="landing" target="email-valid">
    <mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>
```

(`STEP`, `DECISION`, `ARROW` stand for the style strings of section 3.) In a `value`, a line break is `&lt;br&gt;`
and `&`, `<`, `"` are escaped as in any XML attribute. Every link has a `source` and a `target` that are ids of shapes
on the same page.

## 7. Changing an existing diagram

People moved those boxes by hand. A change keeps their work:

1. Read it as a model first: `docs_read(action='diagram', diagram_id)` gives every shape and link with its id, label,
   box and style, and the problems it has. Find the cells you will touch by id.
2. Write the file (`docs_read(diagram, diagram_id, path)`) and change **only those cells**: every other id, position,
   size, style and label stays exactly as it is. Never write the whole file again from scratch to change one thing,
   and never rename an id.
3. A new shape takes the style of its neighbours of the same role and a free spot on the grid next to them. Make room
   by moving whole ranks or lanes by 80 or 40, not by nudging single boxes.
4. Save with `docs_write(diagram_save, diagram_id, path, base_version)` and the `version` you read. A stale version is
   refused: read again, redo your change on the new version, save.
5. A bigger change (a new kind, a new layout) is a redesign: say so, and keep the old one in the history (saving makes
   a new version; nothing is lost).

## 8. Look before you hand it in

`docs_read(action='picture', path='<your .drawio>')` (or `diagram_id` for a saved one) writes a PNG: open it and
check, as a newcomer would:

- the main path reads in one direction, in one glance; nothing overlaps; no arrow crosses a shape;
- every label fits its shape, every decision exit is labelled, the words are the product's;
- the colours mean one thing each, and the focus is what you see first.

The save answer lists `problems` (links to nothing, shapes on top of each other) too. Fix, look again.

## 9. Hand it in

- `docs_write(diagram_create, project_id, title, path)` (or `diagram_save`) and put the returned `markdown` line,
  `[Name](diagram:dg_…)`, **on its own line** in the Docs page or ticket the diagram explains, beside the words it
  illustrates. Give it a one-sentence `summary`.
- In the ticket, a comment with the picture: the `markdown` that `docs_read(picture)` returned
  (`![Sign-up flow](/uploads/…)`), what the diagram shows in one sentence, and the open questions.
- A diagram that goes with a design links both ways: the Canvas embed line on the diagram's page or ticket, and the
  diagram's line where the screens are specified.
"""
)

SKETCH = r"""# Sketches

A Sketch is a freehand drawing a **person** makes on the board: pen strokes on up to 10 layers, often over a
screenshot, stored as a PNG with its layers (`.sketch.json`). It shows in a text as `![Name](sketch:sk_…)`. This text
is what every AI on the board is given (the `SKETCH` in `server/services/visual_guides.py`, the `sketches` skill;
outside Claude Code, `docs_read(action='diagram_guide')`).

## You read Sketches; you do not draw them

A Sketch is worth something because a person drew it while thinking: rough, fast, theirs. Strokes drawn by code give
a fake hand-drawn look that nobody can edit by its parts, and people may take it for a person's idea. Whatever you
want to show is better as a **Diagram** (boxes and arrows anyone can edit) or a **Canvas** frame (the real screen).
So never make a Sketch to draw something, and never save over a person's Sketch.

## Reading one

1. `docs_read(action='sketch', sketch_id, path)` writes its PNG (and its layers): open the PNG and look at it whole.
   `docs_read(action='picture', sketch_id)` gives the PNG alone.
2. Say back what you see in words, in the ticket or page: the parts, their order, what the arrows and marks point at.
   Where a mark could mean two things, ask (one question, your reading first) instead of guessing.
3. Turn it into the right drawing: a screen goes on a Canvas (keep its layout and its words, then design it
   properly), a flow or a structure becomes a draw.io Diagram (keep its parts and their order). Link back to the
   Sketch ("Drawn from ![the sketch](sketch:sk_…)") so the person sees their idea carried over.
4. A comment about the Sketch goes in the ticket or page that shows it; leave the Sketch itself as it is.

## The one exception: a sheet for a person to mark on

When you need a person to point at something on a screen ("where should the filter go?"), put the screenshot on a
Sketch for them: `docs_write(sketch_create, owner_kind, owner_id, title, path='<screenshot.png>')`, the returned line
on its own line in the ticket, and a comment that asks the question. Add no strokes of your own. When they have drawn,
read it as above.
"""


def diagram_guide() -> dict[str, str]:
    """The texts an agent outside Claude Code reads with docs_read(diagram_guide): the same as the two skills."""
    return {"guide": DRAWIO, "sketches": SKETCH}
