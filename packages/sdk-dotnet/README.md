# Formfeed

The .NET SDK for the [Formfeed](https://formfeed.dev/?utm_source=nuget) API:
PDFs and images from templates, HTML, URLs or Markdown, and tools for existing PDFs. For .NET 10
and every platform of .NET Standard 2.0 (.NET 8 and 9, .NET Framework 4.6.2 and newer).

```bash
dotnet add package Formfeed
```

It sends over an `HttpClient` of its own, or the one you pass, so `IHttpClientFactory` works. Its
JSON is generated at build time, so it trims and runs under native AOT.

## Render a document

```csharp
using Formfeed;

using var formfeed = new FormfeedClient(Environment.GetEnvironmentVariable("FORMFEED_API_KEY"));

var render = await formfeed.Renders.CreateAsync(new RenderRequest
{
    Template = "invoice",
    Data = new Dictionary<string, object?>
    {
        ["customer"] = new Dictionary<string, object?> { ["name"] = "Olvarest GmbH" },
        ["total"] = 1428.00m,
    },
});
await formfeed.Renders.DownloadToAsync(render, "invoice.pdf");
```

`Data`, `Settings` and `Meta` are free maps: strings, numbers, booleans, nested dictionaries and
lists, `JsonNode` or `JsonElement` values. A field this SDK does not name yet goes in
`AdditionalFields`.

## Downloads and waiting

A render is synchronous by default, so the answer is the finished render. With `Mode = "async"` it
comes back queued, and `WaitForAsync` polls until it is done:

```csharp
var queued = await formfeed.Renders.CreateAsync(new RenderRequest { Html = "<h1>Report</h1>", Mode = "async" });
var done = await formfeed.Renders.WaitForAsync(queued, timeout: TimeSpan.FromMinutes(2));

byte[] pdf = await formfeed.Renders.DownloadAsync(done);
await using var file = File.Create("report.pdf");
await formfeed.Renders.DownloadToAsync(done, file);
```

Every call that creates a render sends an `Idempotency-Key`, so a retry cannot charge twice; pass
your own to tie it to your order. Lists are pages (`ListAsync`) or `IAsyncEnumerable`s that follow
the cursor (`ListAllAsync`):

```csharp
var query = new RenderListQuery { Status = "failed", Since = DateTimeOffset.UtcNow.AddDays(-7) };
await foreach (var failed in formfeed.Renders.ListAllAsync(query))
{
    Console.WriteLine($"{failed.Id} {failed.Error?.Code}");
}
```

## Batches

```csharp
var job = await formfeed.Renders.CreateBatchAsync(new BatchRequest
{
    Template = "invoice",
    Zip = true,
    Items =
    [
        new RenderRequest { Data = new Dictionary<string, object?> { ["number"] = "2026-0041" } },
        new RenderRequest { Data = new Dictionary<string, object?> { ["number"] = "2026-0042" } },
    ],
});
job = await formfeed.Jobs.WaitForAsync(job);
Console.WriteLine($"{job.Succeeded} of {job.Total}: {job.ZipUrl}");
```

## PDF tools

On a render, a file of the library (its id or its name), or an upload, which is never stored:

```csharp
var info = await formfeed.Pdf.GetInfoAsync(Upload.FromPath("form.pdf"));

var filled = await formfeed.Pdf.FillAsync(Upload.FromPath("form.pdf"), new FillOptions
{
    Fields = new Dictionary<string, object?> { ["name"] = "Max Mustermann", ["accepted"] = true },
    Flatten = true,
});
var merged = await formfeed.Pdf.MergeAsync([filled, "terms.pdf"]);
```

`MergeAsync`, `ProtectAsync`, `WatermarkAsync`, `SplitAsync`, `CompressAsync`, `ToImageAsync`,
`RedactAsync`, `FillAsync`, `ConvertAsync` and `GetInfoAsync`, and `Einvoices.ValidateAsync` for
an e-invoice's rules.

## Webhooks

`Webhook.Parse` checks the signature (HMAC-SHA256, at most five minutes old, compared in constant
time) and throws `WebhookSignatureException` when it does not match; `Webhook.Verify` answers true
or false. Pass the body as it arrived. An ASP.NET Core receiver:

```csharp
app.MapPost("/webhooks/formfeed", async (HttpRequest request) =>
{
    using var body = new MemoryStream();
    await request.Body.CopyToAsync(body);
    try
    {
        var delivery = Webhook.Parse(
            builder.Configuration["Formfeed:WebhookSecret"]!,
            request.Headers["Webhook-Signature"],
            body.ToArray());
        if (delivery.Type == "render.completed")
        {
            var render = Render.FromJson(delivery.Data);
            Console.WriteLine($"{render.Id} is ready: {render.DownloadUrl}");
        }
        return Results.NoContent();
    }
    catch (WebhookSignatureException)
    {
        return Results.Unauthorized();
    }
});
```

## Errors and retries

Every problem the API answers is a `FormfeedException` with the problem's `Code`
(`quota_exceeded`, `template_not_found`, …), the detail as its message, the HTTP `Status`, the
problem itself and the `RequestId` support asks for. 429 and 503 answers and network errors,
a time limit that runs out included, are retried up to three times, waiting what `Retry-After`
says. A call you cancel throws `OperationCanceledException`.

```csharp
try
{
    await formfeed.Renders.CreateAsync(new RenderRequest { Template = "invoice", Data = data });
}
catch (FormfeedException e)
{
    Console.Error.WriteLine($"{e.Code} ({e.Status}): {e.Message} [{e.RequestId}]");
}
```

## Options

```csharp
using var formfeed = new FormfeedClient(new FormfeedClientOptions
{
    ApiKey = Environment.GetEnvironmentVariable("FORMFEED_API_KEY")!,
    Region = "us",                      // eu (the default) or us
    MaxRetries = 5,
    Timeout = TimeSpan.FromSeconds(60), // per attempt; 120 by default
});
```

With `IHttpClientFactory`, as a typed client. Its clients wait 100 seconds, so give them more than
the SDK's 120:

```csharp
builder.Services
    .AddHttpClient("formfeed", http => http.Timeout = TimeSpan.FromSeconds(130))
    .AddTypedClient((http, services) =>
        new FormfeedClient(services.GetRequiredService<IConfiguration>()["Formfeed:ApiKey"], http));
```

In an application trimmed or compiled ahead of time, an object of your own in `Data` needs
`JsonSerializerOptions` whose resolver knows its type (your own `JsonSerializerContext`), set as
`FormfeedClientOptions.JsonSerializerOptions`; dictionaries, lists and JSON values need nothing.

Template authoring, release channels and shared partials have no methods here yet;
`RequestAsync` reaches any call of the API with the client's key, retries and errors:

```csharp
JsonElement? brand = await formfeed.RequestAsync(HttpMethod.Get, "/brand");
```

The [documentation](https://docs.formfeed.dev) describes every call.

## License

MIT
