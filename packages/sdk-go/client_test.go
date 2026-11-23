package formfeed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

var ctx = context.Background()

func TestARenderSendsTheKeyAnIdempotencyKeyAndJSON(t *testing.T) {
	h := served(t, always(jsonAnswer(201, render())))

	r, err := h.Renders.Create(ctx, RenderRequest{Template: "invoice", Data: map[string]any{"a": 1}, Output: "pdf"})
	if err != nil {
		t.Fatal(err)
	}

	if r.ID != "rnd_1" || !r.Finished() || r.PageCount != 1 || r.Template == nil || r.Template.Slug != "invoice" || r.Template.Version != 3 {
		t.Fatalf("read %+v", r)
	}
	req := h.sent.at(t, 0)
	checks := map[string][2]string{
		"method":          {req.Method, http.MethodPost},
		"path":            {req.Path, "/v1/renders"},
		"Authorization":   {req.Header.Get("Authorization"), "Bearer ff_test_k"},
		"User-Agent":      {req.Header.Get("User-Agent"), "formfeed-sdk-go/0.3"},
		"Accept":          {req.Header.Get("Accept"), "application/json"},
		"Content-Type":    {req.Header.Get("Content-Type"), "application/json"},
		"the exact bytes": {string(req.Body), `{"template":"invoice","data":{"a":1},"output":"pdf"}`},
	}
	for name, c := range checks {
		if c[0] != c[1] {
			t.Errorf("%s: %q, want %q", name, c[0], c[1])
		}
	}
	if !uuid.MatchString(req.Header.Get("Idempotency-Key")) {
		t.Errorf("Idempotency-Key %q is no UUID", req.Header.Get("Idempotency-Key"))
	}
}

func TestEmptyDataIsSentAsAnObject(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))

	if _, err := h.Renders.Create(ctx, RenderRequest{Template: "invoice", Data: map[string]any{}}); err != nil {
		t.Fatal(err)
	}

	if got := string(h.sent.at(t, 0).Body); got != `{"template":"invoice","data":{}}` {
		t.Fatalf("sent %s", got)
	}
}

func TestHTMLIsSentAsItIsWritten(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))

	if _, err := h.Renders.Create(ctx, RenderRequest{HTML: `<h1 class="a">Fennlor & Olvarest</h1>`}); err != nil {
		t.Fatal(err)
	}

	if got := string(h.sent.at(t, 0).Body); got != `{"html":"<h1 class=\"a\">Fennlor & Olvarest</h1>"}` {
		t.Fatalf("sent %s", got)
	}
}

func TestExtraLaysMembersOverTheRequest(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))

	_, err := h.Renders.Create(ctx, RenderRequest{
		Template: "invoice",
		Dedupe:   Ptr(false),
		Extra:    map[string]any{"template": "offer", "zeta": nil, "alpha": []int{1}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if got := string(h.sent.at(t, 0).Body); got != `{"template":"offer","dedupe":false,"alpha":[1],"zeta":null}` {
		t.Fatalf("sent %s", got)
	}
}

func TestABatchSendsItsItemsAndAKey(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(202, map[string]any{"id": "job_1", "status": "queued", "total": 2, "items": []any{}})))

	job, err := h.Renders.Batch(ctx, BatchRequest{
		Template: "invoice",
		Items:    []RenderRequest{{Data: map[string]any{"n": 1}}, {Data: map[string]any{"n": 2}, Filename: "two"}},
		Zip:      true,
	})
	if err != nil {
		t.Fatal(err)
	}

	if job.ID != "job_1" || job.Finished() {
		t.Fatalf("read %+v", job)
	}
	req := h.sent.at(t, 0)
	if req.URL != "https://api-eu.formfeed.dev/v1/renders/batch" || !uuid.MatchString(req.Header.Get("Idempotency-Key")) {
		t.Fatalf("sent to %s with key %q", req.URL, req.Header.Get("Idempotency-Key"))
	}
	if got := string(req.Body); got != `{"template":"invoice","items":[{"data":{"n":1}},{"data":{"n":2},"filename":"two"}],"zip":true}` {
		t.Fatalf("sent %s", got)
	}
}

func TestAGivenIdempotencyKeyIsSentAsItIs(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))

	if _, err := h.Renders.Create(ctx, RenderRequest{HTML: "<p>x</p>"}, WithIdempotencyKey("order-1234")); err != nil {
		t.Fatal(err)
	}

	if got := h.sent.at(t, 0).Header.Get("Idempotency-Key"); got != "order-1234" {
		t.Fatalf("Idempotency-Key %q", got)
	}
}

func TestTheRegionOrABaseURLNamesTheHost(t *testing.T) {
	cases := map[string]struct {
		opts []Option
		want string
	}{
		"eu by default":           {nil, "https://api-eu.formfeed.dev/v1/renders/rnd_1"},
		"us":                      {[]Option{WithRegion("us")}, "https://api-us.formfeed.dev/v1/renders/rnd_1"},
		"a base URL":              {[]Option{WithBaseURL("http://localhost:8787/v1/")}, "http://localhost:8787/v1/renders/rnd_1"},
		"a base URL over regions": {[]Option{WithRegion("ap"), WithBaseURL("http://localhost:8787/v1")}, "http://localhost:8787/v1/renders/rnd_1"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			h := stubbed(t, always(jsonAnswer(200, render())), c.opts...)
			if _, err := h.Renders.Get(ctx, "rnd_1"); err != nil {
				t.Fatal(err)
			}
			if got := h.sent.at(t, 0).URL; got != c.want {
				t.Fatalf("sent to %s", got)
			}
		})
	}
}

func TestAMissingKeyOrAnUnknownRegionIsRefused(t *testing.T) {
	sent := 0
	transport := &stub{respond: func(int, seen) answer { sent++; return jsonAnswer(200, render()) }}
	cases := map[string]struct {
		client *Client
		want   string
	}{
		"no key":         {NewClient("", WithHTTPClient(&http.Client{Transport: transport})), "apiKey is required"},
		"unknown region": {NewClient("ff_test_k", WithRegion("ap"), WithHTTPClient(&http.Client{Transport: transport})), "unknown region ap"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := c.client.Renders.Get(ctx, "rnd_1")
			ferr := asError(t, err)
			if ferr.Code != "invalid_request" || !strings.Contains(ferr.Message, c.want) {
				t.Fatalf("got %v", ferr)
			}
			if _, err := c.client.Renders.Download(ctx, &Render{ID: "rnd_1", DownloadURL: "https://cdn.formfeed.test/o/x.pdf"}); asError(t, err).Code != "invalid_request" {
				t.Fatalf("a download got %v", err)
			}
		})
	}
	if sent != 0 {
		t.Fatalf("%d requests were sent", sent)
	}
}

func TestAProblemBecomesOneError(t *testing.T) {
	h := served(t, always(jsonAnswer(402, map[string]any{
		"type":   "https://docs.formfeed.dev/errors/quota-exceeded",
		"title":  "Quota exceeded",
		"status": 402,
		"detail": "The period has no units left.",
		"code":   "quota_exceeded",
	}, "X-Request-Id", "req_9")))

	_, err := h.Renders.Create(ctx, RenderRequest{Template: "invoice"})

	var ferr *Error
	if !errors.As(err, &ferr) {
		t.Fatalf("errors.As finds no *Error in %T", err)
	}
	if ferr.Code != "quota_exceeded" || ferr.Message != "The period has no units left." || ferr.Status != 402 || ferr.RequestID != "req_9" {
		t.Fatalf("got %+v", ferr)
	}
	if ferr.Problem == nil || ferr.Problem.Title != "Quota exceeded" || ferr.Problem.Status != 402 || ferr.Problem.Members["type"] != "https://docs.formfeed.dev/errors/quota-exceeded" {
		t.Fatalf("problem %+v", ferr.Problem)
	}
	if got := err.Error(); got != "formfeed: quota_exceeded (HTTP 402): The period has no units left. [request req_9]" {
		t.Fatalf("Error() = %q", got)
	}
	if len(h.sent.all()) != 1 {
		t.Fatal("a 402 was retried")
	}
}

func TestAFailedRenderNamesItselfInItsProblem(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(422, map[string]any{
		"code":      "template_runtime_error",
		"detail":    "total is undefined",
		"render_id": "rnd_7",
		"errors":    []any{map[string]any{"line": 3}},
	})))

	_, err := h.Renders.Create(ctx, RenderRequest{Template: "invoice"})

	ferr := asError(t, err)
	if ferr.Problem.RenderID != "rnd_7" || ferr.Problem.Members["errors"] == nil {
		t.Fatalf("problem %+v", ferr.Problem)
	}
}

func TestARetrySendsTheSameIdempotencyKey(t *testing.T) {
	h := served(t, func(n int, _ seen) answer {
		if n == 1 {
			return jsonAnswer(429, map[string]any{"code": "rate_limited"}, "Retry-After", "1")
		}
		return jsonAnswer(201, render())
	}, WithJitter(func() time.Duration { return 250 * time.Millisecond }))

	if _, err := h.Renders.Create(ctx, RenderRequest{Template: "invoice"}); err != nil {
		t.Fatal(err)
	}

	sent := h.sent.all()
	if len(sent) != 2 {
		t.Fatalf("%d requests", len(sent))
	}
	if a, b := sent[0].Header.Get("Idempotency-Key"), sent[1].Header.Get("Idempotency-Key"); a == "" || a != b {
		t.Fatalf("keys %q and %q", a, b)
	}
	if !bytes.Equal(sent[0].Body, sent[1].Body) {
		t.Fatal("the retry sent other bytes")
	}
	if got := h.waits.all(); !reflect.DeepEqual(got, []time.Duration{1250 * time.Millisecond}) {
		t.Fatalf("waits %v", got)
	}
}

func TestAPOSTOfANetworkErrorIsRetriedAndThenReported(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	address := server.URL
	server.Close() // nothing listens there any more
	w := &waits{}
	client := NewClient("ff_test_k", WithBaseURL(address+"/v1"), WithSleep(w.sleep), WithJitter(func() time.Duration { return 0 }))

	_, err := client.Renders.Create(ctx, RenderRequest{Template: "invoice"})

	ferr := asError(t, err)
	if ferr.Code != "network_error" || ferr.Status != 0 {
		t.Fatalf("got %v", ferr)
	}
	var urlErr *url.Error
	if !errors.As(err, &urlErr) {
		t.Fatalf("the cause %T is not the transport's", ferr.Err)
	}
	if got := w.all(); !reflect.DeepEqual(got, []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second}) {
		t.Fatalf("waits %v", got)
	}
}

func TestTheClientWaitsAtMostItsTimeout(t *testing.T) {
	if got := NewClient("ff_test_k").t.http.Timeout; got != 120*time.Second {
		t.Fatalf("the default time limit is %v", got)
	}
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	client := NewClient("ff_test_k", WithBaseURL(server.URL+"/v1"), WithTimeout(50*time.Millisecond), WithMaxRetries(0))

	_, err := client.Renders.Get(ctx, "rnd_1")

	if ferr := asError(t, err); ferr.Code != "network_error" {
		t.Fatalf("got %v", ferr)
	}
}

func TestACancelledContextEndsAWaitAtOnce(t *testing.T) {
	sent := &requests{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent.add(record(r))
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	// the client's own sleep, not a test's
	client := NewClient("ff_test_k", WithBaseURL(server.URL+"/v1"))
	cancelled, cancel := context.WithCancel(ctx)
	time.AfterFunc(50*time.Millisecond, cancel)

	started := time.Now()
	_, err := client.Renders.Get(cancelled, "rnd_1")

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the call took %v", elapsed)
	}
	if len(sent.all()) != 1 {
		t.Fatalf("%d requests", len(sent.all()))
	}
}

func TestADeadlineEndsWaitFor(t *testing.T) {
	h := served(t, always(jsonAnswer(200, map[string]any{"id": "rnd_1", "status": "queued"})), WithSleep(sleep))
	short, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()

	_, err := h.Renders.WaitFor(short, "rnd_1", WithPollInterval(20*time.Millisecond))

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
}

func TestWaitForPollsUntilTheRenderIsFinished(t *testing.T) {
	h := stubbed(t, func(n int, _ seen) answer {
		if n < 3 {
			return jsonAnswer(200, map[string]any{"id": "rnd_1", "status": "rendering"})
		}
		return jsonAnswer(200, render())
	})

	r, err := h.Renders.WaitFor(ctx, "rnd_1")
	if err != nil {
		t.Fatal(err)
	}

	if r.Status != "succeeded" || len(h.sent.all()) != 3 {
		t.Fatalf("%s after %d requests", r.Status, len(h.sent.all()))
	}
	if got := h.waits.all(); !reflect.DeepEqual(got, []time.Duration{time.Second, time.Second}) {
		t.Fatalf("waits %v", got)
	}
}

func TestWaitForEndsAtItsTimeout(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(200, map[string]any{"id": "rnd_1", "status": "queued"})))

	_, err := h.Renders.WaitFor(ctx, "rnd_1", WithWaitTimeout(3*time.Second), WithPollInterval(time.Second))

	if ferr := asError(t, err); ferr.Code != "timeout" {
		t.Fatalf("got %v", ferr)
	}
	if got := h.waits.all(); !reflect.DeepEqual(got, []time.Duration{time.Second, time.Second, time.Second}) {
		t.Fatalf("waits %v", got)
	}
	if got := len(h.sent.all()); got != 4 {
		t.Fatalf("%d requests", got)
	}
}

func TestAJobIsPolledEveryTwoSeconds(t *testing.T) {
	h := stubbed(t, func(n int, _ seen) answer {
		status := "processing"
		if n == 2 {
			status = "partially_failed"
		}
		return jsonAnswer(200, map[string]any{"id": "job_1", "status": status, "total": 1, "items": []any{render()}})
	})

	job, err := h.Jobs.WaitFor(ctx, "job_1")
	if err != nil {
		t.Fatal(err)
	}

	if job.Status != "partially_failed" || len(job.Items) != 1 || job.Items[0].ID != "rnd_1" {
		t.Fatalf("read %+v", job)
	}
	if h.sent.at(t, 0).URL != "https://api-eu.formfeed.dev/v1/jobs/job_1" {
		t.Fatalf("sent to %s", h.sent.at(t, 0).URL)
	}
	if got := h.waits.all(); !reflect.DeepEqual(got, []time.Duration{2 * time.Second}) {
		t.Fatalf("waits %v", got)
	}
}

func TestADownloadFollowsTheSignedLinkWithoutTheKey(t *testing.T) {
	h := served(t, func(_ int, r seen) answer {
		if r.Path != "/o/x.pdf" {
			return answer{status: 404}
		}
		return answer{status: 200, header: http.Header{"Content-Type": {"application/pdf"}}, body: []byte("%PDF-1.7")}
	})
	r := &Render{ID: "rnd_1", Status: "succeeded", DownloadURL: h.base + "/o/x.pdf?exp=1&sig=2"}

	data, err := h.Renders.Download(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	n, err := h.Renders.DownloadTo(ctx, r, &buf)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "invoice.pdf")
	if _, err := h.Renders.DownloadFile(ctx, r, path); err != nil {
		t.Fatal(err)
	}
	onDisk, _ := os.ReadFile(path)

	if string(data) != "%PDF-1.7" || buf.String() != "%PDF-1.7" || n != 8 || string(onDisk) != "%PDF-1.7" {
		t.Fatalf("downloaded %q, %q (%d), %q", data, buf.String(), n, onDisk)
	}
	req := h.sent.at(t, 0)
	if req.Query != "exp=1&sig=2" || req.Header.Get("Authorization") != "" {
		t.Fatalf("asked %s?%s with Authorization %q", req.Path, req.Query, req.Header.Get("Authorization"))
	}
}

func TestAFailedDownloadLeavesNoFile(t *testing.T) {
	h := served(t, always(answer{status: 404}))
	path := filepath.Join(t.TempDir(), "invoice.pdf")

	_, err := h.Renders.DownloadFile(ctx, &Render{ID: "rnd_1", DownloadURL: h.base + "/o/gone.pdf"}, path)

	if ferr := asError(t, err); ferr.Code != "download_failed" || ferr.Status != 404 {
		t.Fatalf("got %v", ferr)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the file is still there: %v", err)
	}
	if len(h.sent.all()) != 1 {
		t.Fatal("a download was retried")
	}
}

func TestARenderWithoutOutputIsNotReady(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(200, render())))

	_, err := h.Renders.Download(ctx, &Render{ID: "rnd_2", Status: "queued"})

	if ferr := asError(t, err); ferr.Code != "not_ready" || ferr.Message != "render rnd_2 has no output (queued)" {
		t.Fatalf("got %v", ferr)
	}
	if len(h.sent.all()) != 0 {
		t.Fatal("a request was sent")
	}
}

func TestAllFollowsTheCursor(t *testing.T) {
	h := served(t, func(n int, _ seen) answer {
		if n == 1 {
			return jsonAnswer(200, map[string]any{"data": []any{render(), with(render(), map[string]any{"id": "rnd_2"})}, "next_cursor": "c2"})
		}
		return jsonAnswer(200, map[string]any{"data": []any{with(render(), map[string]any{"id": "rnd_3"})}, "next_cursor": nil})
	})

	var ids []string
	for r, err := range h.Renders.All(ctx, RenderListOptions{Status: "failed"}) {
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, r.ID)
	}

	if !reflect.DeepEqual(ids, []string{"rnd_1", "rnd_2", "rnd_3"}) {
		t.Fatalf("ids %v", ids)
	}
	if a, b := h.sent.at(t, 0), h.sent.at(t, 1); a.Path+"?"+a.Query != "/v1/renders?status=failed" || b.Path+"?"+b.Query != "/v1/renders?status=failed&cursor=c2" {
		t.Fatalf("asked %s?%s and %s?%s", a.Path, a.Query, b.Path, b.Query)
	}
}

func TestAllStopsWhereTheLoopDoes(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(200, map[string]any{"data": []any{render(), render()}, "next_cursor": "c2"})))

	for range h.Renders.All(ctx, RenderListOptions{}) {
		break
	}

	if got := len(h.sent.all()); got != 1 {
		t.Fatalf("%d pages were read", got)
	}
}

func TestAllEndsWithTheError(t *testing.T) {
	h := stubbed(t, func(n int, _ seen) answer {
		if n == 1 {
			return jsonAnswer(200, map[string]any{"data": []any{map[string]any{"id": "fil_1", "name": "logo.png"}}, "next_cursor": "c2"})
		}
		return jsonAnswer(500, map[string]any{"code": "internal_error"})
	})

	var names []string
	var last error
	for file, err := range h.Files.All(ctx, FileListOptions{Prefix: "brand/", Limit: 1}) {
		if err != nil {
			last = err
			break
		}
		names = append(names, file.Name)
	}

	if !reflect.DeepEqual(names, []string{"logo.png"}) || asError(t, last).Code != "internal_error" {
		t.Fatalf("names %v, error %v", names, last)
	}
	if got := h.sent.at(t, 1).URL; got != "https://api-eu.formfeed.dev/v1/files?prefix=brand%2F&limit=1&cursor=c2" {
		t.Fatalf("asked %s", got)
	}
}

func TestAnUploadGoesAsMultipartBesideTheRequest(t *testing.T) {
	h := served(t, always(jsonAnswer(201, render())))

	_, err := h.PDF.Redact(ctx, RedactRequest{
		File:    UploadFromBytes("contract.pdf", []byte("%PDF-1.7 bytes")),
		Regions: []RedactRegion{{Page: 1, X: 10, Y: 20, Width: 100, Height: 12}},
		Text:    []string{"Max Mustermann"},
		NoFill:  true,
		Extra:   map[string]any{"flatten": true},
	})
	if err != nil {
		t.Fatal(err)
	}

	req := h.sent.at(t, 0)
	if req.Path != "/v1/pdf/redact" || !uuid.MatchString(req.Header.Get("Idempotency-Key")) {
		t.Fatalf("sent to %s with key %q", req.Path, req.Header.Get("Idempotency-Key"))
	}
	got, order := parts(t, req)
	want := map[string]part{
		"file":    {FileName: "contract.pdf", ContentType: "application/pdf", Value: "%PDF-1.7 bytes"},
		"regions": {Value: `[{"page":1,"x":10,"y":20,"width":100,"height":12}]`},
		"text":    {Value: `["Max Mustermann"]`},
		"fill":    {Value: "null"},
		"flatten": {Value: "true"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parts %+v", got)
	}
	if order[0] != "file" {
		t.Fatalf("the file is not the first part: %v", order)
	}
	if !bytes.Contains(req.Body, []byte("Content-Disposition: form-data; name=\"file\"; filename=\"contract.pdf\"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7 bytes\r\n")) {
		t.Fatalf("the file part is not written as the other SDKs write it:\n%s", req.Body)
	}
}

func TestAFieldOfAnUploadNeverBreaksTheForm(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))

	_, err := h.PDF.Fill(ctx, FillRequest{
		File:      &Upload{Name: "a \"form\"\r\n.pdf", Contents: []byte("%PDF")},
		Fields:    map[string]any{"name": "Erika Mustermann", "accepted": true, "count": 2},
		Strict:    Ptr(false),
		ExpiresIn: 3600,
	})
	if err != nil {
		t.Fatal(err)
	}

	got, _ := parts(t, h.sent.at(t, 0))
	want := map[string]part{
		"file":       {FileName: "a %22form%22.pdf", ContentType: "application/pdf", Value: "%PDF"},
		"fields":     {Value: `{"accepted":true,"count":2,"name":"Erika Mustermann"}`},
		"strict":     {Value: "false"},
		"expires_in": {Value: "3600"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parts %+v", got)
	}
}

func TestASourceAndAFileTogetherAreRefused(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))

	_, err := h.PDF.Compress(ctx, CompressRequest{Source: "rnd_1", File: UploadFromBytes("a.pdf", nil)})

	if ferr := asError(t, err); ferr.Code != "invalid_request" {
		t.Fatalf("got %v", ferr)
	}
	if len(h.sent.all()) != 0 {
		t.Fatal("a request was sent")
	}
}

func TestAStoredSourceGoesAsJSON(t *testing.T) {
	h := stubbed(t, func(n int, _ seen) answer {
		if n == 1 {
			return jsonAnswer(200, map[string]any{"source": "rnd_9", "page_count": 2, "pages": []any{map[string]any{"width_pt": 595.28}}, "encrypted": false, "metadata": map[string]any{}, "form": map[string]any{"type": nil, "signed": false, "fields": []any{}}})
		}
		return jsonAnswer(201, render())
	})

	info, err := h.PDF.Info(ctx, InfoRequest{Source: "rnd_9"})
	if err != nil {
		t.Fatal(err)
	}
	r, _ := h.Renders.Get(ctx, "rnd_1")
	if _, err := h.PDF.Compress(ctx, CompressRequest{Source: r.ID, Filename: "small"}); err != nil {
		t.Fatal(err)
	}

	if info.PageCount != 2 || info.Pages[0].WidthPt != 595.28 || info.Form == nil || info.Form.Type != "" {
		t.Fatalf("read %+v", info)
	}
	first, third := h.sent.at(t, 0), h.sent.at(t, 2)
	if string(first.Body) != `{"source":"rnd_9"}` || first.Header.Get("Idempotency-Key") != "" {
		t.Fatalf("info sent %s with key %q", first.Body, first.Header.Get("Idempotency-Key"))
	}
	if string(third.Body) != `{"source":"rnd_1","filename":"small"}` || third.Header.Get("Idempotency-Key") == "" {
		t.Fatalf("compress sent %s with key %q", third.Body, third.Header.Get("Idempotency-Key"))
	}
}

func TestAMergeTakesRendersAndLibraryFiles(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))
	r := &Render{ID: "rnd_1"}

	if _, err := h.PDF.Merge(ctx, MergeRequest{Sources: []string{r.ID, "fil_2", "terms.pdf"}, Filename: "contract"}); err != nil {
		t.Fatal(err)
	}

	req := h.sent.at(t, 0)
	if string(req.Body) != `{"sources":["rnd_1","fil_2","terms.pdf"],"filename":"contract"}` || req.URL != "https://api-eu.formfeed.dev/v1/pdf/merge" {
		t.Fatalf("sent %s to %s", req.Body, req.URL)
	}
}

func TestTheOtherToolsNameTheirPaths(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(201, render())))
	upload := UploadFromBytes("offer.docx", []byte("PK"))

	calls := map[string]func() error{
		"/pdf/protect": func() error {
			_, err := h.PDF.Protect(ctx, ProtectRequest{Source: "rnd_1", UserPassword: "x", Permissions: []string{}})
			return err
		},
		"/pdf/watermark": func() error {
			_, err := h.PDF.Watermark(ctx, WatermarkRequest{Source: "rnd_1", Text: "DRAFT", Opacity: Ptr(0.0)})
			return err
		},
		"/pdf/split": func() error {
			_, err := h.PDF.Split(ctx, SplitRequest{Source: "rnd_1", Ranges: []string{"1-3", "4-"}})
			return err
		},
		"/pdf/to-image": func() error {
			_, err := h.PDF.ToImage(ctx, ToImageRequest{Source: "rnd_1", Format: "jpg", DPI: 72})
			return err
		},
		"/pdf/convert": func() error {
			_, err := h.PDF.Convert(ctx, ConvertRequest{File: upload, Landscape: true})
			return err
		},
	}
	bodies := map[string]string{
		"/pdf/protect":   `{"source":"rnd_1","user_password":"x","permissions":[]}`,
		"/pdf/watermark": `{"source":"rnd_1","text":"DRAFT","opacity":0}`,
		"/pdf/split":     `{"source":"rnd_1","ranges":["1-3","4-"]}`,
		"/pdf/to-image":  `{"source":"rnd_1","format":"jpg","dpi":72}`,
	}
	for path, call := range calls {
		t.Run(path, func(t *testing.T) {
			before := len(h.sent.all())
			if err := call(); err != nil {
				t.Fatal(err)
			}
			req := h.sent.at(t, before)
			if req.URL != "https://api-eu.formfeed.dev/v1"+path || !uuid.MatchString(req.Header.Get("Idempotency-Key")) {
				t.Fatalf("sent to %s with key %q", req.URL, req.Header.Get("Idempotency-Key"))
			}
			if want, ok := bodies[path]; ok && string(req.Body) != want {
				t.Fatalf("sent %s", req.Body)
			}
			if path == "/pdf/convert" {
				got, _ := parts(t, req)
				if got["file"].ContentType != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || got["landscape"].Value != "true" {
					t.Fatalf("parts %+v", got)
				}
			}
		})
	}
}

func TestALibraryUploadNamesTheFile(t *testing.T) {
	h := served(t, always(jsonAnswer(201, map[string]any{"id": "fil_1", "name": "logo.png", "content_type": "image/png", "bytes": 4, "sha256": "ab", "url": "https://cdn.formfeed.test/a/logo.png", "created_at": "x", "updated_at": "y"})))
	path := filepath.Join(t.TempDir(), "logo.png")
	if err := os.WriteFile(path, []byte("\x89PNG"), 0o600); err != nil {
		t.Fatal(err)
	}
	upload, err := UploadFromFile(path)
	if err != nil {
		t.Fatal(err)
	}

	file, err := h.Files.Upload(ctx, upload)
	if err != nil {
		t.Fatal(err)
	}

	if file.ID != "fil_1" || file.Bytes != 4 {
		t.Fatalf("read %+v", file)
	}
	req := h.sent.at(t, 0)
	got, _ := parts(t, req)
	want := map[string]part{
		"file": {FileName: "logo.png", ContentType: "image/png", Value: "\x89PNG"},
		"name": {Value: "logo.png"},
	}
	if !reflect.DeepEqual(got, want) || req.Header.Get("Idempotency-Key") != "" {
		t.Fatalf("parts %+v, key %q", got, req.Header.Get("Idempotency-Key"))
	}
}

func TestAnUploadReadsAReader(t *testing.T) {
	upload, err := UploadFromReader("invoice.xml", strings.NewReader("<Invoice/>"))
	if err != nil {
		t.Fatal(err)
	}
	if string(upload.Contents) != "<Invoice/>" || upload.contentType() != "application/xml" {
		t.Fatalf("read %+v", upload)
	}
	if _, err := UploadFromFile(filepath.Join(t.TempDir(), "missing.pdf")); err == nil {
		t.Fatal("a missing file was read")
	}
}

func TestAnEinvoiceIsValidatedByItsRenderOrAnUpload(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(200, map[string]any{"id": "v_1", "result": "passed", "checks": []any{map[string]any{"kind": "rules", "name": "XRechnung", "result": "passed", "messages": []any{}}}, "validated_at": "2026-11-18T10:00:00Z", "source": map[string]any{"type": "render"}})))

	report, err := h.Einvoices.Validate(ctx, ValidateEinvoiceRequest{RenderID: "rnd_1", Rules: "xrechnung"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Einvoices.Validate(ctx, ValidateEinvoiceRequest{File: UploadFromBytes("RE-2026-0001.xml", []byte("<Invoice/>"))}); err != nil {
		t.Fatal(err)
	}

	if report.Result != "passed" || len(report.Checks) != 1 || report.Checks[0].Name != "XRechnung" || !bytes.Contains(report.Raw, []byte(`"source"`)) {
		t.Fatalf("read %+v", report)
	}
	first := h.sent.at(t, 0)
	if string(first.Body) != `{"render_id":"rnd_1","rules":"xrechnung"}` || first.Header.Get("Idempotency-Key") == "" {
		t.Fatalf("sent %s with key %q", first.Body, first.Header.Get("Idempotency-Key"))
	}
	got, _ := parts(t, h.sent.at(t, 1))
	if len(got) != 1 || got["file"].ContentType != "application/xml" {
		t.Fatalf("parts %+v", got)
	}
}

func TestADeletionAnswersNothing(t *testing.T) {
	h := served(t, always(answer{status: 204}))

	if err := h.Files.Delete(ctx, "fil_1"); err != nil {
		t.Fatal(err)
	}
	if err := h.Renders.DeleteOutputs(ctx, "rnd_1"); err != nil {
		t.Fatal(err)
	}

	if a, b := h.sent.at(t, 0), h.sent.at(t, 1); a.Method != http.MethodDelete || a.Path != "/v1/files/fil_1" || b.Path != "/v1/renders/rnd_1/outputs" {
		t.Fatalf("sent %s %s and %s", a.Method, a.Path, b.Path)
	}
}

func TestAPathSegmentStaysOneSegment(t *testing.T) {
	h := served(t, always(jsonAnswer(200, map[string]any{"id": "fil_1", "name": "brand/logo.png"})))

	if _, err := h.Files.Get(ctx, "brand/logo.png"); err != nil {
		t.Fatal(err)
	}

	if got := h.sent.at(t, 0).Path; got != "/v1/files/brand%2Flogo.png" {
		t.Fatalf("asked %s", got)
	}
}

func TestWebhookEndpointsAreManaged(t *testing.T) {
	h := stubbed(t, func(n int, r seen) answer {
		switch {
		case r.Method == http.MethodGet:
			return jsonAnswer(200, map[string]any{"data": []any{map[string]any{"id": "whk_1", "url": "https://example.test/hook", "events": []string{"render.completed"}}}})
		case strings.HasSuffix(r.Path, "/test"):
			return jsonAnswer(200, map[string]any{"queued": true})
		case strings.HasSuffix(r.Path, "/resend"):
			return jsonAnswer(201, map[string]any{"delivery_id": "d", "event_id": "evt_1", "event": "render.completed", "endpoint_id": "whk_1"})
		case r.Method == http.MethodDelete:
			return answer{status: 204}
		default:
			return jsonAnswer(200, map[string]any{"id": "whk_1", "url": "https://example.test/hook", "enabled": false, "secret": "whsec_1"})
		}
	})

	endpoints, err := h.Webhooks.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	created, _ := h.Webhooks.Create(ctx, CreateWebhookRequest{URL: "https://example.test/hook", Events: []string{"render.failed"}})
	_, _ = h.Webhooks.Update(ctx, "whk_1", UpdateWebhookRequest{Enabled: Ptr(true), ClearDescription: true})
	test, _ := h.Webhooks.Test(ctx, "whk_1")
	resend, _ := h.Webhooks.Resend(ctx, "evt_1", "whk_1")
	if err := h.Webhooks.Delete(ctx, "whk_1"); err != nil {
		t.Fatal(err)
	}

	if len(endpoints) != 1 || !reflect.DeepEqual(endpoints[0].Events, []string{"render.completed"}) || !endpoints[0].Enabled {
		t.Fatalf("listed %+v", endpoints)
	}
	if created.Secret != "whsec_1" || created.Enabled || !test.Queued || resend.DeliveryID != "d" {
		t.Fatalf("read %+v %+v %+v", created, test, resend)
	}
	want := []string{
		"GET /v1/webhooks ",
		`POST /v1/webhooks {"url":"https://example.test/hook","events":["render.failed"]}`,
		`PUT /v1/webhooks/whk_1 {"enabled":true,"description":null}`,
		"POST /v1/webhooks/whk_1/test ",
		`POST /v1/webhooks/events/evt_1/resend {"endpoint_id":"whk_1"}`,
		"DELETE /v1/webhooks/whk_1 ",
	}
	for i, w := range want {
		req := h.sent.at(t, i)
		if got := req.Method + " " + req.Path + " " + string(req.Body); got != w {
			t.Errorf("request %d: %s, want %s", i, got, w)
		}
	}
}

func TestTemplatesAreReadAndChecked(t *testing.T) {
	h := stubbed(t, func(_ int, r seen) answer {
		switch {
		case strings.HasSuffix(r.Path, "/schema"):
			return jsonAnswer(200, map[string]any{"type": "object"})
		case strings.HasSuffix(r.Path, "/validate"):
			return jsonAnswer(200, map[string]any{"ok": false, "template": map[string]any{"slug": "invoice", "version": 3}, "diagnostics": []any{map[string]any{"severity": "error", "code": "data_type", "message": "total must be a number", "path": "data.total"}}})
		case r.Path == "/v1/templates":
			return jsonAnswer(200, map[string]any{"data": []any{map[string]any{"id": "tpl_1", "slug": "invoice", "published_version": nil, "latest_version": 2}}, "next_cursor": nil})
		default:
			return jsonAnswer(200, map[string]any{"id": "tpl_1", "slug": "invoice", "tags": []string{"de"}, "published_version": 2})
		}
	})

	page, _ := h.Templates.List(ctx, TemplateListOptions{Kind: "pdf", Q: "rech nung"})
	template, _ := h.Templates.Get(ctx, "invoice")
	schema, _ := h.Templates.Schema(ctx, "invoice", "staging")
	check, err := h.Templates.Validate(ctx, "invoice", ValidateTemplateRequest{Data: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}

	if page.Data[0].PublishedVersion != 0 || page.Data[0].LatestVersion != 2 || template.PublishedVersion != 2 || schema["type"] != "object" {
		t.Fatalf("read %+v %+v %v", page, template, schema)
	}
	if check.OK || check.Template.Version != 3 || check.Diagnostics[0].Path != "data.total" {
		t.Fatalf("read %+v", check)
	}
	urls := []string{
		"https://api-eu.formfeed.dev/v1/templates?kind=pdf&q=rech%20nung",
		"https://api-eu.formfeed.dev/v1/templates/invoice",
		"https://api-eu.formfeed.dev/v1/templates/invoice/schema?version=staging",
		"https://api-eu.formfeed.dev/v1/templates/invoice/validate",
	}
	for i, u := range urls {
		if got := h.sent.at(t, i).URL; got != u {
			t.Errorf("request %d asked %s, want %s", i, got, u)
		}
	}
	if got := string(h.sent.at(t, 3).Body); got != `{"data":{}}` {
		t.Fatalf("validate sent %s", got)
	}
}

func TestTheAccountAndItsUsage(t *testing.T) {
	h := stubbed(t, func(_ int, r seen) answer {
		if r.Path == "/v1/account" {
			return jsonAnswer(200, map[string]any{"plan": map[string]any{"id": "pro"}})
		}
		return jsonAnswer(200, map[string]any{"period": "2026-11", "used": 12.5, "hard_cap_units": nil, "daily": []any{map[string]any{"date": "2026-11-02", "units": 2, "renders": 3}}})
	})

	account, _ := h.Account.Get(ctx)
	usage, err := h.Account.Usage(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Account.Usage(ctx, "2026-10"); err != nil {
		t.Fatal(err)
	}

	if account["plan"].(map[string]any)["id"] != "pro" || usage.Used != 12.5 || usage.HardCapUnits != nil || usage.Daily[0].Renders != 3 {
		t.Fatalf("read %v %+v", account, usage)
	}
	if a, b := h.sent.at(t, 1).URL, h.sent.at(t, 2).URL; a != "https://api-eu.formfeed.dev/v1/usage?period=current" || b != "https://api-eu.formfeed.dev/v1/usage?period=2026-10" {
		t.Fatalf("asked %s and %s", a, b)
	}
}

func TestRequestReachesACallWithoutAMethod(t *testing.T) {
	h := served(t, always(jsonAnswer(200, map[string]any{"name": "Fennlor Studio GmbH"})))

	var brand map[string]any
	if err := h.Request(ctx, http.MethodGet, "/brand", nil, &brand); err != nil {
		t.Fatal(err)
	}
	var version struct {
		Number int `json:"number"`
	}
	err := h.Request(ctx, http.MethodPost, "/templates/invoice/versions", map[string]any{"html": "<p/>"}, &version, WithIdempotencyKey("v-1"))
	if err != nil {
		t.Fatal(err)
	}

	if brand["name"] != "Fennlor Studio GmbH" || h.sent.at(t, 0).Path != "/v1/brand" || h.sent.at(t, 0).Header.Get("Idempotency-Key") != "" {
		t.Fatalf("read %v from %s", brand, h.sent.at(t, 0).Path)
	}
	second := h.sent.at(t, 1)
	if string(second.Body) != `{"html":"<p/>"}` || second.Header.Get("Idempotency-Key") != "v-1" || second.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("sent %s with %v", second.Body, second.Header)
	}
}

func TestHeadersOfTheClientAreSent(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(200, render())), WithHeader("X-Formfeed-Workspace", "ws_1"), WithHeader("User-Agent", "fennlor-billing/2"))

	if _, err := h.Renders.Get(ctx, "rnd_1"); err != nil {
		t.Fatal(err)
	}

	req := h.sent.at(t, 0)
	if req.Header.Get("X-Formfeed-Workspace") != "ws_1" || req.Header.Get("User-Agent") != "fennlor-billing/2" {
		t.Fatalf("sent %v", req.Header)
	}
}

func TestAnAnswerThatIsNotJSONIsReported(t *testing.T) {
	h := stubbed(t, always(answer{status: 200, header: http.Header{"Content-Type": {"text/html"}}, body: []byte("<html>")}))

	_, err := h.Renders.Get(ctx, "rnd_1")

	if ferr := asError(t, err); ferr.Code != "invalid_response" || ferr.Status != 200 {
		t.Fatalf("got %v", ferr)
	}
	if _, err := h.Account.Get(ctx); asError(t, err).Code != "invalid_response" {
		t.Fatalf("got %v", err)
	}
}

// The models read answers of a later API: members they do not know are ignored, a value of
// another type leaves its field at the zero value, and a new value of an enumeration is a string.
func TestTheModelsReadALaterAPI(t *testing.T) {
	later := with(render(), map[string]any{
		"status":    "archived",
		"units":     "1.5",
		"new_thing": map[string]any{"a": 1},
		"template":  map[string]any{"id": "tpl_1", "slug": "invoice", "version": "three"},
		"error":     map[string]any{"code": "render_timeout", "message": "took too long", "phase": "print"},
	})
	h := stubbed(t, always(jsonAnswer(200, later)))

	r, err := h.Renders.Get(ctx, "rnd_1")
	if err != nil {
		t.Fatal(err)
	}

	if r.ID != "rnd_1" || r.Status != "archived" || r.Units != 0 || r.Template.Slug != "invoice" || r.Template.Version != 0 || r.PageCount != 1 {
		t.Fatalf("read %+v", r)
	}
	if r.Error.Code != "render_timeout" || r.Error.Details["phase"] != "print" {
		t.Fatalf("error %+v", r.Error)
	}
	var kept map[string]any
	if err := json.Unmarshal(r.Raw, &kept); err != nil || kept["new_thing"] == nil {
		t.Fatalf("Raw lost the new member: %s", r.Raw)
	}
}

// One version for every package (plan 34, decision 6): the release bumps this one too.
func TestTheVersionIsTheReleasesOne(t *testing.T) {
	data, err := os.ReadFile(repoPath(t, "..", "tools", "publish", "packages.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "export const VERSION = '"+Version+"';") {
		t.Fatalf("tools/publish/packages.mjs releases another version than %s", Version)
	}
}

func TestTheUserAgentNamesTheVersion(t *testing.T) {
	parts := strings.Split(Version, ".")
	if len(parts) != 3 || userAgent != "formfeed-sdk-go/"+parts[0]+"."+parts[1] {
		t.Fatalf("User-Agent %s for version %s", userAgent, Version)
	}
}

func TestIdempotencyKeysAreFresh(t *testing.T) {
	a, b := newKey(), newKey()
	if !uuid.MatchString(a) || a == b {
		t.Fatalf("keys %s and %s", a, b)
	}
}

func TestABodyThatCannotBeJSONIsRefused(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(200, render())))

	_, err := h.Renders.Create(ctx, RenderRequest{Data: map[string]any{"f": func() {}}})

	if ferr := asError(t, err); ferr.Code != "invalid_request" {
		t.Fatalf("got %v", ferr)
	}
	if err := h.Request(ctx, http.MethodPost, "/x", make(chan int), nil); asError(t, err).Code != "invalid_request" {
		t.Fatalf("got %v", err)
	}
	if len(h.sent.all()) != 0 {
		t.Fatal("a request was sent")
	}
}

func TestRequestReportsAnAnswerThatDoesNotFit(t *testing.T) {
	h := stubbed(t, always(jsonAnswer(200, map[string]any{"number": "one"})))

	var out struct {
		Number int `json:"number"`
	}
	err := h.Request(ctx, http.MethodGet, "/x", nil, &out)

	if ferr := asError(t, err); ferr.Code != "invalid_response" {
		t.Fatalf("got %v", ferr)
	}
	var typeErr *json.UnmarshalTypeError
	if !errors.As(err, &typeErr) {
		t.Fatalf("the cause is %T", asError(t, err).Err)
	}
}

func TestADownloadThatBreaksOffIsANetworkError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		_, _ = w.Write([]byte("%PDF"))
	}))
	defer server.Close()
	client := NewClient("ff_test_k", WithBaseURL(server.URL+"/v1"))

	_, err := client.Renders.Download(ctx, &Render{ID: "rnd_1", DownloadURL: server.URL + "/o/x.pdf"})

	if ferr := asError(t, err); ferr.Code != "network_error" || !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("got %v", err)
	}
}
