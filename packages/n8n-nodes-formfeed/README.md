# n8n-nodes-formfeed

n8n community node for [Formfeed](https://formfeed.dev/?utm_source=npm&utm_content=n8n-node): render PDFs and images from templates,
read template schemas, and start workflows when a render or batch finishes.

## Install

n8n has verified the node, so n8n Cloud and self-hosted n8n offer it in the nodes panel: search for
**Formfeed** and click **Install node** (owners and admins). A self-hosted n8n can also install it by
name under **Settings → Community nodes → Install**, package name `n8n-nodes-formfeed`, or run
`npm install n8n-nodes-formfeed` in the n8n user folder.

## Credentials

Create an API key in the Formfeed app (**API keys**) and paste it into the _Formfeed API_
credential. A `ff_test_` key renders for free with a watermark, which is what you want while
building a workflow. The region selects the API host; a custom base URL points at staging or a
self-hosted gateway.

## Nodes

**Formfeed**

| Resource | Operations                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| Render   | Create (template, HTML or URL), Create E-Invoice, Get, Get Many, Delete Outputs                                            |
| Template | Get Many, Get, Get Schema                                                                                                  |
| Job      | Get                                                                                                                        |
| File     | Upload, Get Many, Delete                                                                                                   |
| PDF      | Convert Office Document (Word, Excel, PowerPoint, OpenDocument or RTF from a binary field, or a Word or PowerPoint render) |

Choosing a template loads its fields from its data schema (or its sample data), so you map named fields
(`invoice.number`) instead of pasting JSON; the JSON field covers lists and nested objects. With
_Download File_ the rendered document is attached as binary data, ready for an email or an upload.

_Create E-Invoice_ renders a ZUGFeRD / Factur-X e-invoice: a PDF/A-3 that carries the invoice as XML,
validated before the node receives it (Starter plan and above; a test key makes up to 20 a day on
Free). It asks for the invoice itself (seller, buyer, lines, VAT breakdown, totals, payment) and
sends it as the `_invoice` block, which the template prints as well; the E-invoice example in the
Formfeed app is such a template. What the fields do not offer goes into _Invoice (JSON)_, with the
names of the [field reference](https://docs.formfeed.dev/templates/e-invoices#invoice-block).

The node also works as a tool: connect it to the **Tools** input of n8n's AI Agent node and the agent
picks the operation and fills in its fields. A current n8n offers it as a tool without any setting;
older self-hosted versions did so only when the instance set
`N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

**Formfeed Trigger**

Registers a webhook endpoint in your workspace and starts the workflow on `render.completed`,
`render.failed`, `job.completed`, `job.failed`, `quota.warning` or `quota.exceeded`. The endpoint is
removed again when the workflow is deactivated.

## Example: render an invoice and send it by email

1. In the Formfeed app, open **Templates → Examples**, choose _German invoice with GiroCode_ and
   click **Use this template**. The copy is published under the slug `invoice-de`.
2. In n8n, start a new workflow with a **Manual Trigger**.
3. Add a **Formfeed** node with your _Formfeed API_ credential and set:
   - **Resource** _Render_, **Operation** _Create_, **Source** _Template_
   - **Template**: the copied invoice (the list shows its name; as an expression, `invoice-de`)
   - **Fields**: `invoice.number` = `2026-0042`, `invoice.date` = `2026-09-10`,
     `customer.name` = `Olvarest GmbH`
   - **Data (JSON)**, for the nested values and the list of lines:

     ```json
     {
       "company": {
         "name": "Fennlor Studio GmbH",
         "street": "Musterstraße 1",
         "city": "12345 Musterstadt",
         "iban": "DE36000000000000000000",
         "bic": "XXXXDEXXXXX",
         "vat_id": "DE000000000"
       },
       "customer": { "street": "Beispielweg 2", "city": "54321 Beispielstadt" },
       "invoice": {
         "vat_rate": 19,
         "lines": [
           {
             "description": "Consulting",
             "qty": 8,
             "price": 120,
             "total": 960
           },
           {
             "description": "Implementation",
             "qty": 20,
             "price": 110,
             "total": 2200
           }
         ]
       }
     }
     ```

   - **Download File** on, and under **Options** a **Filename** of `rechnung-2026-0042.pdf`

4. Execute the node. Its output item carries the render as JSON (shortened here) and the PDF as the
   binary field `data`:

   ```json
   {
     "id": "rnd_01J8ZK4M3Q7X",
     "status": "succeeded",
     "output": "pdf",
     "download_url": "https://cdn.formfeed.dev/o/eu/…",
     "page_count": 1,
     "units": 1,
     "environment": "test",
     "template": {
       "id": "tpl_01J8ZK4M3Q",
       "slug": "invoice-de",
       "version": 1,
       "channel": "published",
       "canary": false
     }
   }
   ```

5. Add a **Gmail** or **Send Email** node and attach the binary field `data`.

With real data, the fixed values become expressions over an earlier node's item, such as
`{{ $json.number }}` from a database row, and the JSON field takes that row's list the same way:
`"lines": {{ JSON.stringify($json.lines) }}`.

## Example: react to a finished render

Activate a workflow that starts with **Formfeed Trigger** (events `render.completed` and
`render.failed`). Every render of the workspace starts it, the ones the Formfeed node queues with
**Mode** _Queue and Return Immediately_ included. Formfeed calls the workflow's production webhook
URL, which has to be public HTTPS (n8n Cloud's is; a self-hosted n8n sets `WEBHOOK_URL`). Each event
arrives as one item (shortened here; `data` is the render as the Formfeed node returns it):

```json
{
  "id": "evt_5b0c8e6f2d4a4c3e9b1a7f6e5d4c3b2a",
  "type": "render.completed",
  "created_at": "2026-09-11T10:00:00Z",
  "workspace_id": "3a6f…",
  "data": {
    "id": "rnd_01J8ZK4M3Q7X",
    "status": "succeeded",
    "output": "pdf",
    "download_url": "https://cdn.formfeed.dev/o/eu/…",
    "page_count": 1,
    "template": {
      "id": "tpl_01J8ZK4M3Q",
      "slug": "invoice-de",
      "version": 1,
      "channel": "published",
      "canary": false
    },
    "error": null
  }
}
```

An **If** node on `{{ $json.type }}` separates the failures, whose `data.error` holds the
[problem](https://docs.formfeed.dev/api/errors) with its `code` and `detail`. For a success, an
**HTTP Request** node fetches `{{ $json.data.download_url }}` as a file; the link is signed, so it
needs no credential.

## Development

```bash
pnpm nx bundle n8n-nodes-formfeed   # compiles to dist/packages/n8n-nodes-formfeed
pnpm nx smoke n8n-nodes-formfeed    # loads the compiled nodes the way n8n does
pnpm nx test n8n-nodes-formfeed     # unit tests of the request and schema helpers
```

To try it in a local n8n: `npm link` the built folder into `~/.n8n/nodes`, or copy it there.
