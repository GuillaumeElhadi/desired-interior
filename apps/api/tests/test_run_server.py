from unittest.mock import MagicMock, patch

import pytest

from app.main import app as fastapi_app


def test_main_default_args(monkeypatch):
    monkeypatch.setattr("sys.argv", ["prog"])
    mock_run = MagicMock()
    with patch("uvicorn.run", mock_run):
        from run_server import main

        main()
    mock_run.assert_called_once_with(
        fastapi_app, host="127.0.0.1", port=8000, reload=False, log_config=None
    )


def test_main_custom_port(monkeypatch):
    monkeypatch.setattr("sys.argv", ["prog", "--port", "9876"])
    mock_run = MagicMock()
    with patch("uvicorn.run", mock_run):
        from run_server import main

        main()
    mock_run.assert_called_once_with(
        fastapi_app, host="127.0.0.1", port=9876, reload=False, log_config=None
    )


def test_invalid_host_is_rejected(monkeypatch):
    monkeypatch.setattr("sys.argv", ["prog", "--host", "0.0.0.0"])
    with pytest.raises(SystemExit):
        from run_server import main

        main()
