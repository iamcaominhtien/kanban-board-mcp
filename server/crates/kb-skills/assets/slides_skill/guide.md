# Slides: a deck a person is proud to present

A deck is read on a wall from the back of a room, or flicked through on a phone. It has to make one argument, slide by
slide, and look made for its subject, not filled in from a template. Three kinds of work, three ways:

| The ask | The way |
|---|---|
| A new deck | Design it in HTML with a theme (or your own design), then `scripts/html_to_pptx.py` |
| A deck in the person's own template (they gave a .pptx or .potx) | `scripts/pptx_template.py`: inventory, outline, build |
| Changes to a deck that exists | `pptx_template.py inventory`, then `copy`/`replace` its slides, or python-pptx for a small edit |

Everything is in this skill's folder, `${CLAUDE_SKILL_DIR}` (your working folder is somewhere else: run the scripts by their full path as the commands below show, and never search the disk for them): `scripts/`, `themes/` (each with `sample.html`, `sample.pptx`, `preview.jpg`) and
`examples/`. Install what the scripts need once: `pip install python-pptx playwright pillow` (the browser is the system
Chrome or Edge; else `playwright install chromium`).

## 1. The story before any slide
- Write the titles alone, in order. Read together they must make the whole argument; each is a sentence that states
  the point ("Khách quay lại chiếm 42% doanh thu"), never a label ("Kết quả").
- One idea per slide, its evidence (a number, a chart, a picture, a quote), and little text: at most about 30 words
  besides the title. Detail goes in the speaker notes (`<aside class="notes">`).
- A cover that says the point, and a last slide that says what is asked of the room (a decision, a next step).
- No invented facts or numbers. A fact you do not have is a visible placeholder, and your report lists it.
- A comparison compares like with like: the same period, the same unit and currency (growth in dong beside growth
  in dollars is not a comparison: convert, or use each one's constant-currency figure), the same scope. Say on the
  slide what was converted and how, and put the sources on a slide of their own.
- Vary the slides by what each one says: a big number, a chart, a picture beside text, two options, steps, a quote.
  Ten slides of "title and bullets" is the template look.

## 2. A new deck: design in HTML
Start from the theme that fits the readers (list below), or design your own when none does or the person has a brand:
copy `themes/<key>/sample.html` next to your work, keep its `<style>` (base.css and theme.css are inside it) and write
your slides as `<section class="slide l-...">` with the layouts it shows. Change the theme where the subject asks for
it; never ship a theme's sample words or pictures.

The bar is the themes' samples and `examples/` (Giọt's monthly report, designed for the product rather than from a
theme: a month as 31 drops, a day as a clock, a found photo, a diagram, a recorded animation; `build.py` makes it all
from code): their structure and craft, not their look.

**Type.** A 1280 x 720 slide: titles 40 to 60 px, a cover 64 to 84 px, text at least 18 px, labels and footers at least
13 px. Two families at most, from the fonts below. Size and weight make the hierarchy, not colour and boxes.

**Colour.** A ground, an ink, a muted ink, one accent; a second accent only when it has a meaning of its own. Each
colour means one thing on every slide (the accent is "the point", a red is "the problem"). Contrast at least 4.5:1 for
text.

**Charts.** One message per chart, said by its title. Colour only what makes the point and grey the rest; write the
values on the bars in the reader's format (`1.250`, `3,5`); no gridlines, no value axis to read, no legend when one
series. A chart a person will update is native: `<div data-pptx="chart" data-chart='{...}'>` (see the converter's
docstring); a chart that is a picture is SVG.

**Layout.** The same margins (88 px) and grid on every slide. Leave space empty on purpose. Align to edges, not to the
middle of nothing. No cards with shadows, no icons in pale circles, no numbered circles, no gradient for its own sake,
no stock-photo look.

**A face of its own.** Each deck has one visual idea that only its subject has: a calendar for a month of data, the
product drawn, a route on a map, a material, a motif from the brand. Put it on the cover and let it come back.

Then: `python "${CLAUDE_SKILL_DIR}/scripts/html_to_pptx.py" deck.html -o deck.pptx --previews look/` (text stays editable; pictures, SVG and
CSS art become a picture behind it; `data-pptx="picture"` makes one movable; `<video>` plays). For people who do not
have the theme's web fonts, also write a copy with Office fonts: `--fonts "Fraunces=Georgia,Inter=Calibri"` (each
theme names its pair).

## 3. The person's own template
1. `python "${CLAUDE_SKILL_DIR}/scripts/pptx_template.py" inventory template.pptx > inv.json`, and look at it:
   `python "${CLAUDE_SKILL_DIR}/scripts/render.py" template.pptx --out tpl/` then open `tpl/sheet.png`. Note its fonts, colours, which layout
   or sample slide is for a title, a section, text, two columns, a picture, a chart, a closing, and how it writes
   titles (case, length, where).
2. Write an outline JSON: each slide either from a layout (`fill` its placeholders) or a copy of one of the template's
   own slides (`replace` its shapes by name). Copy a sample slide whenever the template has one for that job: it keeps
   decoration the layouts do not have.
3. `python "${CLAUDE_SKILL_DIR}/scripts/pptx_template.py" build template.pptx outline.json -o deck.pptx`, then
   `python "${CLAUDE_SKILL_DIR}/scripts/render.py" deck.pptx --out look/ --compare template.pptx` and compare each slide with its source.
4. Do as the template does: its fonts, colours, title style, density and picture style. Do not add colours, fonts or
   decoration it does not have; text that does not fit is shortened, not shrunk below the template's sizes. A
   picture on a copied slide that belongs to the template's own subject (a shield on a security deck's cover) is
   swapped for one about yours, or removed: the look stays, the old topic goes. What the template has no slot for (a
   chart, a table) goes in with `add`, in its theme colours by name.
A template that is only a PDF or pictures: rebuild its look in HTML (colours picked from it, the nearest fonts, the same
grid) and say in your report that it is a rebuild.

## 4. Pictures: find them, or make them
A slide with a picture that carries the point beats a slide of text. Every picture must say something about the slide.
- **Find**: search the web (photo libraries such as Unsplash, Pexels, Pixabay, Wikimedia Commons; the brand's press
  kit; screenshots of the product itself). Use a picture only when its licence allows it, and write the source and
  licence in the speaker notes or on a credits slide. No logos or people's photos the deck has no right to.
- **Make**: diagrams, illustrations and icons drawn as SVG, in the deck's colours; HTML and CSS for anything richer;
  a flow as mermaid or draw.io, exported to SVG; icons from an open set (Lucide, Tabler), never clip-art.
- **Motion**: build the animation in HTML (canvas, SVG, CSS) with a `drawAt(ms)` that draws one moment, take a
  screenshot per frame (30 a second), and join them with `ffmpeg -framerate 30 -i %04d.png -c:v libx264 -pix_fmt
  yuv420p out.mp4`: smooth on any machine. Put it on the slide as `<video src="out.mp4" poster="first-frame.png">`
  (it plays in PowerPoint); a short loop can also be a GIF (`<img data-pptx="picture">`). `examples/giot-thang-10/`
  does all of this.
- Render pictures at twice their size on the slide, so they stay sharp on a projector.

## 5. Look at every slide before you hand in
`python "${CLAUDE_SKILL_DIR}/scripts/render.py" deck.pptx --out look/` renders the .pptx itself (LibreOffice, or PowerPoint from a script) and
makes `look/sheet.png`; it prints which way it used and exits 2 when it could not. Open the pictures, never assume:
- text cut off, wrapping where it should not (a title's last word alone, "11/31" on two lines), or overlapping;
- anything off the slide or too close to its edge; a picture stretched or blurred;
- a slide that says nothing, or two that say the same;
- the three slides that look most like a template: fix them, and render again.
Compare the browser's pictures (`--previews`) with the rendered .pptx: where they differ, the .pptx is what people get.

## 6. Hand in
The .pptx (and the Office-font copy when you made one), a PDF for reading (`soffice --headless --convert-to pdf`), and
`look/sheet.png` on the ticket or the Docs page. Say how you looked at it (`render.py`'s way), which theme or template
you used, where each picture came from, and what you could not check.

## Fonts
A .pptx does not carry its fonts: the reader's PowerPoint draws it with fonts they have. A PDF does carry them.
- Office fonts, on every Windows and Mac with Office, all with Vietnamese: Aptos, Calibri, Cambria, Candara, Constantia,
  Corbel, Consolas, Georgia, Arial, Trebuchet MS, Segoe UI (Windows).
- The themes' web fonts (Google Fonts, free to install, with Vietnamese): fine for a PDF, for a deck shown from a
  machine that has them, or when the person installs them; otherwise use the theme's Office pair (`--fonts`).

## Themes
{THEMES}
