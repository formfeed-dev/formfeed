# formfeed/laravel

[Formfeed](https://formfeed.dev/?utm_source=packagist&utm_content=laravel) for Laravel: PDFs and
images from templates, HTML, URLs or Markdown, and tools for existing PDFs. It wraps the PHP SDK,
[`formfeed/sdk`](https://packagist.org/packages/formfeed/sdk), and adds what a Laravel application
wants with it:

- the client in the container, set up from `.env`;
- the `Formfeed` facade;
- the `formfeed.webhook` middleware, which checks a delivery's signature;
- `Formfeed::fake()` for tests.

Laravel 12 or 13, PHP 8.3 or newer.

```bash
composer require formfeed/laravel
```

## Settings

```dotenv
FORMFEED_API_KEY=ff_test_...
FORMFEED_WEBHOOK_SECRET=whsec_...
```

The key comes from the app's **Keys** page. An `ff_test_` key renders without counting against the
plan, an `ff_live_` key for real. `FORMFEED_REGION` (`eu`) and `FORMFEED_BASE_URL` (another gateway)
are there when you need them. To change the retries, the time limit or the webhook tolerance,
publish the file:

```bash
php artisan vendor:publish --tag=formfeed-config
```

`php artisan about` shows whether the key and the secret arrived, never their values.

## Render a document

```php
use Formfeed\Laravel\Facades\Formfeed;
use Illuminate\Support\Facades\Storage;

$render = Formfeed::renders()->create([
    'template' => 'invoice',
    'data' => [
        'number' => 'RE-2026-0042',
        'customer' => ['name' => 'Olvarest GmbH', 'city' => 'Musterstadt'],
    ],
    'meta' => ['order_id' => $order->id],
]);

Storage::put("invoices/{$order->id}.pdf", Formfeed::renders()->download($render));
```

The facade has the SDK's services as methods: `renders()`, `jobs()`, `pdf()`, `einvoices()`,
`files()`, `templates()`, `webhooks()` and `account()`. `request()` reaches any other call of the
API. A class can also take `Formfeed\Client` in its constructor; it is the same client.

```php
use Formfeed\Client;

final class InvoiceDocuments
{
    public function __construct(private readonly Client $formfeed) {}

    public function merged(array $renders): string
    {
        return $this->formfeed->renders->download($this->formfeed->pdf->merge($renders));
    }
}
```

## Webhooks

The middleware lets a delivery through only when its `Webhook-Signature` matches the body as it
arrived, signed with `FORMFEED_WEBHOOK_SECRET` no more than five minutes from the server's clock.
Anything else gets `401`, which Formfeed retries. After it, the event is the request's JSON:

```php
// routes/api.php, so the address is /api/formfeed/webhook
Route::post('/formfeed/webhook', function (Request $request) {
    if ($request->input('type') === 'render.completed') {
        StoreDocument::dispatch($request->input('data.id'), $request->input('data.meta.order_id'));
    }

    return response()->noContent();
})->middleware('formfeed.webhook');
```

A route in `routes/web.php` also needs an exception from the CSRF check. Formfeed sends no CSRF
token. In `bootstrap/app.php`:

```php
->withMiddleware(function (Middleware $middleware): void {
    $middleware->validateCsrfTokens(except: ['formfeed/webhook']);
})
```

Answer within ten seconds, so put slow work on a queue. A delivery can arrive twice; its `id`
tells duplicates apart. During development,
`formfeed listen --forward-to http://localhost:8000/api/formfeed/webhook` forwards the events of
test renders to your machine and prints the secret to put in `.env`. The
[webhooks guide](https://docs.formfeed.dev/api/webhooks) lists the events and their retries.

## Tests

`Formfeed::fake()` swaps the client for one that never reaches the network. It answers renders,
batches, jobs and the PDF tools as the API would. A sync render is finished. An async render is
queued until it is first read. Behind every link is a real file, a PDF with the render's pages.
The fake keeps every request for the assertions:

```php
use Formfeed\Laravel\Facades\Formfeed;

public function test_an_order_gets_its_invoice(): void
{
    Formfeed::fake();

    $this->post('/orders/8812/invoice')->assertOk();

    Formfeed::assertRendered('invoice');
    Formfeed::assertRendered(fn (array $request) => $request['data']['number'] === 'RE-8812', times: 1);
    Formfeed::assertNotRendered('reminder');
}
```

Answers go by `METHOD /path`, and `*` matches anything:

```php
use Formfeed\Laravel\Testing\FormfeedFake;
use Formfeed\Laravel\Testing\FormfeedRequest;

Formfeed::fake([
    // the keys of an array replace those of the fake's own answer: a render of three pages
    'POST /renders' => ['page_count' => 3],

    // a problem, which the SDK throws as Formfeed\FormfeedException
    'POST /pdf/protect' => FormfeedFake::problem('forbidden', 403, 'PDF tools need the Starter plan'),

    // an async render that fails once it is read
    'GET /renders/*' => FormfeedFake::failed('render_timeout', 'Render exceeded 30000 ms'),

    // one answer per request, then the fake's own
    'POST /renders/batch' => FormfeedFake::sequence(FormfeedFake::problem('rate_limited', 429)),

    // per request; null leaves it to the fake
    'POST /pdf/merge' => fn (FormfeedRequest $request) => in_array('terms.pdf', $request->input('sources'), true)
        ? FormfeedFake::problem('source_not_found', 422, 'No file terms.pdf in the library')
        : null,

    // a call the fake does not answer by itself needs its answer
    'GET /account' => ['id' => 'org_1', 'name' => 'Fennlor Studio GmbH'],
]);
```

Here are the assertions:

- `assertRendered`, `assertNotRendered` and `assertNothingRendered` take a template's slug or a
  callback over the request's body.
- `assertBatched` is the same for batches.
- `assertSent`, `assertNotSent`, `assertNothingSent` and `assertSentCount` cover any call.
- `Formfeed::recorded()` returns the requests themselves.

Call `fake()` before the code under test asks the container for the client.

A webhook route is tested through its real signature check:

```php
use Formfeed\Laravel\Testing\InteractsWithFormfeedWebhooks;

final class FormfeedWebhookTest extends TestCase
{
    use InteractsWithFormfeedWebhooks;

    public function test_a_finished_render_is_stored(): void
    {
        Queue::fake();

        $this->postFormfeedWebhook('/api/formfeed/webhook', 'render.completed', [
            'id' => 'rnd_7da09ab6cd9946b798c187c2a9350852',
            'status' => 'succeeded',
            'meta' => ['order_id' => '8812'],
        ])->assertNoContent();

        Queue::assertPushed(StoreDocument::class);
    }
}
```

It signs with `FORMFEED_WEBHOOK_SECRET` at the time of Laravel's clock, so `$this->travel()` reaches
both sides.

## More

The [documentation](https://docs.formfeed.dev) describes the API, the template languages and the
PDF tools. The SDK's README describes every call. Questions go to support@formfeed.dev.

MIT licensed.
