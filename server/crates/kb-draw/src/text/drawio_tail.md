
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
on the same page. A loop back goes around the outside through bends you give it, on the grid, in page coordinates:
`<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="540" y="180"/></Array></mxGeometry>`.

**With Flow.** When the Flow skills are open to you (`flow:flowchart`, `flow:sequence`, `flow:er`, `flow:bpmn` and the
other `flow:*`; the board suggests the plugin, github.com/iamcaominhtien/flow), a diagram of a kind it knows is laid
out by it instead of by hand: write its JSON spec, run its `flow.py build`, read its check and fix the spec until the
errors are gone. It writes a `.drawio` in one design (its own palette and sizes, in place of section 3's) and an
`.html` page whose main path moves. Then go on with section 8 on the `.drawio` and hand it in as section 9 says; the
`.html` may go on the ticket as an attachment. A large or dense diagram goes through `flow:author`. Its ids are
`node-<id>` and `edge-<id>`; a later change follows section 7, or `flow:edit-drawio`.

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
- On the board that line is the picture: it shows the diagram itself, always the latest version. Do not post the
  PNG of `docs_read(picture)` beside it (the same diagram twice); the PNG is for checking (section 8) and for places
  where the line cannot show, such as a pull request. In the ticket's comment, say what the diagram shows in one
  sentence and the open questions.
- A diagram that goes with a design links both ways: the Canvas embed line on the diagram's page or ticket, and the
  diagram's line where the screens are specified.
