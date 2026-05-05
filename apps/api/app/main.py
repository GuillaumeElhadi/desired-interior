import importlib.metadata
import os

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.schemas import HealthResponse

app = FastAPI(title="Interior Vision API")

_ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost"]
if os.getenv("DEBUG"):
    _ALLOWED_ORIGINS.append("http://localhost:5173")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _verify_ipc_token(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("IPC_TOKEN")
    if token is None:
        return  # dev mode: IPC_TOKEN not set, auth skipped
    if authorization is None or authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="invalid IPC token")


@app.get("/health", dependencies=[Depends(_verify_ipc_token)])
def health() -> HealthResponse:
    try:
        version = importlib.metadata.version("interior-vision-api")
    except importlib.metadata.PackageNotFoundError:
        version = "0.0.0"
    return HealthResponse(status="ok", version=version)
