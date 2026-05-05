import argparse
import sys

import uvicorn

_LOOPBACK_HOSTS = {"127.0.0.1", "::1"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Interior Vision API sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if args.host not in _LOOPBACK_HOSTS:
        print(f"error: --host must be a loopback address, got {args.host!r}", file=sys.stderr)
        sys.exit(1)
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=False, log_config=None)


if __name__ == "__main__":
    main()
