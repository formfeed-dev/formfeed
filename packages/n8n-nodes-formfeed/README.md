# n8n-nodes-formfeed

n8n community node for [Formfeed](https://formfeed.dev/?utm_source=npm&utm_content=n8n-node): render PDFs and images from templates,
read template schemas, and start workflows when a render or batch finishes.

## Install

In n8n: **Settings → Community nodes → Install**, package name `n8n-nodes-formfeed`.
Self-hosted installs can also run `npm install n8n-nodes-formfeed` in the n8n user folder.

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
picks the operation and fills in its fields. A self-hosted n8n offers community nodes as tools only
when the instance sets `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

**Formfeed Trigger**

Registers a webhook endpoint in your workspace and starts the workflow on `render.completed`,
`render.failed`, `job.completed`, `job.failed`, `quota.warning` or `quota.exceeded`. The endpoint is
removed again when the workflow is deactivated.

## Development

```bash
pnpm nx bundle n8n-nodes-formfeed   # compiles to dist/packages/n8n-nodes-formfeed
pnpm nx smoke n8n-nodes-formfeed    # loads the compiled nodes the way n8n does
pnpm nx test n8n-nodes-formfeed     # unit tests of the request and schema helpers
```

To try it in a local n8n: `npm link` the built folder into `~/.n8n/nodes`, or copy it there.
