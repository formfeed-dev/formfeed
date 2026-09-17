# @formfeed/sdk

The TypeScript client for the [Formfeed](https://formfeed.dev) API: generate PDFs and images from
templates, and fill Word and PowerPoint templates. It has no dependencies and uses only Web APIs (`fetch`, Web Crypto), so it runs in Node 22+,
Deno, Bun, Cloudflare Workers and browsers.

- Retries `429` and `503` with the server's `Retry-After`.
- Sends an `Idempotency-Key` with every render, so a retried request never renders twice.
- Turns API problems into `FormfeedError` with `code`, `status` and `request_id`.
- Verifies webhook signatures.

```bash
npm install @formfeed/sdk
```

## Render a template

```ts
import { Formfeed } from '@formfeed/sdk';

const client = new Formfeed({ apiKey: process.env.FORMFEED_API_KEY!, region: 'eu' });

const render = await client.renders.create({
  template: 'invoice-de',
  data: { invoice: { number: '2026-0042', lines: [{ description: 'Consulting', qty: 8, price: 120 }] } },
});
console.log(render.download_url, render.page_count);

const pdf = await client.renders.download(render); // the bytes
```

## Async renders and batches

```ts
const queued = await client.renders.create({ template: 'invoice-de', data, mode: 'async' });
const done = await client.renders.waitFor(queued.id);

const job = await client.renders.batch({
  template: 'invoice-de',
  items: orders.map((order) => ({ data: { invoice: order } })),
  zip: true,
});
const finished = await client.jobs.waitFor(job.id);
```

## Word and PowerPoint

```ts
import { readFile } from 'node:fs/promises';

// a template is a .docx or .pptx with tags such as {{ customer.name }} in its text
await client.templates.create({
  name: 'Offer',
  slug: 'offer',
  kind: 'docx',
  engine: 'jinja2',
  file: { data: await readFile('offer.docx'), name: 'offer.docx' },
  publish: true,
});

const filled = await client.renders.create({ template: 'offer', output: 'docx', data }); // or output: 'pdf'

// a new version with a new document; without `file` the latest document is kept
await client.templates.versions.create('offer', { file: { data: await readFile('offer-v2.docx'), name: 'offer.docx' } });
const docx = await client.templates.versions.file('offer', 'latest'); // the document's bytes

// any office document to PDF (Word, Excel, PowerPoint, OpenDocument, RTF)
const pdf = await client.pdf.convert({ file: { data: await readFile('report.xlsx'), name: 'report.xlsx' } }, { single_page_sheets: true });
```

## Webhooks

```ts
import { parseWebhookEvent } from '@formfeed/sdk';

// pass the raw request body, not re-serialised JSON; throws when the signature does not match
const event = await parseWebhookEvent(secret, request.headers.get('webhook-signature'), rawBody);
if (event.type === 'render.completed') console.log(event.data); // the render object
```

## Documentation

- [TypeScript SDK guide](https://docs.formfeed.dev/api/sdks/typescript)
- [API reference](https://docs.formfeed.dev/api/overview)

## Licence

MIT
