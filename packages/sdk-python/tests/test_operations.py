"""The SDK's half of the operations table (plan 34, decision 9).

``operations.json`` names a method for every operation of the API, or why there is none.
``packages/api-types/src/lib/sdk-fixtures.spec.ts`` holds the names to the API; this holds them to
both clients, so a renamed method fails here.
"""

import json
from pathlib import Path

import httpx
import pytest

from formfeed import AsyncFormfeed, Formfeed

MAP = json.loads((Path(__file__).resolve().parents[1] / "operations.json").read_text(encoding="utf-8"))
NAMED = [(operation, path) for operation, path in MAP["operations"].items() if isinstance(path, str)]


def test_names_a_method_for_most_operations():
    assert len(NAMED) > 50


@pytest.mark.parametrize("client_class", [Formfeed, AsyncFormfeed])
@pytest.mark.parametrize(("operation", "path"), NAMED)
def test_the_named_method_exists(client_class, operation, path):
    client = client_class("ff_test_k", transport=httpx.MockTransport(lambda request: httpx.Response(200)))
    target = client
    for part in path.split("."):
        target = getattr(target, part)
    assert callable(target), f"{operation}: {path}"
