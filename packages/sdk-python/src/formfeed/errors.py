from __future__ import annotations

from typing import Any


class FormfeedError(Exception):
    """An API problem (RFC 9457) or a transport failure.

    ``code`` is the problem code (``quota_exceeded``, ``template_not_found`` …) or ``network_error`` /
    ``timeout`` / ``not_ready`` for client-side failures; ``status`` is the HTTP status, 0 when none.
    """

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 0,
        problem: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.problem = problem
        self.request_id = request_id

    def __str__(self) -> str:  # pragma: no cover - formatting
        suffix = f" (request {self.request_id})" if self.request_id else ""
        return f"{self.code}: {self.message}{suffix}"
