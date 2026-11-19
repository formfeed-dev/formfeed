# formfeed/sdk

The PHP SDK for the [Formfeed](https://formfeed.dev/?utm_source=packagist&utm_content=php) API: PDFs
and images from templates, HTML, URLs or Markdown, and tools for existing PDFs. PHP 8.3 or newer.

```bash
composer require formfeed/sdk guzzlehttp/guzzle
```

It sends over any PSR-18 HTTP client, so an application keeps its own: Guzzle and Symfony's
HttpClient are picked up with a time limit of 120 seconds, any other through `php-http/discovery`.

## Render a document

```php
$formfeed = new Formfeed\Client(apiKey: getenv('FORMFEED_API_KEY'));

$render = $formfeed->renders->create([
    'template' => 'invoice',
    'data' => ['customer' => ['name' => 'Olvarest GmbH'], 'total' => 1428.00],
]);
$formfeed->renders->downloadTo($render, 'invoice.pdf');
```

A render is synchronous by default, so the answer is the finished render. With `'mode' => 'async'`
it comes back queued, and `waitFor` polls until it is done:

```php
$render = $formfeed->renders->create(['html' => '<h1>Report</h1>', 'mode' => 'async']);
$render = $formfeed->renders->waitFor($render, timeout: 120);
$pdf = $formfeed->renders->download($render);
```

Every call that creates a render sends an `Idempotency-Key`, so a retry cannot charge twice; pass
your own as the last argument to tie it to your order. Lists are pages (`list()`) or generators that
follow the cursor (`all()`):

```php
foreach ($formfeed->renders->all(['status' => 'failed', 'since' => '2026-11-01T00:00:00Z']) as $failed) {
    echo $failed->id, ' ', $failed->error['code'] ?? '', PHP_EOL;
}
```

## PDF tools

On a render, a file of the library, or an upload, which is never stored:

```php
use Formfeed\Upload;

$info = $formfeed->pdf->info(Upload::fromPath('form.pdf'));
$filled = $formfeed->pdf->fill(Upload::fromPath('form.pdf'), [
    'fields' => ['name' => 'Max Mustermann', 'accepted' => true],
    'flatten' => true,
]);
$merged = $formfeed->pdf->merge([$filled, 'terms.pdf']);
```

`merge`, `protect`, `watermark`, `split`, `compress`, `toImage`, `redact`, `fill`, `convert` and
`info`, and `einvoices->validate()` for an e-invoice's rules.

## Webhooks

```php
$event = Formfeed\Webhook::parse(
    getenv('FORMFEED_WEBHOOK_SECRET'),
    $_SERVER['HTTP_WEBHOOK_SIGNATURE'] ?? null,
    file_get_contents('php://input'),
);
```

`parse` checks the signature (HMAC-SHA256, at most five minutes old, compared in constant time) and
throws `UnexpectedValueException` when it does not match; `verify` answers true or false.

## Errors

Every problem the API answers is a `Formfeed\FormfeedException` with the problem's `errorCode`
(`quota_exceeded`, `template_not_found`, …), the detail as its message, the HTTP `status` and the
`requestId` support asks for. 429 and 503 answers and network errors are retried up to three times,
waiting what `Retry-After` says.

```php
try {
    $formfeed->renders->create(['template' => 'invoice', 'data' => $data]);
} catch (Formfeed\FormfeedException $e) {
    error_log("{$e->errorCode} ({$e->status}): {$e->getMessage()} [{$e->requestId}]");
}
```

## Options

```php
new Formfeed\Client(
    apiKey: getenv('FORMFEED_API_KEY'),
    region: 'us',                 // eu (the default) or us
    httpClient: $yourPsr18Client, // with your own time limits
    maxRetries: 5,
);
```

Template authoring, release channels and shared partials have no methods here yet;
`$formfeed->request('GET', '/brand')` reaches any call of the API with the client's key, retries and
errors. The [documentation](https://docs.formfeed.dev) describes every call.

## License

MIT
