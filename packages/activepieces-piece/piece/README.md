# Formfeed for Activepieces

[Formfeed](https://formfeed.dev/?utm_source=activepieces) turns HTML templates into PDFs, images, Word and PowerPoint documents through one API. This piece renders a document from a template in any Activepieces flow, hands the file to the next step, and starts flows when a render or a batch finishes.

## Install

The piece is published on npm as `@formfeed/activepieces-piece`. On a platform that allows custom pieces, open **Platform Admin → Setup → Pieces → Install Piece**, choose npm and enter `@formfeed/activepieces-piece`.

## Connect

Create an API key at [app.formfeed.dev](https://app.formfeed.dev/keys?utm_source=activepieces) under **API keys**, with the default scopes (`render:create`, `render:read`, `template:read`, `account:read`; the connection test reads `/account`) plus `file:write` and `webhook:manage`, and paste it into the connection. A key starting with `ff_test_` renders for free (with a watermark on the Free plan), which is what you want while building a flow.

## Actions

| Action | What it does |
|---|---|
| **Create Document** | Renders a template to PDF, PNG, JPG or WebP, and a Word or PowerPoint template to DOCX, PPTX or PDF. Picking the template loads its fields. |
| **Create Document from HTML** | Renders HTML built earlier in the flow, in Jinja2, Liquid or Handlebars. |
| **Create Document from URL** | Renders a public page. |
| **Get Render** | Returns a render by its ID, with a fresh download URL. |
| **Convert Document to PDF** | Turns a Word, Excel, PowerPoint, OpenDocument or RTF file, or the render of a Word or PowerPoint template, into a PDF. Starter plan and above. |
| **Upload File** | Adds an image or PDF to the file library, where templates use it with `asset()`. |
| **Custom API Call** | Calls any other endpoint with the connection's key, for example `/pdf/merge`. |

The document actions return the render and, unless **Return the file** is off, the document as a file for the next step. A render that takes longer than a minute continues in the background; the action waits up to five minutes for it.

## Triggers

**Render Completed**, **Render Failed** and **Batch Finished** register a webhook endpoint in the workspace when the flow is turned on and remove it when it is turned off. Every delivery's signature is checked before the flow runs.

## Documentation

- [Integrations overview](https://docs.formfeed.dev/integrations/overview)
- [Rendering](https://docs.formfeed.dev/api/rendering) and [errors](https://docs.formfeed.dev/api/errors)

MIT licensed.
