"""The error a Docs AI request ends with; `code` tells the UI which state to show."""

# code -> HTTP status
STATUS = {
    "not_found": 404,
    "invalid": 422,
    "forbidden": 403,
    "viewer": 403,
    "hidden": 403,
    "conflict": 409,
    "docs_ai_off": 409,
    "feature_off": 409,
    "no_member": 409,
    "unavailable": 409,
    "paused": 409,
    "rate_limited": 429,
    "over_budget": 409,
    "too_long": 409,
    "stale": 409,
    "not_covered": 409,
}


class DocsAiError(Exception):
    """A Docs AI request that cannot be taken; `code` maps to an HTTP status and to a state in the UI."""

    def __init__(self, code: str, message: str, **extra):
        """Keep the code and any extra response fields."""
        super().__init__(message)
        self.code = code
        self.extra = extra

    @property
    def status(self) -> int:
        """The HTTP status of this error."""
        return STATUS.get(self.code, 400)
