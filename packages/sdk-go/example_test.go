package formfeed_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	formfeed "github.com/formfeed-dev/formfeed-go"
)

func ExampleNewClient() {
	// eu by default; the key decides between live and test renders
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"),
		formfeed.WithRegion("eu"),
		formfeed.WithMaxRetries(5),
	)
	_ = client
}

func ExampleRendersService_Create() {
	ctx := context.Background()
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

	render, err := client.Renders.Create(ctx, formfeed.RenderRequest{
		Template: "invoice",
		Data: map[string]any{
			"customer": map[string]any{"name": "Olvarest GmbH"},
			"total":    1428.00,
		},
	}, formfeed.WithIdempotencyKey("order-1042"))
	if err != nil {
		log.Fatal(err)
	}
	if _, err := client.Renders.DownloadFile(ctx, render, "invoice.pdf"); err != nil {
		log.Fatal(err)
	}
}

func ExampleRendersService_WaitFor() {
	ctx := context.Background()
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

	queued, err := client.Renders.Create(ctx, formfeed.RenderRequest{HTML: "<h1>Report</h1>", Mode: "async"})
	if err != nil {
		log.Fatal(err)
	}
	render, err := client.Renders.WaitFor(ctx, queued.ID, formfeed.WithWaitTimeout(2*time.Minute))
	if err != nil {
		log.Fatal(err)
	}
	if render.Status == "failed" {
		log.Fatalf("%s: %s", render.Error.Code, render.Error.Message)
	}
	pdf, err := client.Renders.Download(ctx, render)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(len(pdf), "bytes")
}

func ExampleRendersService_All() {
	ctx := context.Background()
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

	for render, err := range client.Renders.All(ctx, formfeed.RenderListOptions{Status: "failed", Since: "2026-11-01T00:00:00Z"}) {
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(render.ID, render.Error.Code)
	}
}

func ExampleRendersService_Batch() {
	ctx := context.Background()
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

	job, err := client.Renders.Batch(ctx, formfeed.BatchRequest{
		Template: "certificate",
		Items: []formfeed.RenderRequest{
			{Data: map[string]any{"name": "Max Mustermann"}},
			{Data: map[string]any{"name": "Erika Mustermann"}},
		},
		Zip: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	job, err = client.Jobs.WaitFor(ctx, job.ID)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(job.Status, job.ZipURL)
}

func ExamplePDFService_Fill() {
	ctx := context.Background()
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

	form, err := formfeed.UploadFromFile("form.pdf")
	if err != nil {
		log.Fatal(err)
	}
	info, err := client.PDF.Info(ctx, formfeed.InfoRequest{File: form})
	if err != nil {
		log.Fatal(err)
	}
	for _, field := range info.Form.Fields {
		fmt.Println(field.Name, field.Type)
	}
	filled, err := client.PDF.Fill(ctx, formfeed.FillRequest{
		File:    form,
		Fields:  map[string]any{"name": "Max Mustermann", "accepted": true},
		Flatten: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	merged, err := client.PDF.Merge(ctx, formfeed.MergeRequest{Sources: []string{filled.ID, "terms.pdf"}})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(merged.DownloadURL)
}

func ExampleWebhook_Handler() {
	hook := formfeed.Webhook{Secret: os.Getenv("FORMFEED_WEBHOOK_SECRET")}

	http.Handle("POST /webhooks/formfeed", hook.Handler(func(w http.ResponseWriter, r *http.Request, event *formfeed.WebhookEvent) {
		if event.Type == "render.completed" {
			render, err := event.Render()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			log.Println("ready:", render.ID, render.DownloadURL)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func ExampleVerifyWebhook() {
	secret := "whsec_mock_secret_123456"
	body := []byte(`{"id":"evt_1","type":"render.completed","data":{"id":"rnd_1"}}`)

	// what Formfeed sends as Webhook-Signature
	now := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(now + "."))
	mac.Write(body)
	header := "t=" + now + ",v1=" + hex.EncodeToString(mac.Sum(nil))

	fmt.Println(formfeed.VerifyWebhook(secret, header, body))
	fmt.Println(formfeed.VerifyWebhook(secret, header, []byte(`{"id":"evt_2"}`)))
	// Output:
	// true
	// false
}

func ExampleError() {
	ctx := context.Background()
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

	_, err := client.Renders.Create(ctx, formfeed.RenderRequest{Template: "invoice"})
	var ferr *formfeed.Error
	switch {
	case errors.As(err, &ferr) && ferr.Code == "quota_exceeded":
		log.Print("the period has no units left")
	case errors.As(err, &ferr):
		log.Printf("%s (%d): %s [%s]", ferr.Code, ferr.Status, ferr.Message, ferr.RequestID)
	case err != nil:
		log.Print(err) // the context ended
	}
}

func ExampleClient_Request() {
	ctx := context.Background()
	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))

	// the brand kit has no method yet; Request reaches it with the key, retries and errors
	var brand struct {
		Name   string            `json:"name"`
		Colors map[string]string `json:"colors"`
	}
	if err := client.Request(ctx, http.MethodGet, "/brand", nil, &brand); err != nil {
		log.Fatal(err)
	}
	fmt.Println(brand.Name, brand.Colors["primary"])
}
