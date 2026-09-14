"""Sync and async clients (httpx). Every behaviour mirrors ``@formfeed/sdk`` so the two SDKs stay in step."""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from typing import Any, Generic, TypeVar
from urllib.parse import quote

import httpx

from .errors import FormfeedError
from .models import (
    Brand,
    Channel,
    ChannelList,
    Engine,
    Job,
    LibraryFile,
    LibraryFilePage,
    ListenSession,
    PdfInfo,
    Region,
    Render,
    RenderInput,
    RenderPage,
    SharedPartial,
    SharedPartialPutResult,
    Template,
    TemplatePage,
    TemplateValidation,
    TemplateVersion,
    Usage,
    WebhookEndpoint,
    WebhookResend,
)

HOSTS: dict[str, str] = {"eu": "https://api-eu.formfeed.dev/v1", "us": "https://api-us.formfeed.dev/v1"}
USER_AGENT = "formfeed-sdk-python/0.2"
RETRY_STATUSES = (429, 503)

T = TypeVar("T")


def _backoff(attempt: int, retry_after: str | None) -> float:
    """Seconds to wait: the server's Retry-After when present, else 0.5 s doubling, plus jitter, capped at 30 s."""
    base = 0.5 * 2 ** (attempt - 1)
    if retry_after:
        try:
            value = float(retry_after)
            if value > 0:
                base = value
        except ValueError:
            pass
    return min(30.0, base + random.random() * 0.25)


def _problem_error(res: httpx.Response) -> FormfeedError:
    try:
        problem = res.json() if res.content else {}
    except ValueError:
        problem = {}
    if not isinstance(problem, dict):
        problem = {}
    return FormfeedError(
        str(problem.get("code") or f"http_{res.status_code}"),
        str(problem.get("detail") or problem.get("title") or f"HTTP {res.status_code}"),
        res.status_code,
        problem,
        res.headers.get("x-request-id"),
    )


def _query(**params: Any) -> dict[str, Any]:
    return {k: v for k, v in params.items() if v is not None and v != ""}


class _Base(Generic[T]):
    def __init__(
        self,
        api_key: str,
        *,
        region: Region = "eu",
        base_url: str | None = None,
        max_retries: int = 3,
        timeout: float = 120.0,
        transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key:
            raise FormfeedError("invalid_request", "api_key is required")
        self.api_key = api_key
        self.base_url = (base_url or HOSTS[region]).rstrip("/")
        self.max_retries = max_retries
        self.timeout = timeout
        self._transport = transport

    def _headers(self, body: Any, idempotency_key: str | None) -> dict[str, str]:
        headers = {"authorization": f"Bearer {self.api_key}", "accept": "application/json", "user-agent": USER_AGENT}
        if body is not None:
            headers["content-type"] = "application/json"
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        return headers

    @staticmethod
    def _decode(res: httpx.Response) -> Any:
        if res.status_code == 204 or not res.content:
            return None
        return res.json()


class Formfeed(_Base[Any]):
    """Synchronous client.

    >>> client = Formfeed("ff_test_…")
    >>> render = client.renders.create(template="invoice-de", data={"invoice": {...}})
    >>> pdf = client.renders.download(render)
    """

    def __init__(self, api_key: str, **options: Any) -> None:
        super().__init__(api_key, **options)
        self._http = httpx.Client(timeout=self.timeout, transport=self._transport)  # type: ignore[arg-type]
        self.renders = _Renders(self)
        self.jobs = _Jobs(self)
        self.webhooks = _Webhooks(self)
        self.templates = _Templates(self)
        self.account = _Account(self)
        self.pdf = _Pdf(self)
        self.files = _Files(self)
        self.brand = _Brand(self)
        self.partials = _Partials(self)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Formfeed":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def request(
        self, method: str, path: str, body: Any = None, *, idempotency_key: str | None = None, files: Any = None, form: dict[str, str] | None = None
    ) -> Any:
        """Raw request with auth, retries and problem mapping; for endpoints without a helper.

        ``files`` and ``form`` send ``multipart/form-data`` instead of a JSON body (httpx sets the boundary).
        """
        return self._send(method, path, body, idempotency_key=idempotency_key, files=files, form=form)[1]

    def _send(
        self, method: str, path: str, body: Any = None, *, idempotency_key: str | None = None, files: Any = None, form: dict[str, str] | None = None
    ) -> tuple[int, Any]:
        """``request`` with the HTTP status, for endpoints whose answer depends on it (201 created, 200 updated)."""
        url = f"{self.base_url}{path}"
        headers = self._headers(body, idempotency_key)
        attempt = 0
        while True:
            try:
                if files is not None:
                    res = self._http.request(method, url, files=files, data=form, headers=headers)
                else:
                    res = self._http.request(method, url, json=body, headers=headers)
            except httpx.HTTPError as e:
                if attempt < self.max_retries:
                    attempt += 1
                    time.sleep(_backoff(attempt, None))
                    continue
                raise FormfeedError("network_error", str(e)) from e
            if res.status_code in RETRY_STATUSES and attempt < self.max_retries:
                attempt += 1
                time.sleep(_backoff(attempt, res.headers.get("retry-after")))
                continue
            if res.is_error:
                raise _problem_error(res)
            return res.status_code, self._decode(res)

    def download_url(self, url: str) -> bytes:
        res = self._http.get(url)
        if res.is_error:
            raise FormfeedError("download_failed", f"download answered HTTP {res.status_code}", res.status_code)
        return res.content


class AsyncFormfeed(_Base[Any]):
    """Asynchronous client with the same surface as :class:`Formfeed`; every method is awaitable."""

    def __init__(self, api_key: str, **options: Any) -> None:
        super().__init__(api_key, **options)
        self._http = httpx.AsyncClient(timeout=self.timeout, transport=self._transport)  # type: ignore[arg-type]
        self.renders = _AsyncRenders(self)
        self.jobs = _AsyncJobs(self)
        self.webhooks = _AsyncWebhooks(self)
        self.templates = _AsyncTemplates(self)
        self.account = _AsyncAccount(self)
        self.pdf = _AsyncPdf(self)
        self.files = _AsyncFiles(self)
        self.brand = _AsyncBrand(self)
        self.partials = _AsyncPartials(self)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncFormfeed":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def request(
        self, method: str, path: str, body: Any = None, *, idempotency_key: str | None = None, files: Any = None, form: dict[str, str] | None = None
    ) -> Any:
        return (await self._send(method, path, body, idempotency_key=idempotency_key, files=files, form=form))[1]

    async def _send(
        self, method: str, path: str, body: Any = None, *, idempotency_key: str | None = None, files: Any = None, form: dict[str, str] | None = None
    ) -> tuple[int, Any]:
        url = f"{self.base_url}{path}"
        headers = self._headers(body, idempotency_key)
        attempt = 0
        while True:
            try:
                if files is not None:
                    res = await self._http.request(method, url, files=files, data=form, headers=headers)
                else:
                    res = await self._http.request(method, url, json=body, headers=headers)
            except httpx.HTTPError as e:
                if attempt < self.max_retries:
                    attempt += 1
                    await asyncio.sleep(_backoff(attempt, None))
                    continue
                raise FormfeedError("network_error", str(e)) from e
            if res.status_code in RETRY_STATUSES and attempt < self.max_retries:
                attempt += 1
                await asyncio.sleep(_backoff(attempt, res.headers.get("retry-after")))
                continue
            if res.is_error:
                raise _problem_error(res)
            return res.status_code, self._decode(res)

    async def download_url(self, url: str) -> bytes:
        res = await self._http.get(url)
        if res.is_error:
            raise FormfeedError("download_failed", f"download answered HTTP {res.status_code}", res.status_code)
        return res.content


# --- sync namespaces --------------------------------------------------------------------------


def _render_body(template: str | None, html: str | None, url: str | None, data: dict[str, Any] | None, options: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {k: v for k, v in options.items() if v is not None}
    if template is not None:
        body["template"] = template
    if html is not None:
        body["html"] = html
    if url is not None:
        body["url"] = url
    if data is not None:
        body["data"] = data
    return body


def _source_id(source: Render | LibraryFile | str) -> str:
    return source if isinstance(source, str) else source.id


def _watermark_body(text: str | None, image: str | None) -> dict[str, str]:
    """A watermark is a text or a library image, never both and never neither (the API refuses both)."""
    if (text is None) == (image is None):
        raise FormfeedError("invalid_request", "pass either text or image")
    return {"text": text} if text is not None else {"image": image}  # type: ignore[dict-item]


def _upload_parts(data: bytes | Any, name: str, content_type: str | None) -> tuple[dict[str, Any], dict[str, str]]:
    """The multipart parts of an upload: the bytes (or a binary file object) under ``file``, the name beside them."""
    part = (name.rsplit("/", 1)[-1], data, content_type) if content_type else (name.rsplit("/", 1)[-1], data)
    return {"file": part}, {"name": name}


def _files_query(prefix: str | None, limit: int | None, cursor: str | None) -> str:
    params = httpx.QueryParams(_query(prefix=prefix, limit=limit, cursor=cursor))
    return f"/files{'?' + str(params) if params else ''}"


def _options(options: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in options.items() if v is not None}


class _Renders:
    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def create(
        self,
        *,
        template: str | None = None,
        html: str | None = None,
        url: str | None = None,
        data: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        **options: Any,
    ) -> Render:
        """Renders a template, HTML or URL. Sync by default; ``mode="async"`` returns a queued render."""
        body = _render_body(template, html, url, data, options)
        return Render.model_validate(self._c.request("POST", "/renders", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    def get(self, render_id: str) -> Render:
        return Render.model_validate(self._c.request("GET", f"/renders/{render_id}"))

    def wait_for(self, render_id: str, *, timeout: float = 120.0, interval: float = 1.0) -> Render:
        """Polls until the render succeeded or failed."""
        deadline = time.monotonic() + timeout
        while True:
            render = self.get(render_id)
            if render.finished:
                return render
            if time.monotonic() + interval > deadline:
                raise FormfeedError("timeout", f"render {render_id} did not finish within the wait time")
            time.sleep(interval)

    def download(self, render: Render | str) -> bytes:
        target = self.get(render) if isinstance(render, str) else render
        if not target.download_url:
            raise FormfeedError("not_ready", f"render {target.id} has no output ({target.status})")
        return self._c.download_url(target.download_url)

    def list(
        self,
        *,
        template: str | None = None,
        status: str | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> RenderPage:
        """Page of renders, newest first."""
        params = httpx.QueryParams(_query(template=template, status=status, environment=environment, since=since, until=until, limit=limit, cursor=cursor))
        return RenderPage.model_validate(self._c.request("GET", f"/renders{'?' + str(params) if params else ''}"))

    def all(self, **filters: Any) -> list[Render]:
        """Every render matching the filters, following the cursor."""
        out: list[Render] = []
        cursor: str | None = None
        while True:
            page = self.list(cursor=cursor, **filters)
            out.extend(page.data)
            cursor = page.next_cursor
            if not cursor:
                return out

    def delete_outputs(self, render_id: str) -> None:
        """Removes the stored files of a render before they expire (needs the file:delete scope)."""
        self._c.request("DELETE", f"/renders/{render_id}/outputs")

    def input(self, render_id: str) -> RenderInput:
        """The stored request of a render (needs ``render:input``); ``render_input_expired`` (410) when not kept."""
        return RenderInput.model_validate(self._c.request("GET", f"/renders/{quote(render_id, safe='')}/input"))

    def batch(self, items: list[dict[str, Any]], *, template: str | None = None, idempotency_key: str | None = None, **options: Any) -> Job:
        body: dict[str, Any] = {"items": items, **{k: v for k, v in options.items() if v is not None}}
        if template is not None:
            body["template"] = template
        return Job.model_validate(self._c.request("POST", "/renders/batch", body, idempotency_key=idempotency_key or str(uuid.uuid4())))


class _Jobs:
    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def get(self, job_id: str) -> Job:
        return Job.model_validate(self._c.request("GET", f"/jobs/{job_id}"))

    def wait_for(self, job_id: str, *, timeout: float = 600.0, interval: float = 2.0) -> Job:
        deadline = time.monotonic() + timeout
        while True:
            job = self.get(job_id)
            if job.finished:
                return job
            if time.monotonic() + interval > deadline:
                raise FormfeedError("timeout", f"job {job_id} did not finish within the wait time")
            time.sleep(interval)


def _listen_body(events: list[str] | None, live: bool | None) -> dict[str, Any]:
    return _query(events=events, live=live)


def _resend_path(event_id: str) -> str:
    return f"/webhooks/events/{quote(event_id, safe='')}/resend"


class _Listen:
    """Listen sessions, what ``formfeed listen`` uses (``webhook:listen``). Starting a session ends the previous
    one of the same key; the WebSocket at ``websocket_url`` is up to the caller."""

    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def start(self, *, events: list[str] | None = None, live: bool | None = None) -> ListenSession:
        """``live=True`` includes live-environment events and needs ``webhook:manage``."""
        return ListenSession.model_validate(self._c.request("POST", "/webhooks/listen", _listen_body(events, live)))

    def end(self, session_id: str) -> None:
        self._c.request("DELETE", f"/webhooks/listen/{quote(session_id, safe='')}")


class _Webhooks:
    def __init__(self, client: Formfeed) -> None:
        self._c = client
        self.listen = _Listen(client)

    def list(self) -> list[WebhookEndpoint]:
        return [WebhookEndpoint.model_validate(e) for e in self._c.request("GET", "/webhooks")["data"]]

    def create(
        self, url: str, *, events: list[str] | None = None, environments: list[str] | None = None, description: str | None = None
    ) -> WebhookEndpoint:
        body = _query(url=url, events=events, environments=environments, description=description)
        return WebhookEndpoint.model_validate(self._c.request("POST", "/webhooks", body))

    def resend(self, event_id: str, endpoint_id: str) -> WebhookResend:
        """Sends a stored event (``evt_…``) again as a new delivery to an endpoint or a running listen session."""
        return WebhookResend.model_validate(self._c.request("POST", _resend_path(event_id), {"endpoint_id": endpoint_id}))

    def update(self, endpoint_id: str, **patch: Any) -> WebhookEndpoint:
        return WebhookEndpoint.model_validate(self._c.request("PUT", f"/webhooks/{endpoint_id}", patch))

    def delete(self, endpoint_id: str) -> None:
        self._c.request("DELETE", f"/webhooks/{endpoint_id}")

    def test(self, endpoint_id: str) -> dict[str, Any]:
        return self._c.request("POST", f"/webhooks/{endpoint_id}/test")


def _channel_body(version: int, canary: dict[str, int] | None, allow_breaking: bool) -> dict[str, Any]:
    body: dict[str, Any] = {"version": version, "canary": canary}
    if allow_breaking:
        body["allow_breaking"] = True
    return body


def _guard(allow_breaking: bool) -> dict[str, Any] | None:
    return {"allow_breaking": True} if allow_breaking else None


class _Channels:
    """Release channels: a render with ``version="staging"`` uses the version the channel points at.
    Moves reach renders within a minute; a breaking data schema change raises ``schema_breaking_change``
    unless ``allow_breaking=True``."""

    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def list(self, id_or_slug: str) -> ChannelList:
        return ChannelList.model_validate(self._c.request("GET", f"/templates/{id_or_slug}/channels"))

    def set(self, id_or_slug: str, name: str, *, version: int, canary: dict[str, int] | None = None, allow_breaking: bool = False) -> Channel:
        """Creates or moves a channel; ``canary={"version": 6, "percent": 10}`` sends a share of its renders to another version."""
        return Channel.model_validate(self._c.request("PUT", f"/templates/{id_or_slug}/channels/{name}", _channel_body(version, canary, allow_breaking)))

    def promote(self, id_or_slug: str, name: str, *, allow_breaking: bool = False) -> Channel:
        return Channel.model_validate(self._c.request("POST", f"/templates/{id_or_slug}/channels/{name}/promote", _guard(allow_breaking)))

    def rollback(self, id_or_slug: str, name: str, *, allow_breaking: bool = False) -> Channel:
        return Channel.model_validate(self._c.request("POST", f"/templates/{id_or_slug}/channels/{name}/rollback", _guard(allow_breaking)))

    def delete(self, id_or_slug: str, name: str, *, force: bool = False) -> None:
        self._c.request("DELETE", f"/templates/{id_or_slug}/channels/{name}{'?force=true' if force else ''}")


class _Templates:
    def __init__(self, client: Formfeed) -> None:
        self._c = client
        self.channels = _Channels(client)

    def list(self, *, kind: str | None = None, engine: str | None = None, tag: str | None = None, q: str | None = None, limit: int | None = None, cursor: str | None = None) -> TemplatePage:
        params = httpx.QueryParams(_query(kind=kind, engine=engine, tag=tag, q=q, limit=limit, cursor=cursor))
        return TemplatePage.model_validate(self._c.request("GET", f"/templates{'?' + str(params) if params else ''}"))

    def all(self, **filters: Any) -> list[Template]:
        """Every template of the workspace, following the cursor."""
        out: list[Template] = []
        cursor: str | None = None
        while True:
            page = self.list(cursor=cursor, **filters)
            out.extend(page.data)
            cursor = page.next_cursor
            if not cursor:
                return out

    def get(self, id_or_slug: str) -> Template:
        return Template.model_validate(self._c.request("GET", f"/templates/{id_or_slug}"))

    def create(self, **template: Any) -> Template:
        return Template.model_validate(self._c.request("POST", "/templates", template))

    def update(self, id_or_slug: str, **patch: Any) -> Template:
        return Template.model_validate(self._c.request("PUT", f"/templates/{id_or_slug}", patch))

    def archive(self, id_or_slug: str) -> None:
        self._c.request("DELETE", f"/templates/{id_or_slug}")

    def version(self, id_or_slug: str, which: str | int = "published") -> TemplateVersion:
        """``which``: ``published``, ``latest``, a version number or a channel name; carries the files."""
        return TemplateVersion.model_validate(self._c.request("GET", f"/templates/{id_or_slug}/versions/{which}"))

    def versions(self, id_or_slug: str) -> list[TemplateVersion]:
        return [TemplateVersion.model_validate(v) for v in self._c.request("GET", f"/templates/{id_or_slug}/versions")["data"]]

    def create_version(self, id_or_slug: str, **version: Any) -> TemplateVersion:
        return TemplateVersion.model_validate(self._c.request("POST", f"/templates/{id_or_slug}/versions", version))

    def publish(self, id_or_slug: str, number: int, *, allow_breaking: bool = False) -> TemplateVersion:
        """Publishes a version; a data schema that breaks callers of the published one raises ``schema_breaking_change`` unless ``allow_breaking``."""
        return TemplateVersion.model_validate(self._c.request("POST", f"/templates/{id_or_slug}/versions/{number}/publish", _guard(allow_breaking)))

    def schema(self, id_or_slug: str) -> dict[str, Any]:
        return self._c.request("GET", f"/templates/{id_or_slug}/schema")

    def validate(self, id_or_slug: str, data: dict[str, Any] | None = None, *, version: str | int = "published") -> TemplateValidation:
        """Checks a version with data without rendering. Free. Without ``data``, the version's sample data is checked."""
        body: dict[str, Any] = {"version": version}
        if data is not None:
            body["data"] = data
        return TemplateValidation.model_validate(self._c.request("POST", f"/templates/{id_or_slug}/validate", body))


class _Account:
    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def get(self) -> dict[str, Any]:
        return self._c.request("GET", "/account")

    def usage(self, period: str = "current") -> Usage:
        """Units of the current period, or of ``YYYY-MM``, with a daily series and per template."""
        return Usage.model_validate(self._c.request("GET", f"/usage?period={period}"))


class _Pdf:
    """PDF tools on outputs of earlier renders. merge, protect and watermark return a new render
    (0.5 units each on live keys) and send an idempotency key; info is free."""

    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def merge(self, sources: list[Render | LibraryFile | str], *, idempotency_key: str | None = None, **options: Any) -> Render:
        """Sources are renders (or their ids) and PDFs of the file library (a ``LibraryFile``, its id or its name)."""
        body = {**_options(options), "sources": [_source_id(s) for s in sources]}
        return Render.model_validate(self._c.request("POST", "/pdf/merge", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    def protect(self, source: Render | str, *, idempotency_key: str | None = None, **options: Any) -> Render:
        """``user_password``, ``owner_password`` and ``permissions`` (print, copy, modify, annotate)."""
        body = {**_options(options), "source": _source_id(source)}
        return Render.model_validate(self._c.request("POST", "/pdf/protect", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    def watermark(
        self, source: Render | str, text: str | None = None, *, image: str | None = None, idempotency_key: str | None = None, **options: Any
    ) -> Render:
        """A ``text`` or an ``image`` (a PNG or JPEG of the file library, by id or name); ``opacity`` (0.2),
        ``rotation`` (degrees clockwise, -45) and ``color`` (hex, text only)."""
        body = {**_options(options), "source": _source_id(source), **_watermark_body(text, image)}
        return Render.model_validate(self._c.request("POST", "/pdf/watermark", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    def info(self, source: Render | str) -> PdfInfo:
        return PdfInfo.model_validate(self._c.request("POST", "/pdf/info", {"source": _source_id(source)}))


class _Files:
    """The workspace file library: images and PDFs a template references by name with ``asset('logo.png')``,
    and the sources of image watermarks and merges. Files are served without a signature."""

    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def upload(self, data: bytes | Any, name: str, *, content_type: str | None = None) -> LibraryFile:
        """Uploads bytes or a binary file object under ``name``; the same name replaces the file and keeps its URL."""
        files, form = _upload_parts(data, name, content_type)
        return LibraryFile.model_validate(self._c.request("POST", "/files", files=files, form=form))

    def list(self, *, prefix: str | None = None, limit: int | None = None, cursor: str | None = None) -> LibraryFilePage:
        return LibraryFilePage.model_validate(self._c.request("GET", _files_query(prefix, limit, cursor)))

    def all(self, *, prefix: str | None = None) -> list[LibraryFile]:
        out: list[LibraryFile] = []
        cursor: str | None = None
        while True:
            page = self.list(prefix=prefix, cursor=cursor)
            out.extend(page.data)
            cursor = page.next_cursor
            if not cursor:
                return out

    def get(self, file_id: str) -> LibraryFile:
        return LibraryFile.model_validate(self._c.request("GET", f"/files/{file_id}"))

    def delete(self, file: LibraryFile | str) -> None:
        """Removes the file and its bytes; templates that name it render a missing image afterwards."""
        self._c.request("DELETE", f"/files/{_source_id(file)}")


def _partial_path(name: str) -> str:
    return f"/partials/{quote(name, safe='')}"


def _partial_body(engine: Engine, source: str, description: str | None, base_version: int | None, has_description: bool) -> dict[str, Any]:
    body: dict[str, Any] = {"engine": engine, "source": source}
    # ``description=None`` clears it; leaving it out keeps the stored one
    if has_description:
        body["description"] = description
    if base_version is not None:
        body["base_version"] = base_version
    return body


_UNSET: Any = object()


class _Brand:
    """The organisation's brand kit, read-only through the API (it is edited in the app)."""

    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def get(self) -> Brand:
        return Brand.model_validate(self._c.request("GET", "/brand"))


class _Partials:
    """Shared partials of the organisation. Renders use the current source, so a change reaches every
    template that includes the partial without a new version."""

    def __init__(self, client: Formfeed) -> None:
        self._c = client

    def list(self) -> list[SharedPartial]:
        """Every shared partial, without its source."""
        return [SharedPartial.model_validate(p) for p in self._c.request("GET", "/partials")["data"]]

    def get(self, name: str) -> SharedPartial:
        """One partial with its source."""
        return SharedPartial.model_validate(self._c.request("GET", _partial_path(name)))

    def put(
        self, name: str, *, engine: Engine, source: str, description: str | None = _UNSET, base_version: int | None = None
    ) -> SharedPartialPutResult:
        """Creates or replaces a partial; ``base_version`` fails with 409 ``conflict`` when it changed since you read it."""
        body = _partial_body(engine, source, None if description is _UNSET else description, base_version, description is not _UNSET)
        status, data = self._c._send("PUT", _partial_path(name), body)
        return SharedPartialPutResult(partial=SharedPartial.model_validate(data), created=status == 201)

    def delete(self, name: str) -> None:
        """Removes a partial; templates that still include it fail to render afterwards."""
        self._c.request("DELETE", _partial_path(name))


# --- async namespaces -------------------------------------------------------------------------


class _AsyncRenders:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def create(
        self,
        *,
        template: str | None = None,
        html: str | None = None,
        url: str | None = None,
        data: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        **options: Any,
    ) -> Render:
        body = _render_body(template, html, url, data, options)
        return Render.model_validate(await self._c.request("POST", "/renders", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    async def get(self, render_id: str) -> Render:
        return Render.model_validate(await self._c.request("GET", f"/renders/{render_id}"))

    async def wait_for(self, render_id: str, *, timeout: float = 120.0, interval: float = 1.0) -> Render:
        deadline = time.monotonic() + timeout
        while True:
            render = await self.get(render_id)
            if render.finished:
                return render
            if time.monotonic() + interval > deadline:
                raise FormfeedError("timeout", f"render {render_id} did not finish within the wait time")
            await asyncio.sleep(interval)

    async def download(self, render: Render | str) -> bytes:
        target = await self.get(render) if isinstance(render, str) else render
        if not target.download_url:
            raise FormfeedError("not_ready", f"render {target.id} has no output ({target.status})")
        return await self._c.download_url(target.download_url)

    async def list(
        self,
        *,
        template: str | None = None,
        status: str | None = None,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> RenderPage:
        """Page of renders, newest first."""
        params = httpx.QueryParams(_query(template=template, status=status, environment=environment, since=since, until=until, limit=limit, cursor=cursor))
        return RenderPage.model_validate(await self._c.request("GET", f"/renders{'?' + str(params) if params else ''}"))

    async def all(self, **filters: Any) -> list[Render]:
        """Every render matching the filters, following the cursor."""
        out: list[Render] = []
        cursor: str | None = None
        while True:
            page = await self.list(cursor=cursor, **filters)
            out.extend(page.data)
            cursor = page.next_cursor
            if not cursor:
                return out

    async def delete_outputs(self, render_id: str) -> None:
        """Removes the stored files of a render before they expire (needs the file:delete scope)."""
        await self._c.request("DELETE", f"/renders/{render_id}/outputs")

    async def input(self, render_id: str) -> RenderInput:
        """The stored request of a render (needs ``render:input``); ``render_input_expired`` (410) when not kept."""
        return RenderInput.model_validate(await self._c.request("GET", f"/renders/{quote(render_id, safe='')}/input"))

    async def batch(self, items: list[dict[str, Any]], *, template: str | None = None, idempotency_key: str | None = None, **options: Any) -> Job:
        body: dict[str, Any] = {"items": items, **{k: v for k, v in options.items() if v is not None}}
        if template is not None:
            body["template"] = template
        return Job.model_validate(await self._c.request("POST", "/renders/batch", body, idempotency_key=idempotency_key or str(uuid.uuid4())))


class _AsyncJobs:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def get(self, job_id: str) -> Job:
        return Job.model_validate(await self._c.request("GET", f"/jobs/{job_id}"))

    async def wait_for(self, job_id: str, *, timeout: float = 600.0, interval: float = 2.0) -> Job:
        deadline = time.monotonic() + timeout
        while True:
            job = await self.get(job_id)
            if job.finished:
                return job
            if time.monotonic() + interval > deadline:
                raise FormfeedError("timeout", f"job {job_id} did not finish within the wait time")
            await asyncio.sleep(interval)


class _AsyncListen:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def start(self, *, events: list[str] | None = None, live: bool | None = None) -> ListenSession:
        return ListenSession.model_validate(await self._c.request("POST", "/webhooks/listen", _listen_body(events, live)))

    async def end(self, session_id: str) -> None:
        await self._c.request("DELETE", f"/webhooks/listen/{quote(session_id, safe='')}")


class _AsyncWebhooks:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client
        self.listen = _AsyncListen(client)

    async def list(self) -> list[WebhookEndpoint]:
        return [WebhookEndpoint.model_validate(e) for e in (await self._c.request("GET", "/webhooks"))["data"]]

    async def create(
        self, url: str, *, events: list[str] | None = None, environments: list[str] | None = None, description: str | None = None
    ) -> WebhookEndpoint:
        body = _query(url=url, events=events, environments=environments, description=description)
        return WebhookEndpoint.model_validate(await self._c.request("POST", "/webhooks", body))

    async def resend(self, event_id: str, endpoint_id: str) -> WebhookResend:
        return WebhookResend.model_validate(await self._c.request("POST", _resend_path(event_id), {"endpoint_id": endpoint_id}))

    async def update(self, endpoint_id: str, **patch: Any) -> WebhookEndpoint:
        return WebhookEndpoint.model_validate(await self._c.request("PUT", f"/webhooks/{endpoint_id}", patch))

    async def delete(self, endpoint_id: str) -> None:
        await self._c.request("DELETE", f"/webhooks/{endpoint_id}")

    async def test(self, endpoint_id: str) -> dict[str, Any]:
        return await self._c.request("POST", f"/webhooks/{endpoint_id}/test")


class _AsyncChannels:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def list(self, id_or_slug: str) -> ChannelList:
        return ChannelList.model_validate(await self._c.request("GET", f"/templates/{id_or_slug}/channels"))

    async def set(self, id_or_slug: str, name: str, *, version: int, canary: dict[str, int] | None = None, allow_breaking: bool = False) -> Channel:
        return Channel.model_validate(await self._c.request("PUT", f"/templates/{id_or_slug}/channels/{name}", _channel_body(version, canary, allow_breaking)))

    async def promote(self, id_or_slug: str, name: str, *, allow_breaking: bool = False) -> Channel:
        return Channel.model_validate(await self._c.request("POST", f"/templates/{id_or_slug}/channels/{name}/promote", _guard(allow_breaking)))

    async def rollback(self, id_or_slug: str, name: str, *, allow_breaking: bool = False) -> Channel:
        return Channel.model_validate(await self._c.request("POST", f"/templates/{id_or_slug}/channels/{name}/rollback", _guard(allow_breaking)))

    async def delete(self, id_or_slug: str, name: str, *, force: bool = False) -> None:
        await self._c.request("DELETE", f"/templates/{id_or_slug}/channels/{name}{'?force=true' if force else ''}")


class _AsyncTemplates:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client
        self.channels = _AsyncChannels(client)

    async def list(self, *, kind: str | None = None, engine: str | None = None, tag: str | None = None, q: str | None = None, limit: int | None = None, cursor: str | None = None) -> TemplatePage:
        params = httpx.QueryParams(_query(kind=kind, engine=engine, tag=tag, q=q, limit=limit, cursor=cursor))
        return TemplatePage.model_validate(await self._c.request("GET", f"/templates{'?' + str(params) if params else ''}"))

    async def all(self, **filters: Any) -> list[Template]:
        out: list[Template] = []
        cursor: str | None = None
        while True:
            page = await self.list(cursor=cursor, **filters)
            out.extend(page.data)
            cursor = page.next_cursor
            if not cursor:
                return out

    async def get(self, id_or_slug: str) -> Template:
        return Template.model_validate(await self._c.request("GET", f"/templates/{id_or_slug}"))

    async def create(self, **template: Any) -> Template:
        return Template.model_validate(await self._c.request("POST", "/templates", template))

    async def update(self, id_or_slug: str, **patch: Any) -> Template:
        return Template.model_validate(await self._c.request("PUT", f"/templates/{id_or_slug}", patch))

    async def archive(self, id_or_slug: str) -> None:
        await self._c.request("DELETE", f"/templates/{id_or_slug}")

    async def version(self, id_or_slug: str, which: str | int = "published") -> TemplateVersion:
        return TemplateVersion.model_validate(await self._c.request("GET", f"/templates/{id_or_slug}/versions/{which}"))

    async def versions(self, id_or_slug: str) -> list[TemplateVersion]:
        return [TemplateVersion.model_validate(v) for v in (await self._c.request("GET", f"/templates/{id_or_slug}/versions"))["data"]]

    async def create_version(self, id_or_slug: str, **version: Any) -> TemplateVersion:
        return TemplateVersion.model_validate(await self._c.request("POST", f"/templates/{id_or_slug}/versions", version))

    async def publish(self, id_or_slug: str, number: int, *, allow_breaking: bool = False) -> TemplateVersion:
        return TemplateVersion.model_validate(await self._c.request("POST", f"/templates/{id_or_slug}/versions/{number}/publish", _guard(allow_breaking)))

    async def schema(self, id_or_slug: str) -> dict[str, Any]:
        return await self._c.request("GET", f"/templates/{id_or_slug}/schema")

    async def validate(self, id_or_slug: str, data: dict[str, Any] | None = None, *, version: str | int = "published") -> TemplateValidation:
        body: dict[str, Any] = {"version": version}
        if data is not None:
            body["data"] = data
        return TemplateValidation.model_validate(await self._c.request("POST", f"/templates/{id_or_slug}/validate", body))


class _AsyncAccount:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def get(self) -> dict[str, Any]:
        return await self._c.request("GET", "/account")

    async def usage(self, period: str = "current") -> Usage:
        """Units of the current period, or of ``YYYY-MM``, with a daily series and per template."""
        return Usage.model_validate(await self._c.request("GET", f"/usage?period={period}"))


class _AsyncPdf:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def merge(self, sources: list[Render | LibraryFile | str], *, idempotency_key: str | None = None, **options: Any) -> Render:
        body = {**_options(options), "sources": [_source_id(s) for s in sources]}
        return Render.model_validate(await self._c.request("POST", "/pdf/merge", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    async def protect(self, source: Render | str, *, idempotency_key: str | None = None, **options: Any) -> Render:
        body = {**_options(options), "source": _source_id(source)}
        return Render.model_validate(await self._c.request("POST", "/pdf/protect", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    async def watermark(
        self, source: Render | str, text: str | None = None, *, image: str | None = None, idempotency_key: str | None = None, **options: Any
    ) -> Render:
        body = {**_options(options), "source": _source_id(source), **_watermark_body(text, image)}
        return Render.model_validate(await self._c.request("POST", "/pdf/watermark", body, idempotency_key=idempotency_key or str(uuid.uuid4())))

    async def info(self, source: Render | str) -> PdfInfo:
        return PdfInfo.model_validate(await self._c.request("POST", "/pdf/info", {"source": _source_id(source)}))


class _AsyncFiles:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def upload(self, data: bytes | Any, name: str, *, content_type: str | None = None) -> LibraryFile:
        files, form = _upload_parts(data, name, content_type)
        return LibraryFile.model_validate(await self._c.request("POST", "/files", files=files, form=form))

    async def list(self, *, prefix: str | None = None, limit: int | None = None, cursor: str | None = None) -> LibraryFilePage:
        return LibraryFilePage.model_validate(await self._c.request("GET", _files_query(prefix, limit, cursor)))

    async def all(self, *, prefix: str | None = None) -> list[LibraryFile]:
        out: list[LibraryFile] = []
        cursor: str | None = None
        while True:
            page = await self.list(prefix=prefix, cursor=cursor)
            out.extend(page.data)
            cursor = page.next_cursor
            if not cursor:
                return out

    async def get(self, file_id: str) -> LibraryFile:
        return LibraryFile.model_validate(await self._c.request("GET", f"/files/{file_id}"))

    async def delete(self, file: LibraryFile | str) -> None:
        await self._c.request("DELETE", f"/files/{_source_id(file)}")


class _AsyncBrand:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def get(self) -> Brand:
        return Brand.model_validate(await self._c.request("GET", "/brand"))


class _AsyncPartials:
    def __init__(self, client: AsyncFormfeed) -> None:
        self._c = client

    async def list(self) -> list[SharedPartial]:
        return [SharedPartial.model_validate(p) for p in (await self._c.request("GET", "/partials"))["data"]]

    async def get(self, name: str) -> SharedPartial:
        return SharedPartial.model_validate(await self._c.request("GET", _partial_path(name)))

    async def put(
        self, name: str, *, engine: Engine, source: str, description: str | None = _UNSET, base_version: int | None = None
    ) -> SharedPartialPutResult:
        body = _partial_body(engine, source, None if description is _UNSET else description, base_version, description is not _UNSET)
        status, data = await self._c._send("PUT", _partial_path(name), body)
        return SharedPartialPutResult(partial=SharedPartial.model_validate(data), created=status == 201)

    async def delete(self, name: str) -> None:
        await self._c.request("DELETE", _partial_path(name))
