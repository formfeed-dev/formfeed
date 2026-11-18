"""The test vectors every SDK reads (plan 34, decision 9).

Written by ``packages/api-types/src/lib/sdk-fixtures.spec.ts``: webhook signatures, retries and
problems, played through both clients as a caller meets them.
"""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

import formfeed.client as client_module
from formfeed import AsyncFormfeed, Formfeed, FormfeedError, verify_webhook_signature

VECTORS = Path(__file__).resolve().parents[2] / "api-types" / "fixtures" / "sdk"


def _load(name: str):
    return json.loads((VECTORS / f"{name}.json").read_text(encoding="utf-8"))


WEBHOOKS = _load("webhook-signatures")
RETRIES = _load("retries")
PROBLEMS = _load("problems")


@pytest.mark.parametrize("case", WEBHOOKS["cases"], ids=lambda case: case["name"])
def test_webhook_signature(case):
    body = case["body"] if case["body"] is not None else WEBHOOKS["body"]
    valid = verify_webhook_signature(
        WEBHOOKS["secret"],
        case["header"],
        body,
        tolerance_seconds=WEBHOOKS["tolerance_seconds"],
        now=WEBHOOKS["now"],
    )
    assert valid is case["valid"]


def _answering(answers):
    """A transport handler that gives the answers in order and counts the requests."""
    state = {"requests": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        answer = answers[state["requests"]]
        state["requests"] += 1
        if answer.get("network_error"):
            raise httpx.ConnectError("connection refused", request=request)
        headers = {"retry-after": answer["retry_after"]} if answer.get("retry_after") else {}
        return httpx.Response(answer["status"], json=answer.get("body", {}), headers=headers)

    return handler, state


def _outcome(call):
    try:
        call()
        return {"ok": True}
    except FormfeedError as error:
        return {"error": {"code": error.code, "status": error.status}}


def _check(case, waits, requests):
    assert requests == len(case["answers"])
    assert len(waits) == len(case["waits_ms"])
    for wait, (lowest, highest) in zip(waits, case["waits_ms"]):
        assert lowest - 1e-6 <= wait <= highest + 1e-6


# the lowest jitter and the highest, so both ends of every wait's bounds are met
@pytest.mark.parametrize("jitter", [0.0, 0.999999])
@pytest.mark.parametrize("case", RETRIES["cases"], ids=lambda case: case["name"])
def test_retries(case, jitter, monkeypatch):
    waits: list[float] = []
    monkeypatch.setattr(client_module.random, "random", lambda: jitter)
    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: waits.append(seconds * 1000))
    handler, state = _answering(case["answers"])
    client = Formfeed("ff_test_k", transport=httpx.MockTransport(handler), max_retries=RETRIES["max_retries"])
    assert _outcome(lambda: client.request("GET", "/account")) == case["outcome"]
    _check(case, waits, state["requests"])


@pytest.mark.parametrize("jitter", [0.0, 0.999999])
@pytest.mark.parametrize("case", RETRIES["cases"], ids=lambda case: case["name"])
def test_retries_async(case, jitter, monkeypatch):
    waits: list[float] = []

    async def sleep(seconds: float) -> None:
        waits.append(seconds * 1000)

    monkeypatch.setattr(client_module.random, "random", lambda: jitter)
    monkeypatch.setattr(client_module.asyncio, "sleep", sleep)
    handler, state = _answering(case["answers"])

    async def call():
        async with AsyncFormfeed(
            "ff_test_k", transport=httpx.MockTransport(handler), max_retries=RETRIES["max_retries"]
        ) as client:
            await client.request("GET", "/account")

    assert _outcome(lambda: asyncio.run(call())) == case["outcome"]
    _check(case, waits, state["requests"])


@pytest.mark.parametrize("case", PROBLEMS["cases"], ids=lambda case: case["name"])
def test_problem(case):
    def handler(request: httpx.Request) -> httpx.Response:
        body = case["body"]
        if body is None:
            return httpx.Response(case["status"], headers=case["headers"])
        if isinstance(body, str):
            return httpx.Response(case["status"], text=body, headers={**case["headers"], "content-type": "text/plain"})
        return httpx.Response(case["status"], json=body, headers=case["headers"])

    client = Formfeed("ff_test_k", transport=httpx.MockTransport(handler), max_retries=0)
    with pytest.raises(FormfeedError) as raised:
        client.request("GET", "/account")
    error = raised.value
    got = {"code": error.code, "message": error.message, "status": error.status, "request_id": error.request_id}
    assert got == case["expect"]
