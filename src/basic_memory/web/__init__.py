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
from basic_memory.markdown.entity_parser import parse
from basic_memory.runtime.note_content_responses import NOTE_CONTENT_BASE_CHECKSUM_HEADER

ASSETS = Path(__file__).parent
PROJECT = r"/v2/projects/[^/]+"
NOTE = rf"{PROJECT}/knowledge/entities/[^/]+"
API_ROUTES = {
    "GET": re.compile(rf"/v2/projects/|{PROJECT}/directory/tree|{NOTE}"),
    "QUERY": re.compile(rf"{PROJECT}/(?:search/|knowledge/links/resolve)"),
    "POST": re.compile(rf"/v2/projects/|{PROJECT}/(?:index|knowledge/write)"),
    "PUT": re.compile(rf"{PROJECT}/default"),
    "DELETE": re.compile(rf"{PROJECT}|{NOTE}"),
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


class EditorCheckRequest(BaseModel):
    original: str
    frontmatter: str = ""
    roundtrip: str


class EditorCheckResponse(BaseModel):
    editable: bool


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
            ("GET", "/editor.bundle.js"),
            ("POST", "/editor-check"),
            ("GET", "/favicon.svg"),
            ("POST", "/preview"),
        }
        allowed = API_ROUTES.get(request.method)
        if not workspace_route and (allowed is None or not allowed.fullmatch(path)):
            return Response(status_code=404)

        if request.method == "DELETE":
            # Unregistering a project must keep its files. A note delete must pin a revision.
            if request.url.query:
                return Response(status_code=400)
            if (
                re.fullmatch(NOTE, path)
                and not request.headers.get(NOTE_CONTENT_BASE_CHECKSUM_HEADER, "").strip()
            ):
                return Response(status_code=428)

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

    @app.get("/editor.bundle.js")
    async def editor_bundle() -> Response:
        path = ASSETS / "editor.bundle.js"
        if path.is_file():
            return FileResponse(path, media_type="text/javascript")
        return Response(media_type="text/javascript")

    @app.post("/editor-check")
    async def editor_check(data: EditorCheckRequest) -> EditorCheckResponse:
        try:
            body = remove_frontmatter(data.original, strip=False)
        except ParseError:
            return EditorCheckResponse(editable=False)
        if data.frontmatter + body != data.original or MARKDOWN.render(body) != MARKDOWN.render(
            data.roundtrip
        ):
            return EditorCheckResponse(editable=False)
        original = parse(body)
        roundtrip = parse(data.roundtrip)
        return EditorCheckResponse(
            editable=(
                original.observations == roundtrip.observations
                and original.relations == roundtrip.relations
            )
        )

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
