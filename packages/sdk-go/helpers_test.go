package formfeed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// repoPath is a file or folder of the Formfeed repository around this module, given relative to
// packages/. The module is also the root of its own repository (github.com/formfeed-dev/formfeed-go),
// where none of these exist: a test that needs one skips there.
func repoPath(t *testing.T, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{".."}, parts...)...)
	if _, err := os.Stat(path); err != nil {
		t.Skipf("outside the Formfeed repository, which holds packages/%s", strings.Join(parts, "/"))
	}
	return path
}

// render is a finished render as the API answers it.
func render() map[string]any {
	return map[string]any{
		"id":           "rnd_1",
		"status":       "succeeded",
		"output":       "pdf",
		"download_url": "https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2",
		"expires_at":   "2026-12-18T10:00:00Z",
		"bytes":        5681,
		"page_count":   1,
		"units":        1,
		"region":       "eu",
		"environment":  "test",
		"template":     map[string]any{"id": "tpl_1", "slug": "invoice", "version": 3},
		"meta":         map[string]any{},
		"created_at":   "2026-11-18T10:00:00Z",
		"completed_at": "2026-11-18T10:00:01Z",
	}
}

// with is a copy of a map with some members changed.
func with(base map[string]any, changes map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(changes))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range changes {
		out[k] = v
	}
	return out
}

// seen is a request as the server or the stub received it.
type seen struct {
	Method string
	URL    string
	Path   string
	Query  string
	Header http.Header
	Body   []byte
}

func record(r *http.Request) seen {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
		r.Body.Close()
	}
	return seen{
		Method: r.Method,
		URL:    r.URL.String(),
		Path:   r.URL.EscapedPath(),
		Query:  r.URL.RawQuery,
		Header: r.Header.Clone(),
		Body:   body,
	}
}

// requests keeps what was sent, safe for the server's goroutines.
type requests struct {
	mu   sync.Mutex
	list []seen
}

func (q *requests) add(s seen) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.list = append(q.list, s)
	return len(q.list)
}

func (q *requests) all() []seen {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]seen(nil), q.list...)
}

func (q *requests) at(t *testing.T, i int) seen {
	t.Helper()
	all := q.all()
	if i >= len(all) {
		t.Fatalf("no request %d; %d were sent", i, len(all))
	}
	return all[i]
}

// waits records what the client waited instead of sleeping.
type waits struct {
	mu   sync.Mutex
	list []time.Duration
}

func (w *waits) sleep(ctx context.Context, d time.Duration) error {
	w.mu.Lock()
	w.list = append(w.list, d)
	w.mu.Unlock()
	return ctx.Err()
}

func (w *waits) all() []time.Duration {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]time.Duration(nil), w.list...)
}

// answer is what a stub or a test server answers.
type answer struct {
	status  int
	header  http.Header
	body    []byte
	network bool
}

func jsonAnswer(status int, body any, headers ...string) answer {
	data, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	h := http.Header{"Content-Type": {"application/json"}}
	for i := 0; i+1 < len(headers); i += 2 {
		h.Set(headers[i], headers[i+1])
	}
	return answer{status: status, header: h, body: data}
}

// stub is an http.RoundTripper that answers from a function: no network, no retries of Go's
// transport, every request kept.
type stub struct {
	requests
	respond func(n int, r seen) answer
}

func (s *stub) RoundTrip(r *http.Request) (*http.Response, error) {
	req := record(r)
	n := s.add(req)
	a := s.respond(n, req)
	if a.network {
		return nil, &netError{}
	}
	if a.status == 0 {
		a.status = http.StatusOK
	}
	return &http.Response{
		StatusCode:    a.status,
		Header:        a.header,
		Body:          io.NopCloser(bytes.NewReader(a.body)),
		ContentLength: int64(len(a.body)),
		Request:       r,
	}, nil
}

type netError struct{}

func (*netError) Error() string { return "connection refused" }

// harness is a client that sends to a stub or a test server and records its waits.
type harness struct {
	*Client
	sent  *requests
	waits *waits
	base  string
}

// stubbed is a client whose requests a stub answers, at the API's real hosts.
func stubbed(t *testing.T, respond func(n int, r seen) answer, opts ...Option) *harness {
	t.Helper()
	s := &stub{respond: respond}
	w := &waits{}
	base := []Option{
		WithHTTPClient(&http.Client{Transport: s}),
		WithSleep(w.sleep),
		WithJitter(func() time.Duration { return 0 }),
	}
	return &harness{Client: NewClient("ff_test_k", append(base, opts...)...), sent: &s.requests, waits: w}
}

// served is a client of a real HTTP server on localhost, which answers from respond.
func served(t *testing.T, respond func(n int, r seen) answer, opts ...Option) *harness {
	t.Helper()
	sent := &requests{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := record(r)
		a := respond(sent.add(req), req)
		for name, values := range a.header {
			w.Header()[name] = values
		}
		if a.status == 0 {
			a.status = http.StatusOK
		}
		w.WriteHeader(a.status)
		_, _ = w.Write(a.body)
	}))
	t.Cleanup(server.Close)
	w := &waits{}
	base := []Option{
		WithBaseURL(server.URL + "/v1"),
		WithSleep(w.sleep),
		WithJitter(func() time.Duration { return 0 }),
	}
	return &harness{Client: NewClient("ff_test_k", append(base, opts...)...), sent: sent, waits: w, base: server.URL}
}

// always answers every request alike.
func always(a answer) func(int, seen) answer {
	return func(int, seen) answer { return a }
}

// part is a field of a multipart request; a file carries its name and type.
type part struct {
	FileName    string
	ContentType string
	Value       string
}

// parts reads a multipart request as the API's parser does.
func parts(t *testing.T, r seen) (map[string]part, []string) {
	t.Helper()
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		t.Fatalf("not multipart: %q", r.Header.Get("Content-Type"))
	}
	reader := multipart.NewReader(bytes.NewReader(r.Body), params["boundary"])
	out := map[string]part{}
	var order []string
	for {
		p, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("a part cannot be read: %v", err)
		}
		value, _ := io.ReadAll(p)
		out[p.FormName()] = part{FileName: p.FileName(), ContentType: p.Header.Get("Content-Type"), Value: string(value)}
		order = append(order, p.FormName())
	}
	return out, order
}

// asError is err as an *Error, found the way a caller finds it, or the test fails.
func asError(t *testing.T, err error) *Error {
	t.Helper()
	var ferr *Error
	if !errors.As(err, &ferr) {
		t.Fatalf("want an *formfeed.Error, got %T: %v", err, err)
	}
	return ferr
}
