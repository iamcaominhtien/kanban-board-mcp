"""The assistants (AI v2, spec 4.7): Docs AI, the Board AI, Idea AI, the editor's /ai and the Sketch helper are one
kind of Claude Code session, started by the board for a person, with the board's tools and a skill per feature.

`engine.turn` runs one turn; `sessions` keeps one conversation per thing (a page, the board, an idea, a chat);
`skills` ships the feature skills as a plugin; `docs`, `chat`, `ideas` and `editor` are the features on top.
"""

from .errors import AssistError

__all__ = ["AssistError"]
