import os

from fastapi import Header, HTTPException


async def verify_ipc_token(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("IPC_TOKEN")
    if token is None:
        return  # dev mode: IPC_TOKEN not set, auth skipped
    if authorization is None or authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="invalid IPC token")
