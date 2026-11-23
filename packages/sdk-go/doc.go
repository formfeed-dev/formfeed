// Package formfeed is the Go client for the Formfeed API: PDFs and images from templates, HTML,
// URLs or Markdown, Word and PowerPoint documents from templates, and tools for existing PDFs.
//
// Make a client with your key and render:
//
//	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))
//
//	render, err := client.Renders.Create(ctx, formfeed.RenderRequest{
//		Template: "invoice",
//		Data:     map[string]any{"customer": map[string]any{"name": "Olvarest GmbH"}},
//	})
//	if err != nil {
//		return err
//	}
//	_, err = client.Renders.DownloadFile(ctx, render, "invoice.pdf")
//
// Every call takes a context first; a cancelled context ends the call, and any wait in it, at once.
// A render is synchronous by default; with Mode "async" it comes back queued and
// RendersService.WaitFor polls it until it is done. Lists are pages (List) or iterators that follow
// the cursor (All).
//
// # Errors and retries
//
// Every problem the API answers (RFC 9457) is an *Error, whose Code names it (quota_exceeded,
// template_not_found, …), with the problem's detail as Message, the HTTP Status and the RequestID
// support asks for:
//
//	var ferr *formfeed.Error
//	if errors.As(err, &ferr) {
//		log.Printf("%s (%d): %s [%s]", ferr.Code, ferr.Status, ferr.Message, ferr.RequestID)
//	}
//
// Answers 429 and 503 and network errors are retried up to three times, waiting what Retry-After
// says, else half a second doubling, plus up to a quarter of a second, never more than 30 seconds.
// Every call that creates a render sends an Idempotency-Key, so a retry cannot charge twice.
//
// # Webhooks
//
// [Webhook] verifies a delivery's signature and [Webhook.Handler] is a receiver for net/http.
//
// # Everything else
//
// Template authoring, release channels, shared partials and the brand kit have no methods here
// yet; [Client.Request] reaches every call of the API with the client's key, retries and errors.
// The documentation at https://docs.formfeed.dev describes every call.
package formfeed
