"""Formfeed API client (spec 10 §1): sync and async, retries on 429/503, idempotency keys, typed errors."""

from .client import AsyncFormfeed, Formfeed
from .errors import FormfeedError
from .models import (
    Diagnostic,
    Job,
    LibraryFile,
    LibraryFilePage,
    PdfInfo,
    Render,
    RenderPage,
    Template,
    Usage,
    TemplateValidation,
    TemplateVersion,
    WebhookEndpoint,
    WebhookEvent,
)
from .webhooks import parse_webhook_event, verify_webhook_signature

__all__ = [
    "AsyncFormfeed",
    "Formfeed",
    "FormfeedError",
    "Diagnostic",
    "Job",
    "LibraryFile",
    "LibraryFilePage",
    "PdfInfo",
    "Render",
    "RenderPage",
    "Template",
    "TemplateValidation",
    "Usage",
    "TemplateVersion",
    "WebhookEndpoint",
    "WebhookEvent",
    "parse_webhook_event",
    "verify_webhook_signature",
]

__version__ = "0.1.0"
