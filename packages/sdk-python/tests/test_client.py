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


def test_workspaces_delete_and_last_workspace():
    def responder(req, n):
        if req.url.path.endswith("/ws-last"):
            return _json({"code": "last_workspace", "detail": "last one", "status": 409}, 409)
        return httpx.Response(204)

    client, rec = sync_client(responder, max_retries=0)
    assert client.workspaces.delete("f0000000-0000-4000-8000-000000000002") is None
    assert rec.calls[0].method == "DELETE"
    assert rec.calls[0].url.path == "/v1/workspaces/f0000000-0000-4000-8000-000000000002"
    with pytest.raises(FormfeedError) as e:
        client.workspaces.delete("ws-last")
    assert e.value.code == "last_workspace" and e.value.status == 409

    async def run():
        async with AsyncFormfeed("ff_test_k", transport=httpx.MockTransport(rec.handler)) as client_async:
            await client_async.workspaces.delete("f0000000-0000-4000-8000-000000000003")

    asyncio.run(run())
    assert rec.calls[-1].url.path == "/v1/workspaces/f0000000-0000-4000-8000-000000000003"


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


def test_release_channels_and_the_schema_guard():
    channel = {"name": "staging", "version": 5, "canary": None, "previous_version": 4, "updated_at": "2026-09-13T10:00:00Z"}

    def responder(req, n):
        body = json.loads(req.content) if req.content else None
        if req.method == "GET" and req.url.path.endswith("/channels"):
            return _json({"data": [{**channel, "name": "published"}, channel], "limits": {"channels": 2, "canary": False}})
        if req.method == "PUT" and not (body or {}).get("allow_breaking"):
            return _json({"type": "x", "title": "Schema change breaks callers", "status": 409, "code": "schema_breaking_change", "detail": "x", "breaking": [{"path": "a"}]}, 409)
        if req.method == "DELETE":
            return httpx.Response(204)
        if req.url.path.endswith("/publish"):
            return _json({"id": "v", "number": 5, "status": "published", "checksum": "y", "schema_check": {"source": "stored", "breaking": [], "safe": []}})
        return _json({**channel, "schema_check": {"source": "inferred", "breaking": [], "safe": []}})

    client, rec = sync_client(responder, max_retries=0)
    listed = client.templates.channels.list("invoice")
    assert [c.name for c in listed.data] == ["published", "staging"]
    assert listed.limits.channels == 2 and listed.limits.canary is False
    with pytest.raises(FormfeedError) as refused:
        client.templates.channels.set("invoice", "staging", version=5)
    assert refused.value.code == "schema_breaking_change"
    moved = client.templates.channels.set("invoice", "staging", version=5, canary={"version": 6, "percent": 10}, allow_breaking=True)
    assert moved.schema_check is not None and moved.schema_check.source == "inferred"
    assert json.loads(rec.calls[-1].content) == {"version": 5, "canary": {"version": 6, "percent": 10}, "allow_breaking": True}
    client.templates.channels.promote("invoice", "staging")
    assert rec.calls[-1].url.path == "/v1/templates/invoice/channels/staging/promote"
    client.templates.channels.rollback("invoice", "staging", allow_breaking=True)
    assert json.loads(rec.calls[-1].content) == {"allow_breaking": True}
    client.templates.channels.delete("invoice", "staging", force=True)
    assert rec.calls[-1].url.params["force"] == "true"
    published = client.templates.publish("invoice", 5, allow_breaking=True)
    assert published.schema_check is not None and published.schema_check.source == "stored"
    assert json.loads(rec.calls[-1].content) == {"allow_breaking": True}

    async def scenario():
        async with AsyncFormfeed("ff_test_k", transport=httpx.MockTransport(rec.handler), max_retries=0) as client_async:
            listed_async = await client_async.templates.channels.list("invoice")
            rolled = await client_async.templates.channels.rollback("invoice", "staging")
            return listed_async, rolled

    listed_async, rolled = asyncio.run(scenario())
    assert len(listed_async.data) == 2
    assert rolled.name == "staging"


def test_canary_key_travels_with_renders_and_batches():
    client, rec = sync_client(lambda req, n: _json(RENDER if req.url.path == "/v1/renders" else {"id": "job_1", "status": "queued"}))
    client.renders.create(template="invoice", version="staging", data={}, canary_key="customer-42")
    assert json.loads(rec.calls[-1].content)["canary_key"] == "customer-42"
    client.renders.batch([{"data": {}}], template="invoice", canary_key="order-7")
    assert json.loads(rec.calls[-1].content)["canary_key"] == "order-7"


def test_render_template_ref_carries_the_channel():
    render = Render.model_validate({**RENDER, "template": {"id": "t", "slug": "invoice", "version": 5, "channel": "staging", "canary": True}})
    assert render.template is not None and render.template.channel == "staging" and render.template.canary is True


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


FILE = {"id": "fil_1", "name": "brand/logo.png", "content_type": "image/png", "bytes": 3, "sha256": "aa", "url": "https://cdn.test/a/ws/brand/logo.png"}


def test_files_upload_as_multipart_list_get_and_delete():
    def respond(req, n):
        if req.method == "DELETE":
            return httpx.Response(204)
        if req.method == "POST":
            return _json(FILE, 201)
        if req.url.path.endswith("/files"):
            return _json({"data": [FILE], "next_cursor": None})
        return _json(FILE)

    client, rec = sync_client(respond)
    uploaded = client.files.upload(b"\x01\x02\x03", "brand/logo.png", content_type="image/png")
    assert uploaded.url == "https://cdn.test/a/ws/brand/logo.png"
    req = rec.calls[0]
    assert req.url == "https://api-eu.formfeed.dev/v1/files"
    assert req.headers["content-type"].startswith("multipart/form-data; boundary=")
    body = req.content
    assert b'name="name"\r\n\r\nbrand/logo.png' in body
    assert b'filename="logo.png"' in body and b"Content-Type: image/png" in body and b"\x01\x02\x03" in body

    assert [f.name for f in client.files.all(prefix="brand/")] == ["brand/logo.png"]
    assert str(rec.calls[1].url) == "https://api-eu.formfeed.dev/v1/files?prefix=brand%2F"
    assert client.files.get("fil_1").id == "fil_1"
    client.files.delete(uploaded)
    assert rec.calls[3].method == "DELETE" and str(rec.calls[3].url).endswith("/files/fil_1")


def test_templates_validate_sends_version_and_data():
    result = {
        "ok": False,
        "template": {"id": "tpl_1", "slug": "invoice", "version": 3},
        "diagnostics": [{"severity": "error", "code": "data-validation", "path": "data.n", "message": "data.n: is required"}],
    }
    client, rec = sync_client(lambda req, n: _json(result))
    checked = client.templates.validate("invoice", {"a": 1}, version="latest")
    assert checked.ok is False and checked.diagnostics[0].path == "data.n" and checked.template.version == 3
    assert str(rec.calls[0].url).endswith("/templates/invoice/validate")
    assert json.loads(rec.calls[0].content) == {"version": "latest", "data": {"a": 1}}


def test_library_files_as_image_watermarks_and_merge_sources():
    client, rec = sync_client(lambda req, n: _json(RENDER))
    client.pdf.watermark("rnd_1", image="draft.png", opacity=0.2)
    assert json.loads(rec.calls[0].content) == {"source": "rnd_1", "image": "draft.png", "opacity": 0.2}
    client.pdf.watermark("rnd_1", "COPY")
    assert json.loads(rec.calls[1].content) == {"source": "rnd_1", "text": "COPY"}
    with pytest.raises(FormfeedError):
        client.pdf.watermark("rnd_1")
    with pytest.raises(FormfeedError):
        client.pdf.watermark("rnd_1", "COPY", image="draft.png")
    client.pdf.merge(["rnd_1", "terms.pdf"])
    assert json.loads(rec.calls[2].content)["sources"] == ["rnd_1", "terms.pdf"]


def test_async_files_mirror_the_sync_client():
    async def run():
        rec = Recorder(lambda req, n: _json(FILE, 201))
        async with AsyncFormfeed("ff_test_k", transport=httpx.MockTransport(rec.handler)) as client:
            uploaded = await client.files.upload(b"x", "logo.png")
            return uploaded, rec

    uploaded, rec = asyncio.run(run())
    assert uploaded.id == "fil_1"
    assert rec.calls[0].headers["content-type"].startswith("multipart/form-data")


BRAND = {
    "version": 7,
    "name": "Fennlor Studio GmbH",
    "colors": {"primary": "#0f766e"},
    "fonts": {"heading": "Inter", "body": None},
    "font_size": "10pt",
    "logo": {"primary": "https://cdn.test/a/brand/org/primary-3f9a1c2b7d4e.svg", "inverse": None, "mark": None},
    "legal_footer": "Fennlor Studio GmbH",
    "page_defaults": {"paper": {"format": "A4"}},
    "updated_at": "2026-09-13T00:00:00Z",
}
PARTIAL = {"name": "letterhead", "engine": "jinja2", "description": None, "version": 3, "created_at": "", "updated_at": ""}


def _partials_responder(req, n):
    if req.method == "DELETE":
        return httpx.Response(204)
    if req.method == "PUT":
        body = json.loads(req.content)
        base = body.get("base_version")
        return _json({**PARTIAL, "source": body["source"], "version": base + 1 if base else 1}, 200 if base else 201)
    if req.url.path == "/v1/brand":
        return _json(BRAND)
    if req.url.path == "/v1/partials":
        return _json({"data": [PARTIAL]})
    return _json({**PARTIAL, "source": "<header>Fennlor</header>"})


def test_brand_kit_is_read():
    client, rec = sync_client(_partials_responder)
    brand = client.brand.get()
    assert brand.version == 7 and brand.colors == {"primary": "#0f766e"}
    assert brand.fonts.heading == "Inter" and brand.logo.inverse is None
    assert str(rec.calls[0].url) == "https://api-eu.formfeed.dev/v1/brand"


def test_partials_list_get_put_and_delete():
    client, rec = sync_client(_partials_responder)
    assert [p.name for p in client.partials.list()] == ["letterhead"]
    assert client.partials.get("letterhead").source == "<header>Fennlor</header>"
    assert str(rec.calls[1].url) == "https://api-eu.formfeed.dev/v1/partials/letterhead"

    created = client.partials.put("footer", engine="jinja2", source="<footer/>")
    assert created.created is True and created.partial.version == 1 and created.partial.source == "<footer/>"
    assert rec.calls[2].method == "PUT" and rec.calls[2].url.path == "/v1/partials/footer"
    assert json.loads(rec.calls[2].content) == {"engine": "jinja2", "source": "<footer/>"}

    updated = client.partials.put("letterhead", engine="jinja2", source="<header/>", base_version=3, description=None)
    assert updated.created is False and updated.partial.version == 4
    assert json.loads(rec.calls[3].content) == {"engine": "jinja2", "source": "<header/>", "description": None, "base_version": 3}

    assert client.partials.delete("letterhead") is None
    assert rec.calls[4].method == "DELETE" and rec.calls[4].url.path == "/v1/partials/letterhead"


def test_partials_put_maps_a_stale_base_version_to_conflict():
    client, _ = sync_client(
        lambda req, n: _json({"type": "https://docs.formfeed.dev/errors/conflict", "title": "Conflict", "status": 409, "code": "conflict", "detail": "The partial is at version 4, not 3; pull it first", "current": {**PARTIAL, "version": 4}}, 409)
    )
    with pytest.raises(FormfeedError) as e:
        client.partials.put("letterhead", engine="liquid", source="x", base_version=3)
    assert e.value.code == "conflict" and e.value.status == 409
    assert "version 4, not 3" in str(e.value)
    assert e.value.problem["current"]["version"] == 4


def test_async_brand_and_partials_mirror_the_sync_client():
    rec = Recorder(_partials_responder)

    async def run():
        async with AsyncFormfeed("ff_test_k", transport=httpx.MockTransport(rec.handler)) as client:
            brand = await client.brand.get()
            listed = await client.partials.list()
            one = await client.partials.get("letterhead")
            created = await client.partials.put("footer", engine="handlebars", source="{{> x}}")
            await client.partials.delete("footer")
            return brand, listed, one, created

    brand, listed, one, created = asyncio.run(run())
    assert brand.name == "Fennlor Studio GmbH" and listed[0].version == 3 and one.source
    assert created.created is True and created.partial.engine == "jinja2"
    assert [c.method for c in rec.calls] == ["GET", "GET", "GET", "PUT", "DELETE"]


RENDER_INPUT = {
    "render_id": "rnd_1",
    "template": {"id": "tpl_1", "slug": "invoice", "version": 3},
    "data": {"n": 1},
    "environment": "test",
    "created_at": "2026-09-13T00:00:00Z",
}
SESSION = {
    "id": "s1",
    "secret": "whsec_s",
    "events": ["render.completed"],
    "environments": ["test"],
    "expires_at": "2026-09-13T00:02:00Z",
    "websocket_url": "wss://gw.test/x",
}


def _listen_responder(req, n):
    path = req.url.path
    if req.method == "DELETE":
        return httpx.Response(204)
    if path.endswith("/renders/rnd_2/input"):
        return _json({"code": "render_input_expired", "status": 410, "detail": "gone", "request_data_retention": "off"}, 410)
    if path.endswith("/input"):
        return _json(RENDER_INPUT)
    if path.endswith("/resend"):
        return _json({"delivery_id": "d1", "event_id": "evt_1", "event": "render.completed", "endpoint_id": "s1"}, 202)
    if path.endswith("/webhooks/listen"):
        return _json(SESSION, 201)
    body = json.loads(req.content)
    return _json({"id": "w1", "url": body["url"], "environments": body.get("environments", ["live", "test"])}, 201)


def test_render_input_and_an_expired_one():
    client, rec = sync_client(_listen_responder)
    got = client.renders.input("rnd_1")
    assert got.template is not None and got.template.slug == "invoice" and got.data == {"n": 1}
    assert rec.calls[0].method == "GET" and str(rec.calls[0].url) == "https://api-eu.formfeed.dev/v1/renders/rnd_1/input"
    with pytest.raises(FormfeedError) as e:
        client.renders.input("rnd_2")
    assert e.value.code == "render_input_expired" and e.value.status == 410
    assert e.value.problem["request_data_retention"] == "off"


def test_resend_listen_sessions_and_endpoint_environments():
    client, rec = sync_client(_listen_responder)
    resent = client.webhooks.resend("evt_1", "s1")
    assert resent.delivery_id == "d1"
    assert str(rec.calls[0].url).endswith("/webhooks/events/evt_1/resend")
    assert json.loads(rec.calls[0].content) == {"endpoint_id": "s1"}

    session = client.webhooks.listen.start(events=["render.completed"], live=False)
    assert session.secret == "whsec_s" and session.environments == ["test"]
    assert json.loads(rec.calls[1].content) == {"events": ["render.completed"], "live": False}
    client.webhooks.listen.start()
    assert json.loads(rec.calls[2].content) == {}
    client.webhooks.listen.end("s1")
    assert rec.calls[3].method == "DELETE" and str(rec.calls[3].url).endswith("/webhooks/listen/s1")

    endpoint = client.webhooks.create("https://hooks.example/x", events=["render.completed"], environments=["live"])
    assert endpoint.environments == ["live"]
    assert json.loads(rec.calls[4].content)["environments"] == ["live"]


def test_async_render_input_resend_and_listen_mirror_the_sync_client():
    rec = Recorder(_listen_responder)

    async def run():
        async with AsyncFormfeed("ff_test_k", transport=httpx.MockTransport(rec.handler)) as client:
            got = await client.renders.input("rnd_1")
            resent = await client.webhooks.resend("evt_1", "s1")
            session = await client.webhooks.listen.start(live=True)
            await client.webhooks.listen.end(session.id)
            return got, resent, session

    got, resent, session = asyncio.run(run())
    assert got.render_id == "rnd_1" and resent.endpoint_id == "s1" and session.id == "s1"
    assert json.loads(rec.calls[2].content) == {"live": True}
    assert [c.method for c in rec.calls] == ["GET", "POST", "POST", "DELETE"]
