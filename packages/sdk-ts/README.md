# @formfeed/sdk

The TypeScript client for the [Formfeed](https://formfeed.dev) API: generate PDFs and images from
templates. It has no dependencies and uses only Web APIs (`fetch`, Web Crypto), so it runs in Node 22+,
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
