"""Application-level exceptions.

All HTTP errors raised by route handlers should use AppError so the exception
handler in main.py can embed a typed error_code in the response body.
"""

from fastapi import HTTPException


class AppError(HTTPException):
    """HTTPException with a typed error_code field included in the JSON response."""

    def __init__(self, status_code: int, error_code: str, message: str) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.error_code = error_code
