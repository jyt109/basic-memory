"""The browser workspace serves only the expected local origin and note endpoints."""

from pathlib import Path

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

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


def test_note_delete_requires_same_origin_and_a_revision() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    path = "/v2/projects/project/knowledge/entities/note"
    assert client.delete(path).status_code == 403
    assert client.delete(path, headers={"Origin": ORIGIN}).status_code == 428


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


def test_formatted_editor_preserves_frontmatter_and_note_semantics() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    headers = {"Origin": ORIGIN}
    prefix = "---\ntitle: Example\n---\n"
    body = "# Heading\n\n**Emphasis**\n\n- [fact] An observation\n- links_to [[Target]]\n"
    response = client.post(
        "/editor-check",
        json={
            "original": prefix + body,
            "frontmatter": prefix,
            "roundtrip": body.replace("**", "__"),
        },
        headers=headers,
    )
    assert response.json() == {"editable": True}

    for roundtrip in (body.replace("[fact]", r"\[fact\]"), "# Heading"):
        response = client.post(
            "/editor-check",
            json={"original": prefix + body, "frontmatter": prefix, "roundtrip": roundtrip},
            headers=headers,
        )
        assert response.json() == {"editable": False}

    response = client.post(
        "/editor-check",
        json={
            "original": "---\nHeading\n---\nBody",
            "frontmatter": "---\nHeading\n---\n",
            "roundtrip": "Body",
        },
        headers=headers,
    )
    assert response.json() == {"editable": False}


def test_project_display_labels_persist_without_touching_project_config(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> None:
    monkeypatch.setenv("BASIC_MEMORY_CONFIG_DIR", str(tmp_path))
    project_id = "39e91780-9d42-41e6-af40-e72372e72f64"
    path = f"/project-labels/{project_id}"
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    assert client.put(path, json={"name": "Planning"}).status_code == 403
    headers = {"Origin": ORIGIN}
    assert client.put(path, json={"name": " "}, headers=headers).status_code == 422
    assert client.put(path, json={"name": "  Planning  "}, headers=headers).json() == {
        "name": "Planning"
    }
    fresh = TestClient(create_web_app(8765), base_url=ORIGIN)
    assert fresh.get("/project-labels").json() == {project_id: "Planning"}
    assert not (tmp_path / "config.json").exists()


def test_formatted_editor_check_accepts_equivalent_markdown_tables() -> None:
    client = TestClient(create_web_app(8765), base_url=ORIGIN)
    original = "| Task | Status |\n| :--- | ---: |\n| A \\| B | Ready |"
    roundtrip = "| Task    | Status |\n| :------ | -----: |\n| A \\| B | Ready  |"
    assert client.post(
        "/editor-check",
        json={"original": original, "roundtrip": roundtrip},
        headers={"Origin": ORIGIN},
    ).json() == {"editable": True}
