package formfeed

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	randv2 "math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The rules every Formfeed SDK keeps (plan 34, decision 3): up to maxRetries retries on 429, 503
// and network errors, waiting a positive numeric Retry-After in seconds, else 0.5 s doubling, plus
// up to 0.25 s of jitter, at most 30 s; a problem becomes one *Error with the code, the detail
// (else the title), the status and X-Request-Id. packages/api-types/fixtures/sdk holds the cases,
// which every SDK's tests play.
const (
	maxBackoff = 30 * time.Second
	maxJitter  = 250 * time.Millisecond
)

type transport struct {
	apiKey     string
	baseURL    string
	http       *http.Client
	maxRetries int
	headers    [][2]string
	sleep      func(context.Context, time.Duration) error
	jitter     func() time.Duration
	// err is the client's configuration error, which every call answers.
	err *Error
}

// payload is a request body: JSON or multipart, the same bytes for every attempt.
type payload struct {
	contentType string
	data        []byte
}

func jsonPayload(v any) (*payload, error) {
	data, err := marshal(v)
	if err != nil {
		return nil, &Error{Code: "invalid_request", Message: "the request cannot be sent as JSON: " + err.Error(), Err: err}
	}
	return &payload{contentType: "application/json", data: data}, nil
}

// send makes the call with retries and answers the status and body of a success; a problem, a
// failure and a configuration error come back as *Error, a context that ended as ctx.Err().
func (t *transport) send(ctx context.Context, method, path string, p *payload, key string) (int, []byte, error) {
	if t.err != nil {
		e := *t.err
		return 0, nil, &e
	}
	for attempt := 0; ; attempt++ {
		var body io.Reader
		if p != nil {
			body = bytes.NewReader(p.data)
		}
		req, err := http.NewRequestWithContext(ctx, method, t.baseURL+path, body)
		if err != nil {
			return 0, nil, &Error{Code: "invalid_request", Message: err.Error(), Err: err}
		}
		req.Header.Set("Authorization", "Bearer "+t.apiKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", userAgent)
		for _, header := range t.headers {
			req.Header.Set(header[0], header[1])
		}
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		if p != nil {
			req.Header.Set("Content-Type", p.contentType)
		}

		resp, err := t.http.Do(req)
		var data []byte
		if err == nil {
			data, err = io.ReadAll(resp.Body)
			resp.Body.Close()
		}
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return 0, nil, ctxErr
			}
			if attempt < t.maxRetries {
				if err := t.wait(ctx, t.backoff(attempt+1, "")); err != nil {
					return 0, nil, err
				}
				continue
			}
			return 0, nil, &Error{Code: "network_error", Message: err.Error(), Err: err}
		}

		status := resp.StatusCode
		if (status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable) && attempt < t.maxRetries {
			if err := t.wait(ctx, t.backoff(attempt+1, resp.Header.Get("Retry-After"))); err != nil {
				return 0, nil, err
			}
			continue
		}
		if status >= 400 {
			return status, nil, problemError(status, resp.Header, data)
		}
		return status, data, nil
	}
}

// json makes the call and decodes its answer, if it has one, into out (when out is not nil).
func (t *transport) json(ctx context.Context, method, path string, p *payload, key string, out any) error {
	status, data, err := t.send(ctx, method, path, p, key)
	if err != nil {
		return err
	}
	if status == http.StatusNoContent || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if !json.Valid(data) {
		return notJSON(status)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &Error{
			Code:    "invalid_response",
			Message: fmt.Sprintf("the answer to %s %s does not fit %T: %v", method, path, out, err),
			Status:  status,
			Err:     err,
		}
	}
	return nil
}

// object makes the call and reads its answer, which must be a JSON object, into a model.
func (t *transport) object(ctx context.Context, method, path string, p *payload, key string, out any) error {
	status, data, err := t.send(ctx, method, path, p, key)
	if err != nil {
		return err
	}
	trimmed := bytes.TrimSpace(data)
	if status != http.StatusNoContent && len(trimmed) > 0 && !json.Valid(trimmed) {
		return notJSON(status)
	}
	if status == http.StatusNoContent || len(trimmed) == 0 || trimmed[0] != '{' {
		return &Error{Code: "invalid_response", Message: fmt.Sprintf("the API answered %s %s without a JSON object", method, path)}
	}
	if err := decodeLenient(trimmed, out); err != nil {
		return &Error{Code: "invalid_response", Message: err.Error(), Status: status, Err: err}
	}
	return nil
}

func notJSON(status int) *Error {
	return &Error{
		Code:    "invalid_response",
		Message: fmt.Sprintf("the API answered HTTP %d with a body that is not JSON", status),
		Status:  status,
	}
}

// download fetches a signed link of the CDN into w, without the API key, which the link does not
// need, and without retries, as every Formfeed SDK downloads.
func (t *transport) download(ctx context.Context, url string, w io.Writer) (int64, error) {
	if t.err != nil {
		e := *t.err
		return 0, &e
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, &Error{Code: "invalid_request", Message: err.Error(), Err: err}
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := t.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return 0, ctxErr
		}
		return 0, &Error{Code: "network_error", Message: err.Error(), Err: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return 0, &Error{
			Code:    "download_failed",
			Message: fmt.Sprintf("download answered HTTP %d", resp.StatusCode),
			Status:  resp.StatusCode,
		}
	}
	n, err := io.Copy(w, readErrors{resp.Body})
	var re readError
	switch {
	case err == nil:
		return n, nil
	case ctx.Err() != nil:
		return n, ctx.Err()
	case errors.As(err, &re):
		return n, &Error{Code: "network_error", Message: re.err.Error(), Err: re.err}
	default:
		return n, err
	}
}

// readErrors marks the errors of reading the answer, so download tells them from those of writing.
type readErrors struct{ r io.Reader }

type readError struct{ err error }

func (e readError) Error() string { return e.err.Error() }
func (e readError) Unwrap() error { return e.err }

func (r readErrors) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if err != nil && err != io.EOF {
		err = readError{err}
	}
	return n, err
}

// wait waits the way the client was told to, ending at once with the context.
func (t *transport) wait(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return t.sleep(ctx, d)
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func randomJitter() time.Duration {
	return time.Duration(randv2.Int64N(int64(maxJitter) + 1))
}

// backoff is the wait before retry number attempt (from 1), with the server's Retry-After.
func (t *transport) backoff(attempt int, retryAfter string) time.Duration {
	base := maxBackoff
	if attempt <= 6 {
		base = 500 * time.Millisecond << (attempt - 1)
	}
	if seconds, ok := retryAfterSeconds(retryAfter); ok {
		base = seconds
	}
	jitter := min(max(t.jitter(), 0), maxJitter)
	return min(maxBackoff, base+jitter)
}

// numeric is what PHP's is_numeric takes, the rule the other SDKs read Retry-After by: a decimal
// number, so neither an HTTP date nor a hexadecimal float.
var numeric = regexp.MustCompile(`^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$`)

func retryAfterSeconds(header string) (time.Duration, bool) {
	header = strings.Trim(header, phpSpace)
	if !numeric.MatchString(header) {
		return 0, false
	}
	value, err := strconv.ParseFloat(header, 64)
	if err != nil || value <= 0 || math.IsInf(value, 0) {
		return 0, false
	}
	if value >= maxBackoff.Seconds() {
		return maxBackoff, true
	}
	return time.Duration(value * float64(time.Second)), true
}

// phpSpace is what PHP's trim() removes, which the other SDKs' rules are written against.
const phpSpace = " \t\n\r\x00\x0B"

// problemError turns an answer of status 400 and above into the *Error a caller meets.
func problemError(status int, header http.Header, data []byte) *Error {
	var problem *Problem
	var fields map[string]any
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '{' && json.Unmarshal(trimmed, &fields) == nil && len(fields) > 0 {
		problem = &Problem{}
		if err := problem.UnmarshalJSON(trimmed); err != nil {
			problem = &Problem{Members: fields, Raw: raw(trimmed)}
		}
	}
	code, _ := fields["code"].(string)
	if code == "" {
		code = fmt.Sprintf("http_%d", status)
	}
	message, _ := fields["detail"].(string)
	if message == "" {
		message, _ = fields["title"].(string)
	}
	if message == "" {
		message = fmt.Sprintf("HTTP %d", status)
	}
	return &Error{
		Code:      code,
		Message:   message,
		Status:    status,
		Problem:   problem,
		RequestID: header.Get("X-Request-Id"),
	}
}

// newKey is a fresh Idempotency-Key, a random UUID: every call that creates a render sends one, so
// a retry cannot charge twice.
func newKey() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
