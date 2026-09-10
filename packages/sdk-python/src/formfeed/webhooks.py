"""Webhook signature verification (spec 04 §2.4): ``Webhook-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>``."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from typing import Any

from .models import WebhookEvent

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def verify_webhook_signature(
    secret: str,
    signature_header: str | None,
    raw_body: bytes | str,
    *,
    tolerance_seconds: int = 300,
    now: int | None = None,
) -> bool:
    """True when the header matches the raw body. Pass the body exactly as received: the signature covers the bytes on the wire."""
    if not signature_header or not secret:
        return False
    parts: dict[str, str] = {}
    for kv in signature_header.split(","):
        key, _, value = kv.strip().partition("=")
        parts[key] = value
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    v1 = parts.get("v1", "").lower()
    if not _HEX64.match(v1):
        return False
    current = now if now is not None else int(time.time())
    if abs(current - t) > tolerance_seconds:
        return False
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode("utf-8"), f"{t}.".encode("utf-8") + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)


def parse_webhook_event(
    secret: str,
    signature_header: str | None,
    raw_body: bytes | str,
    *,
    tolerance_seconds: int = 300,
    now: int | None = None,
) -> WebhookEvent:
    """Parses a verified event body; raises ``ValueError`` when the signature does not match."""
    if not verify_webhook_signature(secret, signature_header, raw_body, tolerance_seconds=tolerance_seconds, now=now):
        raise ValueError("invalid webhook signature")
    payload: dict[str, Any] = json.loads(raw_body)
    return WebhookEvent.model_validate(payload)
