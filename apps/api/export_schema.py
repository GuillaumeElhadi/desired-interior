"""Export the FastAPI OpenAPI schema as JSON to stdout.

Usage (from apps/api/):
    uv run python export_schema.py
"""

import json

from app.main import app

print(json.dumps(app.openapi(), indent=2))
