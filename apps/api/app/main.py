import importlib.metadata

from fastapi import FastAPI

app = FastAPI(title="Interior Vision API")


@app.get("/health")
def health() -> dict[str, str]:
    try:
        version = importlib.metadata.version("interior-vision-api")
    except importlib.metadata.PackageNotFoundError:
        version = "0.0.0"
    return {"status": "ok", "version": version}
