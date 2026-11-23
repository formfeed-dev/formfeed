package formfeed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"
)

// The test vectors every Formfeed SDK reads (plan 34, decision 9), written by
// packages/api-types/src/lib/sdk-fixtures.spec.ts: webhook signatures, retries and problems,
// played through the client as a caller meets them.

func readVectors(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(repoPath(t, "api-types", "fixtures", "sdk", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("%s.json: %v", name, err)
	}
}

func TestVectorsWebhookSignatures(t *testing.T) {
	var vectors struct {
		Secret    string `json:"secret"`
		Now       int64  `json:"now"`
		Tolerance int64  `json:"tolerance_seconds"`
		Body      string `json:"body"`
		Cases     []struct {
			Name   string  `json:"name"`
			Header *string `json:"header"`
			Body   *string `json:"body"`
			Valid  bool    `json:"valid"`
		} `json:"cases"`
	}
	readVectors(t, "webhook-signatures", &vectors)
	if len(vectors.Cases) == 0 {
		t.Fatal("no cases")
	}
	hook := Webhook{
		Secret:    vectors.Secret,
		Tolerance: time.Duration(vectors.Tolerance) * time.Second,
		Now:       func() time.Time { return time.Unix(vectors.Now, 0) },
	}
	for _, c := range vectors.Cases {
		t.Run(c.Name, func(t *testing.T) {
			header, body := "", vectors.Body
			if c.Header != nil {
				header = *c.Header
			}
			if c.Body != nil {
				body = *c.Body
			}
			if got := hook.Verify(header, []byte(body)); got != c.Valid {
				t.Fatalf("Verify = %v, want %v", got, c.Valid)
			}
			_, err := hook.Parse(header, []byte(body))
			if (err == nil) != c.Valid {
				t.Fatalf("Parse: %v, want valid %v", err, c.Valid)
			}
		})
	}
}

func TestVectorsRetries(t *testing.T) {
	var vectors struct {
		MaxRetries int `json:"max_retries"`
		Cases      []struct {
			Name    string `json:"name"`
			Answers []struct {
				Status       int             `json:"status"`
				RetryAfter   *string         `json:"retry_after"`
				Body         json.RawMessage `json:"body"`
				NetworkError bool            `json:"network_error"`
			} `json:"answers"`
			WaitsMS [][2]float64 `json:"waits_ms"`
			Outcome struct {
				OK    bool `json:"ok"`
				Error *struct {
					Code   string `json:"code"`
					Status int    `json:"status"`
				} `json:"error"`
			} `json:"outcome"`
		} `json:"cases"`
	}
	readVectors(t, "retries", &vectors)
	if len(vectors.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range vectors.Cases {
		// every case at the lowest and at the highest jitter, which the bounds hold both
		for _, jitter := range []time.Duration{0, maxJitter} {
			t.Run(fmt.Sprintf("%s, jitter %v", c.Name, jitter), func(t *testing.T) {
				h := stubbed(t, func(n int, _ seen) answer {
					if n > len(c.Answers) {
						t.Fatalf("request %d, but the case has %d answers", n, len(c.Answers))
					}
					a := c.Answers[n-1]
					if a.NetworkError {
						return answer{network: true}
					}
					body := a.Body
					if len(body) == 0 {
						body = json.RawMessage(`{}`)
					}
					out := jsonAnswer(a.Status, body)
					if a.RetryAfter != nil {
						out.header.Set("Retry-After", *a.RetryAfter)
					}
					return out
				}, WithMaxRetries(vectors.MaxRetries), WithJitter(func() time.Duration { return jitter }))

				err := h.Request(context.Background(), http.MethodGet, "/account", nil, nil)

				if c.Outcome.OK {
					if err != nil {
						t.Fatalf("want success, got %v", err)
					}
				} else {
					ferr := asError(t, err)
					if ferr.Code != c.Outcome.Error.Code || ferr.Status != c.Outcome.Error.Status {
						t.Fatalf("got %s (%d), want %s (%d)", ferr.Code, ferr.Status, c.Outcome.Error.Code, c.Outcome.Error.Status)
					}
				}
				if got := len(h.sent.all()); got != len(c.Answers) {
					t.Fatalf("%d requests, want %d", got, len(c.Answers))
				}
				got := h.waits.all()
				if len(got) != len(c.WaitsMS) {
					t.Fatalf("waits %v, want %d of them", got, len(c.WaitsMS))
				}
				for i, wait := range got {
					ms := float64(wait) / float64(time.Millisecond)
					if ms < c.WaitsMS[i][0] || ms > c.WaitsMS[i][1] {
						t.Fatalf("wait %d is %v ms, want %v to %v", i, ms, c.WaitsMS[i][0], c.WaitsMS[i][1])
					}
				}
			})
		}
	}
}

func TestVectorsProblems(t *testing.T) {
	var vectors struct {
		Cases []struct {
			Name    string            `json:"name"`
			Status  int               `json:"status"`
			Headers map[string]string `json:"headers"`
			Body    json.RawMessage   `json:"body"`
			Expect  struct {
				Code      string  `json:"code"`
				Message   string  `json:"message"`
				Status    int     `json:"status"`
				RequestID *string `json:"request_id"`
			} `json:"expect"`
		} `json:"cases"`
	}
	readVectors(t, "problems", &vectors)
	if len(vectors.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range vectors.Cases {
		t.Run(c.Name, func(t *testing.T) {
			h := stubbed(t, func(int, seen) answer {
				header := http.Header{}
				for name, value := range c.Headers {
					header.Set(name, value)
				}
				var text string
				switch {
				case string(c.Body) == "null":
					return answer{status: c.Status, header: header}
				case json.Unmarshal(c.Body, &text) == nil:
					header.Set("Content-Type", "text/plain")
					return answer{status: c.Status, header: header, body: []byte(text)}
				default:
					header.Set("Content-Type", "application/json")
					return answer{status: c.Status, header: header, body: c.Body}
				}
			}, WithMaxRetries(0))

			ferr := asError(t, h.Request(context.Background(), http.MethodGet, "/account", nil, nil))

			requestID := ""
			if c.Expect.RequestID != nil {
				requestID = *c.Expect.RequestID
			}
			if ferr.Code != c.Expect.Code || ferr.Message != c.Expect.Message || ferr.Status != c.Expect.Status || ferr.RequestID != requestID {
				t.Fatalf("got %q %q %d %q, want %q %q %d %q",
					ferr.Code, ferr.Message, ferr.Status, ferr.RequestID,
					c.Expect.Code, c.Expect.Message, c.Expect.Status, requestID)
			}
		})
	}
}
