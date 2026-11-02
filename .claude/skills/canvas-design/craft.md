# Craft: from machine-made to designed

The design guide (`SKILL.md`) gives the process. This page is about the look: why a screen reads as made by an AI, and
what a designer does instead. Read it before your first frame, and again when you judge your screenshots.

## Why it looks machine-made

A model reaches for the average of every app it has seen: a light tinted ground, white rounded cards, one blue, pills,
icons in circles, a row of buttons, four tab icons. Each choice is reasonable; together they are a template, and a
viewer recognises the template before reading a word. Beauty comes from decisions the average would not make, taken
for reasons that belong to this product.

## The tells, and what to do instead

| Tell | Instead |
| --- | --- |
| Every block is a white rounded card on a tinted ground | Let most content sit on the ground, grouped by space and alignment. Use a container only for a real separate object (a sheet, a dialog, a draggable item). One surface change on a screen is often enough. |
| An icon in a pale tinted circle at the start of every row | Drop the icon when the word says it, or use the icon alone at text size, in the text colour. Repetition is not structure. |
| An alert as a tinted box with an icon, a bold title and a paragraph | Put the state where it happens: the number turns amber, the bar shows the gap, the row shows "not saved · Retry". A banner only for a state that concerns the whole screen, written as one line. |
| A pill with an icon on every status | One state word, set in type (weight, colour, small caps) beside the thing. A pill only where it is a control or a filter. |
| A row of equal buttons above four tab icons | One main action that looks like the main action (size, place, colour). Secondary actions are smaller or quieter, not the same box in another colour. |
| A progress bar plus a percentage plus a sentence saying the same | Pick the one form that is the product's signature and make it big; drop the repeats. |
| One brand blue on a near-white ground | Let a colour own the screen (a dark ground, a strong fill, the signature in colour) or commit to ink on paper with one sharp accent. |
| Inter, Roboto or the system face everywhere, weights 400 to 600, sizes 14 to 24 | A display face with character for titles and numbers, a plain body face, and real contrast in scale: the hero number three to five times the body size, tight tracking at large sizes. |
| Everything centred, everything the same width | A left edge everyone aligns to, one element that breaks it on purpose, a rhythm of big and small. |
| Generous empty space at the bottom of every phone screen | Size the composition to the content, or give the space to the signature. Empty space is a decision, not leftover. |
| Gradient wash, glassmorphism, drop shadow on every card, emoji, a left accent border | Leave them out. Depth, if the tone wants it, comes from one shadow or one layered element. |

## Character, piece by piece

**Type.** Pair a display face with a plain body face. Choose for the product's voice and its language: Vietnamese needs a
family with the Vietnamese subset (for example Be Vietnam Pro, Bricolage Grotesque, Big Shoulders Display, Fraunces,
Lexend, Baloo 2, Space Grotesk, Archivo, Plus Jakarta Sans, Montserrat, JetBrains Mono, Roboto Mono). Numbers are the
heroes of most apps: give them the display face, tabular figures and size. Small uppercase labels with letter-spacing
are one tool, not the default for every heading.

**Colour.** Build the palette in `oklch()`. Neutrals lean toward the main hue (chroma 0.005 to 0.02). Decide what owns the
screen: a ground, a fill, the signature. Accents share the main colour's chroma and lightness and change the hue.
Colours that must be told apart differ in lightness. Use state colours on the thing they describe, never as five tinted
boxes.

**Composition.** Decide what the eye meets first, second and third, and make the sizes say so: one element clearly the
largest. Align to a few edges. Let the signature take room: bleed to the edge, overlap a boundary, fill the screen if
that is the point. Density is good when it is ordered; an app people check ten times a day wants the answer at once.

**The signature.** Ask what this product is about in the physical world (water fills a glass; a day has hours; a
reminder is a tap on the shoulder) and draw that, simply, as the main screen's structure. It must survive at thumbnail
size and in every state: empty, on track, behind, done, offline, error.

**Details.** One icon set, one stroke width, sized to the text beside it. Optical alignment of icons and numbers. Real
copy with the product's voice; a state says what happened and what to do. Pressed and focus states drawn.

## Explore, then build

1. Draw the main screen three ways that differ on a named axis (the signature, light or dark, density, type), full
   fidelity, the same real data, on a "Directions" page.
2. Screenshot each at 390 px and look at it at thumbnail size beside the others.
3. Score each against the tells above; check that the signature reads small and in two states (on track, behind).
4. With a person to answer, show them and let them choose. Otherwise keep the strongest, say in one line why, and leave
   the others on the Directions page.
5. Build foundations, components and the screens from the chosen direction only.

## The critique pass

After the screens are built, take screenshots and, for each main screen, write down (for yourself) the three things
that most look like a template. Fix those three, screenshot again, and repeat once. Stop when what remains is a choice
you would defend, not a default you inherited.
