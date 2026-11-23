# formfeed-go

The Go SDK for the [Formfeed](https://formfeed.dev/?utm_source=pkg-go-dev) API:
PDFs and images from templates, HTML, URLs or Markdown, and tools for existing PDFs. Go 1.26 or
newer, and nothing but the standard library.

```bash
go get github.com/formfeed-dev/formfeed-go
```

## Render a document

```go
import formfeed "github.com/formfeed-dev/formfeed-go"

client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

render, err := client.Renders.Create(ctx, formfeed.RenderRequest{
	Template: "invoice",
	Data: map[string]any{
		"customer": map[string]any{"name": "Olvarest GmbH"},
		"total":    1428.00,
	},
})
if err != nil {
	return err
}
_, err = client.Renders.DownloadFile(ctx, render, "invoice.pdf")
```

Every call takes a `context.Context` first; when it ends, the call ends at once, a wait between
retries included. `Download` reads the file into memory, `DownloadTo` streams it into an
`io.Writer` and `DownloadFile` writes it to a path.

A render is synchronous by default, so the answer is the finished render. With `Mode: "async"` it
comes back queued, and `WaitFor` polls until it is done:

```go
queued, err := client.Renders.Create(ctx, formfeed.RenderRequest{HTML: "<h1>Report</h1>", Mode: "async"})
if err != nil {
	return err
}
render, err := client.Renders.WaitFor(ctx, queued.ID, formfeed.WithWaitTimeout(2*time.Minute))
if err != nil {
	return err
}
if render.Status == "failed" {
	return fmt.Errorf("%s: %s", render.Error.Code, render.Error.Message)
}
pdf, err := client.Renders.Download(ctx, render)
```

Every call that creates a render sends an `Idempotency-Key`, so a retry cannot charge twice; pass
`formfeed.WithIdempotencyKey("order-1042")` to tie it to your order. Lists are pages (`List`) or
iterators that follow the cursor (`All`):

```go
for render, err := range client.Renders.All(ctx, formfeed.RenderListOptions{
	Status: "failed",
	Since:  "2026-11-01T00:00:00Z",
}) {
	if err != nil {
		return err
	}
	fmt.Println(render.ID, render.Error.Code)
}
```

## Batches

Up to 1,000 renders as one job, always asynchronous; the batch's `Template` fills in what an item
leaves out, and `Zip` packs the files into one download:

```go
job, err := client.Renders.Batch(ctx, formfeed.BatchRequest{
	Template: "certificate",
	Items: []formfeed.RenderRequest{
		{Data: map[string]any{"name": "Max Mustermann"}},
		{Data: map[string]any{"name": "Erika Mustermann"}},
	},
	Zip: true,
})
if err != nil {
	return err
}
job, err = client.Jobs.WaitFor(ctx, job.ID)
// job.Items are the renders in the order of the request, job.ZipURL the ZIP
```

## PDF tools

On a render, a file of the library, or an upload, which is never stored:

```go
form, err := formfeed.UploadFromFile("form.pdf")
if err != nil {
	return err
}
info, err := client.PDF.Info(ctx, formfeed.InfoRequest{File: form})
// info.Form.Fields name the fields Fill takes

filled, err := client.PDF.Fill(ctx, formfeed.FillRequest{
	File:    form,
	Fields:  map[string]any{"name": "Max Mustermann", "accepted": true},
	Flatten: true,
})
if err != nil {
	return err
}
merged, err := client.PDF.Merge(ctx, formfeed.MergeRequest{Sources: []string{filled.ID, "terms.pdf"}})
```

`Merge`, `Protect`, `Watermark`, `Split`, `Compress`, `ToImage`, `Redact`, `Fill`, `Convert` and
`Info`, and `client.Einvoices.Validate` for an e-invoice's rules. A tool's request names a stored
`Source` (a render id, or a library file's id or name) or carries a `File`; `UploadFromBytes` and
`UploadFromReader` make one of bytes you hold.

## Webhooks

`Handler` is a receiver for `net/http`: it verifies each delivery (HMAC-SHA256 of the body as it
arrived, at most five minutes old, compared in constant time), answers 401 to one that does not
match, and hands you the event:

```go
hook := formfeed.Webhook{Secret: os.Getenv("FORMFEED_WEBHOOK_SECRET")}

http.Handle("POST /webhooks/formfeed", hook.Handler(func(w http.ResponseWriter, r *http.Request, event *formfeed.WebhookEvent) {
	if event.Type == "render.completed" {
		render, err := event.Render()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		log.Println("ready:", render.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}))
```

Elsewhere, `formfeed.ParseWebhook(secret, header, body)` verifies and reads a delivery, and
`formfeed.VerifyWebhook` answers true or false.

## Errors and retries

Every problem the API answers is a `*formfeed.Error` with the problem's `Code` (`quota_exceeded`,
`template_not_found`, …), the detail as its `Message`, the HTTP `Status` and the `RequestID` support
asks for:

```go
_, err := client.Renders.Create(ctx, formfeed.RenderRequest{Template: "invoice", Data: data})
var ferr *formfeed.Error
if errors.As(err, &ferr) {
	log.Printf("%s (%d): %s [%s]", ferr.Code, ferr.Status, ferr.Message, ferr.RequestID)
}
```

Answers 429 and 503 and network errors are retried up to three times, waiting what `Retry-After`
says, else half a second doubling, plus up to a quarter of a second, never more than 30 seconds.
The SDK's own HTTP client waits at most 120 seconds for a request (`WithTimeout` changes it); one
you pass with `WithHTTPClient` keeps its own limits.

## Options

```go
client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"),
	formfeed.WithRegion("us"),            // eu (the default) or us
	formfeed.WithHTTPClient(yourClient), // with your own transport and time limits
	formfeed.WithMaxRetries(5),
)
```

Template authoring, release channels and shared partials have no methods here yet; `Request`
reaches any call of the API with the client's key, retries and errors:

```go
var brand map[string]any
err := client.Request(ctx, http.MethodGet, "/brand", nil, &brand)
```

The [documentation](https://docs.formfeed.dev) describes every call.

## License

MIT
