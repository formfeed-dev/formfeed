package formfeed

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Version is the release of this SDK, the one every Formfeed SDK and package shares. The module's
// tags carry it (v0.3.x), and the User-Agent names its major and minor number.
const Version = "0.3.31"

const (
	userAgent      = "formfeed-sdk-go/0.3"
	defaultTimeout = 120 * time.Second
)

var hosts = map[string]string{
	"eu": "https://api-eu.formfeed.dev/v1",
	"us": "https://api-us.formfeed.dev/v1",
}

// Client is the Formfeed API. Make one with NewClient and share it: it is safe for concurrent use.
type Client struct {
	// Renders creates, reads, waits for and downloads renders, and queues batches.
	Renders *RendersService
	// Jobs reads batches and waits for them.
	Jobs *JobsService
	// PDF holds the tools for existing PDFs and the conversion of office documents.
	PDF *PDFService
	// Einvoices says which rules an e-invoice passed.
	Einvoices *EinvoicesService
	// Files is the workspace's file library.
	Files *FilesService
	// Templates reads and checks the workspace's templates.
	Templates *TemplatesService
	// Webhooks manages the workspace's webhook endpoints. Verify a delivery with [Webhook].
	Webhooks *WebhooksService
	// Account reads the key's account and the usage of a billing period.
	Account *AccountService

	t *transport
}

// Option configures a Client.
type Option func(*clientConfig)

type clientConfig struct {
	region     string
	baseURL    string
	httpClient *http.Client
	maxRetries int
	timeout    time.Duration
	headers    [][2]string
	sleep      func(context.Context, time.Duration) error
	jitter     func() time.Duration
}

// WithRegion picks the API host: "eu" (the default) or "us". Ignored when WithBaseURL is given.
func WithRegion(region string) Option {
	return func(c *clientConfig) { c.region = region }
}

// WithBaseURL sets the full base URL with /v1, for a local or another gateway
// (http://localhost:8787/v1).
func WithBaseURL(baseURL string) Option {
	return func(c *clientConfig) { c.baseURL = baseURL }
}

// WithHTTPClient sends over your own client, with its own transport and time limits; WithTimeout
// then has no effect.
func WithHTTPClient(client *http.Client) Option {
	return func(c *clientConfig) { c.httpClient = client }
}

// WithMaxRetries sets how often a call is retried on 429, 503 and network errors: 3 by default, 0
// turns retries off.
func WithMaxRetries(n int) Option {
	return func(c *clientConfig) { c.maxRetries = max(0, n) }
}

// WithTimeout limits every request of the client the SDK makes itself, the download of its body
// included: 120 seconds by default; 0 sets no limit.
func WithTimeout(d time.Duration) Option {
	return func(c *clientConfig) { c.timeout = max(0, d) }
}

// WithHeader sends a header with every request, after the SDK's own, which it replaces.
func WithHeader(name, value string) Option {
	return func(c *clientConfig) { c.headers = append(c.headers, [2]string{name, value}) }
}

// WithSleep replaces how the client waits between retries and polls. The function must return
// ctx.Err() at once when ctx ends; tests pass one that records the waits and returns nil.
func WithSleep(sleep func(ctx context.Context, d time.Duration) error) Option {
	return func(c *clientConfig) { c.sleep = sleep }
}

// WithJitter replaces the random part of a retry's wait, from 0 to 250 ms (a value outside that is
// held to it). Tests pass a constant.
func WithJitter(jitter func() time.Duration) Option {
	return func(c *clientConfig) { c.jitter = jitter }
}

// NewClient makes a client for the key, ff_live_… or ff_test_…:
//
//	client := formfeed.NewClient(os.Getenv("FORMFEED_API_KEY"))
//
// A client without a key, or with an unknown region, answers every call with an *Error of code
// invalid_request and sends nothing.
func NewClient(apiKey string, opts ...Option) *Client {
	cfg := clientConfig{region: "eu", maxRetries: 3, timeout: defaultTimeout}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	t := &transport{
		apiKey:     apiKey,
		http:       cfg.httpClient,
		maxRetries: cfg.maxRetries,
		headers:    cfg.headers,
		sleep:      cfg.sleep,
		jitter:     cfg.jitter,
	}
	if t.http == nil {
		t.http = &http.Client{Timeout: cfg.timeout}
	}
	if t.sleep == nil {
		t.sleep = sleep
	}
	if t.jitter == nil {
		t.jitter = randomJitter
	}
	host := cfg.baseURL
	if apiKey == "" {
		t.err = &Error{Code: "invalid_request", Message: "apiKey is required"}
	} else if host == "" {
		var known bool
		if host, known = hosts[cfg.region]; !known {
			t.err = &Error{
				Code:    "invalid_request",
				Message: fmt.Sprintf("unknown region %s: eu or us, or a base URL", cfg.region),
			}
		}
	}
	t.baseURL = strings.TrimRight(host, "/")

	return &Client{
		Renders:   &RendersService{t: t},
		Jobs:      &JobsService{t: t},
		PDF:       &PDFService{t: t},
		Einvoices: &EinvoicesService{t: t},
		Files:     &FilesService{t: t},
		Templates: &TemplatesService{t: t},
		Webhooks:  &WebhooksService{t: t},
		Account:   &AccountService{t: t},
		t:         t,
	}
}

// Request calls any operation of the API with the client's key, retries and errors, for one without
// a method here (template authoring, channels, shared partials, the brand kit). path is relative to
// the base URL and carries its query (/templates/invoice/versions?limit=5); body, when not nil, is
// sent as JSON; the answer is decoded into out, a pointer, when out is not nil and the answer has a
// body. No Idempotency-Key is sent unless you pass one.
//
//	var brand map[string]any
//	err := client.Request(ctx, http.MethodGet, "/brand", nil, &brand)
func (c *Client) Request(ctx context.Context, method, path string, body, out any, opts ...CallOption) error {
	var p *payload
	if body != nil {
		var err error
		if p, err = jsonPayload(body); err != nil {
			return err
		}
	}
	return c.t.json(ctx, method, path, p, idempotencyKey(opts, false), out)
}

// CallOption configures one call.
type CallOption func(*callConfig)

type callConfig struct {
	idempotencyKey string
}

// WithIdempotencyKey sends your own Idempotency-Key, an order number for instance, instead of the
// one the SDK generates for every call that creates a render. A retry of the call, by the SDK or by
// you with the same key, then cannot charge twice: the API answers the first render again.
func WithIdempotencyKey(key string) CallOption {
	return func(c *callConfig) { c.idempotencyKey = key }
}

// idempotencyKey is the key a call sends: the one passed, else a fresh one where generate says so.
func idempotencyKey(opts []CallOption, generate bool) string {
	var cfg callConfig
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	if cfg.idempotencyKey == "" && generate {
		return newKey()
	}
	return cfg.idempotencyKey
}

// WaitOption configures RendersService.WaitFor and JobsService.WaitFor.
type WaitOption func(*waitConfig)

type waitConfig struct {
	timeout  time.Duration
	interval time.Duration
}

// WithWaitTimeout sets how long WaitFor polls before it answers an *Error of code timeout: 120
// seconds for a render, 600 for a job. The context's own deadline ends it earlier.
func WithWaitTimeout(d time.Duration) WaitOption {
	return func(c *waitConfig) { c.timeout = d }
}

// WithPollInterval sets the time between two reads: 1 second for a render, 2 for a job.
func WithPollInterval(d time.Duration) WaitOption {
	return func(c *waitConfig) { c.interval = d }
}

func waitOptions(timeout, interval time.Duration, opts []WaitOption) waitConfig {
	cfg := waitConfig{timeout: timeout, interval: interval}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return cfg
}

// Ptr returns a pointer to v, for the optional fields of a request that a zero value cannot leave
// out: Dedupe: formfeed.Ptr(false), Opacity: formfeed.Ptr(0.5).
func Ptr[T any](v T) *T { return &v }
