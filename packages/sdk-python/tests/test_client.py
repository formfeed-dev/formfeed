import asyncio
import hashlib
import hmac
import json
import time

import httpx
import pytest

from formfeed import AsyncFormfeed, Formfeed, FormfeedError, Render, parse_webhook_event, verify_webhook_signature

RENDER = {"id": "rnd_1", "status": "succeeded", "download_url": "https://cdn.test/o/x.pdf?exp=1&sig=2", "page_count": 1, "units": 1}


def _json(body, status=200, headers=None):
    return httpx.Response(status, json=body, headers=headers or {})


class Recorder:
    def __init__(self, responder):
        self.calls: list[httpx.Request] = []
        self._responder = responder

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return self._responder(request, len(self.calls))


def sync_client(responder, **options) -> tuple[Formfeed, Recorder]:
    rec = Recorder(responder)
    return Formfeed("ff_test_k", transport=httpx.MockTransport(rec.handler), **options), rec


def test_render_sends_auth_idempotency_and_maps_the_response():
    client, rec = sync_client(lambda req, n: _json(RENDER, 201))
    render = client.renders.create(template="invoice", data={"a": 1}, output="pdf")
    assert render.id == "rnd_1" and render.finished
    req = rec.calls[0]
    assert req.url == "https://api-eu.formfeed.dev/v1/renders"
    assert req.headers["authorization"] == "Bearer ff_test_k"
    assert len(req.headers["idempotency-key"]) > 10
    assert json.loads(req.content) == {"template": "invoice", "data": {"a": 1}, "output": "pdf"}


def test_retries_429_with_retry_after_then_succeeds(monkeypatch):
    monkeypatch.setattr("formfeed.client.time.sleep", lambda s: None)
    client, rec = sync_client(lambda req, n: _json({"code": "rate_limited"}, 429, {"retry-after": "1"}) if n < 3 else _json(RENDER))
    assert client.renders.get("rnd_1").status == "succeeded"
    assert len(rec.calls) == 3


def test_problems_become_typed_errors():
    client, _ = sync_client(lambda req, n: _json({"code": "quota_exceeded", "detail": "Monthly units used up", "status": 402}, 402, {"x-request-id": "req_9"}))
    with pytest.raises(FormfeedError) as e:
        client.renders.create(html="<p>x</p>")
    assert e.value.code == "quota_exceeded"
    assert e.value.status == 402
    assert e.value.request_id == "req_9"
    assert "Monthly units" in str(e.value)


def test_wait_for_and_download(monkeypatch):
    monkeypatch.setattr("formfeed.client.time.sleep", lambda s: None)
    states = iter(["queued", "rendering", "succeeded"])

    def responder(req, n):
        if req.url.host == "cdn.test":
            return httpx.Response(200, content=b"%PDF")
        return _json({**RENDER, "status": next(states)})

    client, _ = sync_client(responder)
    render = client.renders.wait_for("rnd_1", interval=0)
    assert render.status == "succeeded"
    assert client.renders.download(render) == b"%PDF"


def test_usage_reads_a_period():
    client, rec = sync_client(
        lambda req, n: _json(
            {"period": "2026-09", "included": 15000, "used": 120, "overage_used": 0, "overage_balance": 0,
             "daily": [{"date": "2026-09-07", "units": 3, "renders": 2}], "by_template": [{"template": "invoice", "units": 3}]}
        )
    )
    usage = client.account.usage("2026-08")
    assert usage.period == "2026-09"
    assert usage.daily[0].renders == 2
    assert usage.by_template[0].template == "invoice"
    assert rec.calls[0].url.params.get("period") == "2026-08"


def test_renders_list_follows_the_cursor_and_deletes_outputs():
    def responder(req, n):
        if req.method == "DELETE":
            return httpx.Response(204)
        cursor = req.url.params.get("cursor")
        return _json({"data": [RENDER], "next_cursor": None if cursor else "c1"})

    client, rec = sync_client(responder)
    page = client.renders.list(status="succeeded", limit=1)
    assert len(page.data) == 1 and page.next_cursor == "c1"
    assert rec.calls[0].url.params.get("status") == "succeeded"

    every = client.renders.all(template="invoice")
    assert len(every) == 2
    assert rec.calls[-1].url.params.get("cursor") == "c1"

    client.renders.delete_outputs("rnd_1")
    assert rec.calls[-1].method == "DELETE"
    assert rec.calls[-1].url.path == "/v1/renders/rnd_1/outputs"


def test_templates_follow_the_cursor_and_address_versions():
    def responder(req, n):
        if req.url.path == "/v1/templates":
            cursor = req.url.params.get("cursor")
            return _json({"data": [{"id": "tpl_1", "slug": "a", "name": "A", "kind": "pdf", "engine": "jinja2"}], "next_cursor": None if cursor else "c1"})
        if req.url.path.endswith("/versions/latest"):
            return _json({"id": "v", "number": 3, "status": "draft", "checksum": "x", "html": "<p>"})
        return _json({"id": "v", "number": 4, "status": "published", "checksum": "y"})

    client, rec = sync_client(responder)
    assert len(client.templates.all(kind="pdf")) == 2
    assert rec.calls[0].url.params["kind"] == "pdf"
    assert rec.calls[1].url.params["cursor"] == "c1"
    assert client.templates.version("a", "latest").html == "<p>"
    assert client.templates.publish("a", 4).status == "published"
    assert rec.calls[-1].url.path == "/v1/templates/a/versions/4/publish"


def test_async_client_has_the_same_surface():
    import asyncio

    rec = Recorder(lambda req, n: _json(RENDER, 201))

    async def scenario():
        async with AsyncFormfeed("ff_test_k", transport=httpx.MockTransport(rec.handler), region="us") as client:
            return await client.renders.create(html="<p>x</p>")

    render = asyncio.run(scenario())
    assert render.id == "rnd_1"
    assert rec.calls[0].url.host == "api-us.formfeed.dev"


def test_webhook_signature_round_trip():
    secret = "whsec_test"
    body = b'{"id":"evt_1","type":"render.completed","created_at":"2026-09-09T00:00:00Z","workspace_id":null,"data":{"id":"rnd_1"}}'
    t = int(time.time())
    sig = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    header = f"t={t},v1={sig}"
    assert verify_webhook_signature(secret, header, body)
    assert not verify_webhook_signature(secret, header, body + b" ")
    assert not verify_webhook_signature(secret, header, body, now=t + 1000)
    event = parse_webhook_event(secret, header, body)
    assert event.type == "render.completed" and event.data == {"id": "rnd_1"}
    with pytest.raises(ValueError):
        parse_webhook_event("other", header, body)


def test_pdf_tools_send_render_ids_and_idempotency_keys():
    def respond(req, n):
        if req.url.path.endswith("/pdf/info"):
            return _json({"source": "rnd_1", "page_count": 2, "pages": [{"width_pt": 595.28, "height_pt": 841.89}], "encrypted": False, "metadata": {}})
        return _json({**RENDER, "id": "rnd_9", "units": 0.5})

    client, rec = sync_client(respond)
    merged = client.pdf.merge([Render.model_validate(RENDER), "rnd_2"], filename="bundle.pdf")
    assert merged.id == "rnd_9" and merged.units == 0.5
    merge = rec.calls[0]
    assert merge.url.path == "/v1/pdf/merge"
    assert json.loads(merge.content) == {"filename": "bundle.pdf", "sources": ["rnd_1", "rnd_2"]}
    assert len(merge.headers["idempotency-key"]) > 10

    client.pdf.protect("rnd_9", user_password="open-me", permissions=["print"])
    assert json.loads(rec.calls[1].content) == {"user_password": "open-me", "permissions": ["print"], "source": "rnd_9"}
    client.pdf.watermark(merged, "COPY", rotation=0)
    assert json.loads(rec.calls[2].content) == {"rotation": 0, "source": "rnd_9", "text": "COPY"}

    info = client.pdf.info("rnd_1")
    assert info.page_count == 2 and not info.encrypted
    assert "idempotency-key" not in rec.calls[3].headers


def test_async_pdf_tools_mirror_the_sync_client():
    rec = Recorder(lambda req, n: _json({**RENDER, "id": "rnd_9", "units": 0.5}))

    async def run():
        async with AsyncFormfeed("ff_test_k", transport=httpx.MockTransport(rec.handler)) as client:
            return await client.pdf.merge(["rnd_1", "rnd_2"])

    assert asyncio.run(run()).id == "rnd_9"
    assert json.loads(rec.calls[0].content) == {"sources": ["rnd_1", "rnd_2"]}
