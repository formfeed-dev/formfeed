# formfeed (Python)

Client for the Formfeed API: template-based PDF and image generation. Sync and async, built on
httpx, pydantic models, retries on 429 and 503 with the server's `Retry-After`, an
`Idempotency-Key` on every render, typed errors and webhook verification.

```bash
pip install formfeed
```

```python
from formfeed import Formfeed

client = Formfeed("ff_test_…")                      # region="us" or base_url="…" for other hosts
render = client.renders.create(template="invoice-de", data={"invoice": {"number": "2026-001"}})
open("invoice.pdf", "wb").write(client.renders.download(render))

job = client.renders.batch([{"data": d} for d in rows], template="invoice-de", zip=True)
job = client.jobs.wait_for(job.id)
```

```python
from formfeed import AsyncFormfeed

async with AsyncFormfeed("ff_test_…") as client:
    render = await client.renders.create(html="<h1>Hello</h1>", output="png")
```

Webhooks:

```python
from formfeed import parse_webhook_event

event = parse_webhook_event(secret, request.headers["Webhook-Signature"], request.body)
```

Errors raise `FormfeedError` with `code`, `status`, `problem` and `request_id`. Templates:
`client.templates.all()`, `.version("invoice-de", "latest")`, `.create_version(...)`, `.publish(...)`.

Documentation: <https://docs.formfeed.dev/api/sdks/python>
