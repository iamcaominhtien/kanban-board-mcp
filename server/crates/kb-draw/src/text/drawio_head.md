# Drawing draw.io diagrams

A diagram on this board is a `.drawio` file (XML) that people open in the draw.io editor and change after you. It is
judged by two things: a newcomer understands it in ten seconds, and a person can move one box without the rest falling
apart. This text is what every AI on the board is given (the `DRAWIO` in `server/services/visual_guides.py`, the
`drawio-diagrams` skill; outside Claude Code, `docs_read(action='diagram_guide')`).

