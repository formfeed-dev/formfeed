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


class WebhookEndpoint(_Model):
    id: str
    url: str
    events: list[str] = []
    enabled: bool = True
    description: str | None = None
    consecutive_failures: int = 0
    secret: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


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
