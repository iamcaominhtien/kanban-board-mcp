---
name: demo-video
description: Make a polished demo video (MP4, 1080p, about 45 seconds) of the Kanban board or any web app, with an intro banner, Vietnamese narration, captions that never cover the UI, camera zoom and spotlight, a hand cursor, click and typing sounds, lo-fi music and an outro card. Use when asked to record, make or update a demo, walkthrough, tour or showcase video of the app or of a feature.
---

# Demo video

A demo is built with code, not recorded by hand: a throwaway board holds real demo data, a scenario file says what to show
and say, and `scripts/build.py` plays it in a browser, films it, adds the voice and the sounds, and writes one MP4.
The same scenario always gives the same video, so changing a sentence or a step means editing JSON and running it again.

## What you get

- 1920x1080, 30 fps, H.264 + AAC, about 45 s for the shipped scenario.
- Intro banner (logo, title, subtitle, chips), scenes, outro card.
- Narration by a neural voice (Edge TTS, `vi-VN-HoaiMyNeural` by default), set in each scene's `say`; the voice sets the length of the scene.
- Captions in a band under the app (never over it), a progress line, a hand cursor with a press effect, camera zoom, a spotlight that dims
  everything but the target.
- Sound: a stock mouse click on every click, the stock laptop typing while text is typed, a whoosh and a chime on the
  transitions, a soft lo-fi loop that goes down under the voice.

## Steps

1. **Setup, once**: `python3 .claude/skills/demo-video/scripts/setup.py`. It installs numpy, playwright, imageio-ffmpeg and edge-tts
   into `~/.cache/kanban-demo-video` (never into the repo), finds the headless Chromium Playwright has (if there is none:
   `python3 -m playwright install chromium-headless-shell`) and fetches the two stock sounds (Mixkit, free) into `assets/`
   (git-ignored). Edge TTS needs the network and sends only the narration text.
2. **Start a throwaway board**:
   `python3 scripts/start_board.py start --dir <empty folder> --account-folder ~/.kanban-board/ai-accounts/<board account>`
   It starts the board with its own config, database, logs and key file (never the person's real board), creates the project
   KAN with a ticket in every column, an AI team, and lets the team fix a small bug (KAN-7) with Haiku, so the AI activity, the
   Timeline and the comments are real. It prints the board's URL and leaves it running. The run costs a little: use the board's
   own Claude account and ask which one if you do not know. `--no-run` skips the run (the AI scenes then have nothing in them).
3. **Write or adapt the scenario** (below). Start from `scenarios/kanban-tour.json`.
4. **Build**: `python3 scripts/build.py scenarios/<scenario>.json --url <the board's URL> --out <output folder>`.
   About 3 minutes. The video is `<out>/<name>.mp4`.
5. **Look before you hand it over**: cut a contact sheet and read it, one frame every 3 seconds:
   `ffmpeg -i video.mp4 -vf "fps=1/3,scale=640:-1,tile=4x4" -frames:v 1 sheet.png`
   (use the ffmpeg in `~/.cache/kanban-demo-video/pylib/imageio_ffmpeg/binaries/`). Check that each caption matches what is on
   screen, the spotlight sits on its target, and the zoom shows what the voice talks about. You cannot hear the video, so say so.
6. **Stop the board**: `python3 scripts/start_board.py stop --dir <folder>`.
7. **Hand it over**: attach the MP4 to the ticket with `ticket_items(item='attachment', path=<the mp4>)` and link the markdown it returns
   in your report; the board plays a video right in the comment. Never give only a path on your disk.

## The scenario file

```json
{
  "name": "kanban-tour", "voice": "vi-VN-HoaiMyNeural", "tempo": 1.08, "bpm": 76,
  "ready": "text:Fix add() in calc.py",
  "intro": {"title": "...", "subtitle": "...", "chips": ["..."], "say": "..."},
  "scenes": [ {"cap": "caption under the app", "say": "narration", "steps": [ ... ]} ],
  "outro": {"title": "...", "tagline": "...", "say": "...", "caption": "...", "steps": [{"do": "key", "key": "Escape"}]}
}
```

`ready` is a target that must exist before the intro ends. A scene lasts as long as its narration; its steps run in order
and the scene waits for the voice to finish.

**Targets** (what a step acts on, inside the app): `testid:comments`, `text:Fix add()` (contains), `exact:Detailed`,
`re:^\s*assignee\s*$` (regex, any case), `css:[data-testid^="tl-bar-"]`. The first match is used.

**Steps** (`do`):

| do | fields | what it does |
|---|---|---|
| `hover` | `target` | the hand moves there |
| `click` | `target`, `settle` (s, default 1) | moves, clicks (with the click sound), waits |
| `type` | `target` (clicked first), `text`, `delay` (ms) | types with the typing sound |
| `scroll` | `to` (px), `ms` | scrolls the biggest scrolling area (the open ticket) smoothly |
| `cam` | `target`, `scale`, `ms` | zooms to the target; without `target` zooms back out |
| `spot` | `target`, `grow` {left,right,top,bottom}, `pad` | dims everything but the target; without `target` clears it |
| `until` | `frac` | waits until that fraction of the narration has played |
| `wait` | `seconds` | pauses |
| `key` | `key` | presses a key (`Escape` closes a ticket) |

Order matters for zoom and spotlight: **zoom first, then spotlight**, and reset the camera (`cam` with no target) before a click
somewhere else. Keep a sentence of narration to one idea, and keep the caption shorter than the sentence.

## Rules that keep it good

- Show real data from the throwaway board. Never film the person's real board, and never let a process of this skill touch their
  real database (the board of `start_board.py` has its own).
- One idea per scene, 4 to 8 seconds each. Zoom on what the voice names, in the order it names it.
- Captions never cover the app: they live in the band under it, so do not try to put text over the UI.
- If a scene shows an empty area (no run, no comment) the board has no data for it: fix the data, not the scenario.
- Do not invent features. Every scene must show something that works in the board now.
- The sound is stock and the music is made by code; if the person wants other sounds, replace `assets/mk_click.wav` and
  `assets/mk_typing.wav` (mono, 44.1 kHz) and nothing else changes.
