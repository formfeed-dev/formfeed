"""Response models. Extra fields the API adds later are kept (``extra="allow"``) so clients never break on additions."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

Region = Literal["eu", "us"]
Engine = Literal["jinja2", "liquid", "handlebars"]
OutputFormat = Literal["pdf", "png", "jpg", "webp"]
RenderStatus = Literal["queued", "rendering", "succeeded", "failed"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class RenderTemplateRef(_Model):
    id: str
    slug: str
    version: int
    #: The release channel the version came from (``published`` by default); ``None`` for a version number or ``latest``.
    channel: str | None = None
    #: True when the channel's canary share picked this version.
    canary: bool = False


class Render(_Model):
    id: str
    status: RenderStatus
    output: str | None = None
    download_url: str | None = None
    expires_at: str | None = None
    bytes: int | None = None
    page_count: int | None = None
    units: float = 0
    region: str | None = None
    environment: str | None = None
    template: RenderTemplateRef | None = None
    engine_version: str | None = None
    template_checksum: str | None = None
    output_sha256: str | None = None
    deduplicated: bool = False
    timings: dict[str, float] | None = None
    error: dict[str, Any] | None = None
    meta: dict[str, Any] = {}
    created_at: str | None = None
    completed_at: str | None = None

    @property
    def finished(self) -> bool:
        return self.status in ("succeeded", "failed")


class Job(_Model):
    id: str
    type: str = "batch"
    status: str
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    zip_url: str | None = None
    zip_expires_at: str | None = None
    items: list[Render] = []
    meta: dict[str, Any] = {}
    created_at: str | None = None
    completed_at: str | None = None

    @property
    def finished(self) -> bool:
        return self.status not in ("queued", "processing")


WebhookEnvironment = Literal["live", "test"]


class WebhookEndpoint(_Model):
    id: str
    url: str
    events: list[str] = []
    #: Render environments whose events the endpoint receives; both by default. Quota events are sent regardless.
    environments: list[WebhookEnvironment] = ["live", "test"]
    enabled: bool = True
    description: str | None = None
    consecutive_failures: int = 0
    secret: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class ListenSession(_Model):
    """A listen session (``POST /webhooks/listen``): receives the workspace's events like an endpoint and
    relays them over ``websocket_url`` (valid for 60 seconds, no key needed). The SDK opens no socket."""

    id: str
    #: Signs the session's deliveries.
    secret: str
    events: list[str] = []
    environments: list[WebhookEnvironment] = []
    expires_at: str | None = None
    websocket_url: str


class WebhookResend(_Model):
    delivery_id: str
    event_id: str
    event: str
    endpoint_id: str


class RenderInputTemplate(_Model):
    id: str
    slug: str
    version: int
    channel: str | None = None


class RenderInput(_Model):
    """The stored request of a render (``GET /renders/{id}/input``). Template renders carry ``template`` and
    ``data``, ad-hoc renders ``html`` or ``url``. Passwords of ``post`` are never included."""

    render_id: str
    template: RenderInputTemplate | None = None
    html: str | None = None
    engine: Engine | None = None
    url: str | None = None
    data: dict[str, Any] | None = None
    locale: str | None = None
    output: OutputFormat | None = None
    settings: dict[str, Any] | None = None
    filename: str | None = None
    post: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None
    environment: Literal["live", "test"] | None = None
    created_at: str | None = None


class Template(_Model):
    id: str
    slug: str
    name: str
    description: str | None = None
    kind: str
    engine: str
    tags: list[str] = []
    published_version: int | None = None
    latest_version: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class TemplateVersion(_Model):
    id: str
    number: int
    status: str
    checksum: str
    change_note: str | None = None
    created_at: str | None = None
    published_at: str | None = None
    html: str | None = None
    css: str | None = None
    head: str | None = None
    settings: dict[str, Any] | None = None
    sample_data: dict[str, Any] | None = None
    data_schema: dict[str, Any] | None = None
    i18n: dict[str, Any] | None = None
    #: Partials the template includes (``name`` → source), as ``formfeed templates push`` sends them.
    partials: dict[str, str] | None = None
    #: Publishing only: how the data schema changed against the version callers used before.
    schema_check: SchemaCheck | None = None


class SchemaChange(_Model):
    #: Dotted field path (``customer.email``, ``items[]``); empty for the data itself.
    path: str
    pointer: str
    kind: str
    breaking: bool
    message: str


class SchemaCheck(_Model):
    """``stored``: both versions store a schema, breaking changes refuse without ``allow_breaking``.
    ``inferred``: compared from sample data, a warning only. ``none``: nothing to compare."""

    source: Literal["stored", "inferred", "none"]
    breaking: list[SchemaChange] = []
    safe: list[SchemaChange] = []


class ChannelCanary(_Model):
    version: int
    percent: int


class ChannelUsage(_Model):
    version: int
    renders: int = 0
    failed: int = 0


class Channel(_Model):
    """A release channel of a template: ``published`` or a named one such as ``staging``."""

    name: str
    version: int | None = None
    canary: ChannelCanary | None = None
    #: The version before the last move; ``rollback`` returns to it.
    previous_version: int | None = None
    updated_at: str | None = None
    #: Renders of the last 24 hours through this channel, per version (list only).
    usage_24h: list[ChannelUsage] = []
    #: Writes only.
    schema_check: SchemaCheck | None = None


class ChannelLimits(_Model):
    #: Named channels per template besides published; ``None`` is unlimited.
    channels: int | None = None
    canary: bool = False


class ChannelList(_Model):
    data: list[Channel]
    limits: ChannelLimits


class UsageDay(_Model):
    date: str
    units: float = 0
    renders: int = 0


class UsageTemplate(_Model):
    template: str
    units: float = 0


class Usage(_Model):
    period: str
    included: float = 0
    used: float = 0
    overage_used: float = 0
    overage_balance: float = 0
    daily: list[UsageDay] = []
    by_template: list[UsageTemplate] = []


class PdfPage(_Model):
    width_pt: float
    height_pt: float
    width_mm: float | None = None
    height_mm: float | None = None


class PdfInfo(_Model):
    source: str | None = None
    page_count: int
    pages: list[PdfPage] = []
    encrypted: bool = False
    metadata: dict[str, Any] = {}


class LibraryFile(_Model):
    """A file of the workspace library (``/files``); a template reaches it with ``asset(name)``."""

    id: str
    name: str
    content_type: str
    bytes: int
    sha256: str | None = None
    url: str
    created_at: str | None = None
    updated_at: str | None = None


class BrandFonts(_Model):
    heading: str | None = None
    body: str | None = None


class BrandLogo(_Model):
    """CDN URLs of the logos; a new logo gets a new URL."""

    primary: str | None = None
    inverse: str | None = None
    mark: str | None = None


class Brand(_Model):
    """The organisation's brand kit (``GET /brand``): what templates see as ``brand``, plus the page
    defaults new templates start from. Unset values are ``None``; ``colors`` is always a dict."""

    version: int
    name: str | None = None
    colors: dict[str, str] = {}
    fonts: BrandFonts = BrandFonts()
    font_size: str | None = None
    logo: BrandLogo = BrandLogo()
    legal_footer: str | None = None
    page_defaults: dict[str, Any] = {}
    updated_at: str | None = None


class SharedPartial(_Model):
    """A shared partial of the organisation (``/partials``), included by name from templates of its engine."""

    name: str
    engine: Engine
    description: str | None = None
    version: int
    #: Only when read one by one (``partials.get``) and in the result of ``partials.put``.
    source: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class SharedPartialPutResult(_Model):
    partial: SharedPartial
    #: ``True`` when the name did not exist before (201), ``False`` for an update (200).
    created: bool


class Diagnostic(_Model):
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    location: dict[str, int] | None = None
    path: str | None = None
    """Data errors only: where in the data, e.g. ``data.invoice.lines[0].qty``."""


class TemplateValidation(_Model):
    ok: bool
    template: RenderTemplateRef
    diagnostics: list[Diagnostic]


class LibraryFilePage(_Model):
    data: list[LibraryFile]
    next_cursor: str | None = None


class RenderPage(_Model):
    data: list[Render]
    next_cursor: str | None = None


class TemplatePage(_Model):
    data: list[Template]
    next_cursor: str | None = None


class WebhookEvent(_Model):
    id: str
    type: str
    created_at: str
    workspace_id: str | None = None
    data: Any = None
