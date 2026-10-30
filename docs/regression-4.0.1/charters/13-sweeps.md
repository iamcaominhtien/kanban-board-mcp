# C13 · Cross-cutting sweeps

**Bug file:** `bugs/13-sweeps.md` · **Bug ids:** `C13-001`, `C13-002`, …

**Persona:** A tester who looks at the whole app at once, one aspect at a time.

**Goal:** These aspects cut across every area. Do one pass per aspect over every screen in the app (the list of screens is the list of charters 01 to 11).

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `README.md (Features)`
- `design/screens/*.md`
- `design/components/*.md`

## Setup

A project with plenty of data (about 300 tickets, 40 doc pages, 40 ideas) and a second small one.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] **Theme:** light and dark; contrast; hard-coded colours; images with a white background; focus rings in both.
- [ ] **Width:** about 1920, 1440, 1024, 768 and 390 px; browser zoom 80% to 200%; nothing clipped, overlapped or cut off; no horizontal page scroll that is not wanted; dialogs taller than the window.
- [ ] **Keyboard only:** Tab order, visible focus, Enter and Space, Esc closes the top layer only, arrow keys in menus, no trap in an editor or dialog, the shortcut list.
- [ ] **Screen reader basics:** names on icon buttons, labels on fields, headings, dialogs announce.
- [ ] **Empty, loading, error:** every list and every panel with no data; slow network (throttle); server stopped in the middle of an action; a 500 from an endpoint.
- [ ] **Odd text:** Vietnamese with diacritics, emoji, right-to-left text, a 300 character title with no spaces, HTML and markdown in titles, leading and trailing spaces, very long words.
- [ ] **Scale:** the 300 ticket project in each view; scrolling, dragging, search and typing stay smooth.
- [ ] **Two tabs and refresh:** the same data in two tabs; reload in the middle of every kind of edit; browser Back and Forward; deep links.
- [ ] **Console and network:** open each screen once with DevTools; list errors, warnings and failed requests.
- [ ] **Consistency:** the same thing is named, coloured, shaped and placed the same everywhere (status names and colours, priority icons, date formats, button wording, confirmation wording, toasts).

## Ask yourself

- Which screen looks like it was made by somebody else?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
