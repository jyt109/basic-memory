"""The browser workspace serves only the expected local origin and note endpoints."""

from fastapi.testclient import TestClient

from basic_memory.web import create_web_app

ORIGIN = "http://127.0.0.1:8765"


def test_workspace_serves_local_assets() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    page = client.get("/")
    assert page.status_code == 200
    assert "Local workspace" in page.text
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert page.headers["cache-control"] == "no-store"
    assert client.get("/app.css").headers["content-type"].startswith("text/css")
    assert client.get("/app.js").headers["content-type"].startswith("text/javascript")
    assert client.get("/favicon.svg").headers["content-type"] == "image/svg+xml"


def test_workspace_refuses_foreign_host_origin_and_unrelated_routes() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    assert client.get("/", headers={"Host": "other.example:8765"}).status_code == 400
    assert client.get("/", headers={"Origin": "https://other.example"}).status_code == 403
    path = "/v2/projects/project/knowledge/write"
    assert client.post(path).status_code == 403
    assert client.post(path, headers={"Origin": "https://other.example"}).status_code == 403
    assert client.get("/v2/projects/project/resource/note").status_code == 404
    assert client.get("/docs").status_code == 404


def test_project_routes_require_same_origin_and_cannot_delete_files() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    assert client.post("/v2/projects/").status_code == 403
    assert client.put("/v2/projects/project/default").status_code == 403
    assert client.delete("/v2/projects/project").status_code == 403
    headers = {"Origin": ORIGIN}
    assert (
        client.delete("/v2/projects/project?delete_notes=true", headers=headers).status_code == 400
    )
    assert client.patch("/v2/projects/project", headers=headers).status_code == 404


def test_preview_renders_markdown_and_escapes_active_html() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    response = client.post(
        "/preview",
        json={
            "markdown": "---\ntitle: Plan\n---\n# Plan\n\n<script>bad()</script>\n\n"
            "[bad](javascript:alert(1))\n\n[[Goal|Related goal]] and `[[literal]]`"
        },
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 200
    assert "<h1>Plan</h1>" in response.text
    assert "title: Plan" not in response.text
    assert "&lt;script&gt;" in response.text
    assert 'href="javascript:' not in response.text

    assert 'data-wikilink="Goal">Related goal</a>' in response.text
    assert "<code>[[literal]]</code>" in response.text


def test_preview_keeps_unfinished_frontmatter_visible() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    response = client.post(
        "/preview", json={"markdown": "---\ntitle: Work in progress"}, headers={"Origin": ORIGIN}
    )
    assert response.status_code == 200
    assert "title: Work in progress" in response.text
