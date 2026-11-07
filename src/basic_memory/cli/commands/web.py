"""Launch the local browser workspace."""

import os
from typing import Annotated

import typer

from basic_memory.cli.app import app


@app.command()
def web(port: Annotated[int, typer.Option(min=1024, max=65535)] = 8765) -> None:
    """Serve the note workspace on this computer."""
    import uvicorn

    from basic_memory.web import create_web_app

    os.environ["BASIC_MEMORY_CLOUD_MODE"] = "false"
    typer.echo(f"Basic Memory workspace: http://127.0.0.1:{port}")
    uvicorn.run(create_web_app(port), host="127.0.0.1", port=port, proxy_headers=False)
