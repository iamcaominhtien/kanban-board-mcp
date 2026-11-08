"""Errors of the assistants: a code the UI maps to a state, and a message."""


class AssistError(ValueError):
    """A request to an assistant was refused; `code` says why (the API maps it to a status)."""

    def __init__(self, code: str, message: str, **extra):
        """Keep the code and any extra response fields."""
        super().__init__(message)
        self.code = code
        self.extra = extra


STATUS = {
    "not_found": 404,
    "invalid": 422,
    "invalid_output": 422,
    "too_large": 413,
    "viewer": 403,
    "forbidden": 403,
    "hidden": 403,
    "conflict": 409,
    "feature_off": 409,
    "not_configured": 409,
    "unavailable": 409,
    "over_budget": 409,
    "ai_off": 409,
    "gone": 410,
}
