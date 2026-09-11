# n8n-nodes-formfeed

n8n community node for [Formfeed](https://formfeed.dev): render PDFs and images from templates,
read template schemas, and start workflows when a render or batch finishes.

## Install

In n8n: **Settings → Community nodes → Install**, package name `n8n-nodes-formfeed`.
Self-hosted installs can also run `npm install n8n-nodes-formfeed` in the n8n user folder.

## Credentials

Create an API key in the Formfeed app (**API keys**) and paste it into the *Formfeed API*
credential. A `ff_test_` key renders for free with a watermark, which is what you want while
building a workflow. The region selects the API host; a custom base URL points at staging or a
self-hosted gateway.

## Nodes

**Formfeed**

| Resource | Operations |
|---|---|
| Render | Create (template, HTML or URL), Get, Get Many, Delete Outputs |
| Template | Get Many, Get, Get Schema |
| Job | Get |

Choosing a template loads its fields from its data schema (or its sample data), so you map named fields
(`invoice.number`) instead of pasting JSON; the JSON field covers lists and nested objects. With
*Download File* the rendered document is attached as binary data, ready for an email or an upload.

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
