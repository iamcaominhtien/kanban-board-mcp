# Sketches

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
