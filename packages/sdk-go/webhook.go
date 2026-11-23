package formfeed

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultWebhookTolerance is how far a delivery's timestamp may lie from now, either way.
const DefaultWebhookTolerance = 300 * time.Second

// maxWebhookBody bounds what Handler reads of a delivery; a job's events carry all of its renders.
const maxWebhookBody = 32 << 20

// ErrInvalidSignature is what Webhook.Parse answers for a delivery whose signature does not match.
var ErrInvalidSignature = errors.New("formfeed: invalid webhook signature")

// Webhook checks deliveries signed with an endpoint's secret: the header
// Webhook-Signature: t=<unix>,v1=<hex> is the HMAC-SHA256 of "<t>.<raw body>" with the secret, at
// most Tolerance either way from now, compared in constant time. Pass the body exactly as it
// arrived: the signature covers the bytes on the wire.
//
//	hook := formfeed.Webhook{Secret: os.Getenv("FORMFEED_WEBHOOK_SECRET")}
//	event, err := hook.Parse(r.Header.Get("Webhook-Signature"), body)
type Webhook struct {
	// Secret is the endpoint's signing secret, whsec_….
	Secret string
	// Tolerance is how old (or how far ahead) a delivery may be, in whole seconds;
	// DefaultWebhookTolerance when 0.
	Tolerance time.Duration
	// Now is the clock; time.Now when nil.
	Now func() time.Time
}

// VerifyWebhook reports whether a delivery is signed with secret, within the default tolerance.
func VerifyWebhook(secret, signatureHeader string, body []byte) bool {
	return Webhook{Secret: secret}.Verify(signatureHeader, body)
}

// ParseWebhook verifies a delivery, as VerifyWebhook does, and reads its event.
func ParseWebhook(secret, signatureHeader string, body []byte) (*WebhookEvent, error) {
	return Webhook{Secret: secret}.Parse(signatureHeader, body)
}

// Verify reports whether the delivery's signature matches. An empty header or secret never does.
func (w Webhook) Verify(signatureHeader string, body []byte) bool {
	if signatureHeader == "" || w.Secret == "" {
		return false
	}
	parts := map[string]string{}
	for _, pair := range strings.Split(signatureHeader, ",") {
		key, value, _ := strings.Cut(strings.Trim(pair, phpSpace), "=")
		parts[strings.Trim(key, phpSpace)] = strings.Trim(value, phpSpace)
	}
	t := parts["t"]
	v1 := strings.ToLower(parts["v1"])
	if !digits(t) || !lowerHex64(v1) {
		return false
	}
	timestamp, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		return false
	}
	now := time.Now
	if w.Now != nil {
		now = w.Now
	}
	tolerance := int64(DefaultWebhookTolerance / time.Second)
	if w.Tolerance > 0 {
		tolerance = int64(w.Tolerance / time.Second)
	}
	age := now().Unix() - timestamp
	if age < 0 {
		age = -age
	}
	if age > tolerance {
		return false
	}
	mac := hmac.New(sha256.New, []byte(w.Secret))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10) + "."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(v1))
}

// Parse verifies a delivery and reads its event: ErrInvalidSignature when the signature does not
// match, another error when the body is not a JSON object.
func (w Webhook) Parse(signatureHeader string, body []byte) (*WebhookEvent, error) {
	if !w.Verify(signatureHeader, body) {
		return nil, ErrInvalidSignature
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errors.New("formfeed: the webhook body is not a JSON object")
	}
	var event WebhookEvent
	if err := json.Unmarshal(trimmed, &event); err != nil {
		return nil, errors.New("formfeed: the webhook body is not a JSON object: " + err.Error())
	}
	return &event, nil
}

// Handler is a receiver: it reads each delivery, verifies it, and hands the event to handle, with
// the request's body there to read again. A delivery whose signature does not match is answered 401
// without reaching handle, which Formfeed retries; handle answers the rest, a 2xx within a few
// seconds for a delivery it took.
//
//	http.Handle("POST /webhooks/formfeed", hook.Handler(func(w http.ResponseWriter, r *http.Request, event *formfeed.WebhookEvent) {
//		if event.Type == "render.completed" { … }
//		w.WriteHeader(http.StatusNoContent)
//	}))
func (w Webhook) Handler(handle func(http.ResponseWriter, *http.Request, *WebhookEvent)) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if w.Secret == "" {
			// a server error, not a refusal: the deliveries are retried until the secret is set
			http.Error(rw, "the Formfeed webhook secret is not set", http.StatusInternalServerError)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(rw, r.Body, maxWebhookBody))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				http.Error(rw, "the delivery is too large", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(rw, "the delivery could not be read", http.StatusBadRequest)
			return
		}
		event, err := w.Parse(r.Header.Get("Webhook-Signature"), body)
		if errors.Is(err, ErrInvalidSignature) {
			http.Error(rw, "Invalid Formfeed webhook signature.", http.StatusUnauthorized)
			return
		}
		if err != nil {
			http.Error(rw, err.Error(), http.StatusBadRequest)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		handle(rw, r, event)
	})
}

// WebhookEvent is a verified delivery's event. Data is the render (render.*), the job (job.*), the
// usage (quota.*) or the delivery (storage.*) as the API writes them.
type WebhookEvent struct {
	// ID is the event id, evt_…, which WebhooksService.Resend takes.
	ID string `json:"id"`
	// Type is render.completed, render.failed, job.completed, job.failed, quota.warning,
	// quota.exceeded, storage.delivered, storage.failed or webhook.test, and takes new values.
	Type        string          `json:"type"`
	CreatedAt   string          `json:"created_at"`
	WorkspaceID string          `json:"workspace_id"`
	Data        json.RawMessage `json:"data"`
}

// Render reads Data as the render of a render.* event.
func (e *WebhookEvent) Render() (*Render, error) {
	var r Render
	if err := decodeLenient(e.Data, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Job reads Data as the job of a job.* event.
func (e *WebhookEvent) Job() (*Job, error) {
	var j Job
	if err := decodeLenient(e.Data, &j); err != nil {
		return nil, err
	}
	return &j, nil
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func lowerHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !('0' <= s[i] && s[i] <= '9' || 'a' <= s[i] && s[i] <= 'f') {
			return false
		}
	}
	return true
}
