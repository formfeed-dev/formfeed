# formfeed (Python)

Client for the [Formfeed](https://formfeed.dev/?utm_source=pypi) API: template-based PDF and image
generation. Sync and async, built on httpx, pydantic models, retries on 429 and 503 with the
server's `Retry-After`, an `Idempotency-Key` on every render, typed errors and webhook verification.

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

Word and PowerPoint:

```python
# a template is a .docx or .pptx with tags such as {{ customer.name }} in its text
with open("offer.docx", "rb") as f:
    client.templates.create(name="Offer", slug="offer", kind="docx", engine="jinja2", file=f, publish=True)
filled = client.renders.create(template="offer", output="docx", data={"customer": {"name": "Olvarest GmbH"}})

# a new version with a new document; without file= the latest document is kept
with open("offer-v2.docx", "rb") as f:
    client.templates.create_version("offer", file=f, change_note="New terms")
docx = client.templates.version_file("offer", "latest")   # the document's bytes

# any office document to PDF (Word, Excel, PowerPoint, OpenDocument, RTF)
with open("report.xlsx", "rb") as f:
    pdf = client.pdf.convert(file=f, single_page_sheets=True)
```

Webhooks:

```python
from formfeed import parse_webhook_event

event = parse_webhook_event(secret, request.headers["Webhook-Signature"], request.body)
```

Errors raise `FormfeedError` with `code`, `status`, `problem` and `request_id`. Templates:
`client.templates.all()`, `.version("invoice-de", "latest")`, `.create_version(...)`, `.publish(...)`.

Documentation: <https://docs.formfeed.dev/api/sdks/python>
