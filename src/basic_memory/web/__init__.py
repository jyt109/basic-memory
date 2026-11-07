"""Loopback browser workspace for the local Basic Memory API."""

import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from markdown_it import MarkdownIt
from markdown_it.rules_inline import StateInline
from pydantic import BaseModel

from basic_memory.api.app import app as api_app
from basic_memory.file_utils import ParseError, remove_frontmatter

ASSETS = Path(__file__).parent
PROJECT = r"/v2/projects/[^/]+"
API_ROUTES = {
    "GET": re.compile(rf"/v2/projects/|{PROJECT}/(?:directory/tree|knowledge/entities/[^/]+)"),
    "QUERY": re.compile(rf"{PROJECT}/(?:search/|knowledge/links/resolve)"),
    "POST": re.compile(rf"/v2/projects/|{PROJECT}/(?:index|knowledge/write)"),
    "PUT": re.compile(rf"{PROJECT}/default"),
    "DELETE": re.compile(PROJECT),
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
)
MARKDOWN = MarkdownIt("commonmark", {"html": False}).enable("table")
WIKILINK = re.compile(r"\[\[([^|\[\]\n]+)(?:\|([^\[\]\n]+))?\]\]")


def wikilink(state: StateInline, silent: bool) -> bool:
    match = WIKILINK.match(state.src, state.pos, state.posMax)
    if match is None or state.linkLevel:
        return False

    if not silent:
        target, label = match.groups()
        link = state.push("link_open", "a", 1)
        link.attrSet("href", "#")
        link.attrSet("data-wikilink", target.strip())
        state.push("text", "", 0).content = label or target
        state.push("link_close", "a", -1)
    state.pos = match.end()
    return True


MARKDOWN.inline.ruler.before("link", "wikilink", wikilink)


class PreviewRequest(BaseModel):
    markdown: str


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    async with api_app.router.lifespan_context(api_app):
        yield


def create_web_app(port: int) -> FastAPI:
    host = f"127.0.0.1:{port}"
    origin = f"http://{host}"
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def local_requests(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # Loopback binding alone cannot stop DNS rebinding or cross-site form submissions.
        if request.headers.get("host") != host:
            return Response("Invalid local host", status_code=400)
        request_origin = request.headers.get("origin")
        if (request_origin is not None or request.method not in {"GET", "HEAD"}) and (
            request_origin != origin
        ):
            return Response("Only same-origin requests are allowed", status_code=403)

        path = request.url.path
        workspace_route = (request.method, path) in {
            ("GET", "/"),
            ("GET", "/app.css"),
            ("GET", "/app.js"),
            ("GET", "/favicon.svg"),
            ("POST", "/preview"),
        }
        allowed = API_ROUTES.get(request.method)
        if not workspace_route and (allowed is None or not allowed.fullmatch(path)):
            return Response(status_code=404)

        # The browser may unregister a project. Core defaults to keeping its files.
        if request.method == "DELETE" and request.url.query:
            return Response(status_code=400)

        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(ASSETS / "index.html")

    @app.get("/app.css")
    async def stylesheet() -> FileResponse:
        return FileResponse(ASSETS / "app.css", media_type="text/css")

    @app.get("/app.js")
    async def script() -> FileResponse:
        return FileResponse(ASSETS / "app.js", media_type="text/javascript")

    @app.get("/favicon.svg")
    async def favicon() -> FileResponse:
        return FileResponse(ASSETS / "favicon.svg", media_type="image/svg+xml")

    @app.post("/preview")
    async def preview(data: PreviewRequest) -> HTMLResponse:
        try:
            body = remove_frontmatter(data.markdown, strip=False)
        except ParseError:
            # An unfinished frontmatter block can still be previewed as Markdown.
            body = data.markdown
        return HTMLResponse(MARKDOWN.render(body))

    app.mount("/", api_app, name="local-api")
    return app
