package formfeed

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const secret = "whsec_mock_secret_123456"

func sign(t int64, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", t, body)
	return fmt.Sprintf("t=%d,v1=%s", t, hex.EncodeToString(mac.Sum(nil)))
}

const delivery = `{"id":"evt_1","type":"render.completed","created_at":"2026-11-18T10:00:00Z","workspace_id":"ws_1","data":{"id":"rnd_1","status":"succeeded","units":1}}`

func TestAReceiverHandsOnAVerifiedEvent(t *testing.T) {
	var got *WebhookEvent
	var body string
	handler := Webhook{Secret: secret}.Handler(func(w http.ResponseWriter, r *http.Request, event *WebhookEvent) {
		got = event
		data, _ := io.ReadAll(r.Body)
		body = string(data)
		w.WriteHeader(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodPost, "/webhooks/formfeed", strings.NewReader(delivery))
	req.Header.Set("Webhook-Signature", sign(time.Now().Unix(), delivery))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent || got == nil || got.Type != "render.completed" || got.ID != "evt_1" || body != delivery {
		t.Fatalf("answered %d with event %+v and body %q", rec.Code, got, body)
	}
	r, err := got.Render()
	if err != nil || r.ID != "rnd_1" || !r.Finished() || r.Units != 1 {
		t.Fatalf("the render %+v, %v", r, err)
	}
}

func TestAReceiverRefusesWhatIsNotSigned(t *testing.T) {
	called := false
	handle := func(http.ResponseWriter, *http.Request, *WebhookEvent) { called = true }
	cases := map[string]struct {
		hook   Webhook
		header string
		body   string
		status int
	}{
		"no signature":       {Webhook{Secret: secret}, "", delivery, http.StatusUnauthorized},
		"another body":       {Webhook{Secret: secret}, sign(time.Now().Unix(), delivery), delivery + " ", http.StatusUnauthorized},
		"an hour old":        {Webhook{Secret: secret}, sign(time.Now().Add(-time.Hour).Unix(), delivery), delivery, http.StatusUnauthorized},
		"no secret set":      {Webhook{}, sign(time.Now().Unix(), delivery), delivery, http.StatusInternalServerError},
		"a body that is not": {Webhook{Secret: secret}, sign(time.Now().Unix(), "[1]"), "[1]", http.StatusBadRequest},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/webhooks/formfeed", strings.NewReader(c.body))
			req.Header.Set("Webhook-Signature", c.header)
			rec := httptest.NewRecorder()

			c.hook.Handler(handle).ServeHTTP(rec, req)

			if rec.Code != c.status || called {
				t.Fatalf("answered %d, handler called %v", rec.Code, called)
			}
		})
	}
}

func TestTheToleranceAndClockAreTheReceiversToSet(t *testing.T) {
	now := time.Unix(1_795_000_000, 0)
	header := sign(now.Unix()-600, delivery)
	hook := Webhook{Secret: secret, Now: func() time.Time { return now }}

	if hook.Verify(header, []byte(delivery)) {
		t.Fatal("ten minutes passed the default tolerance")
	}
	hook.Tolerance = 15 * time.Minute
	if !hook.Verify(header, []byte(delivery)) {
		t.Fatal("ten minutes failed a tolerance of fifteen")
	}
}

func TestParseWebhookNamesWhatWentWrong(t *testing.T) {
	_, err := ParseWebhook(secret, "t=1,v1=00", []byte(delivery))
	if !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("got %v", err)
	}
	event, err := ParseWebhook(secret, sign(time.Now().Unix(), delivery), []byte(delivery))
	if err != nil || event.WorkspaceID != "ws_1" {
		t.Fatalf("got %+v, %v", event, err)
	}
	if !VerifyWebhook(secret, sign(time.Now().Unix(), delivery), []byte(delivery)) {
		t.Fatal("VerifyWebhook refused a delivery")
	}
	job, err := (&WebhookEvent{Data: []byte(`{"id":"job_1","status":"completed","items":[]}`)}).Job()
	if err != nil || job.ID != "job_1" || !job.Finished() {
		t.Fatalf("the job %+v, %v", job, err)
	}
}
