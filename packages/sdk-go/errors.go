package formfeed

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Error is every problem the API answers (RFC 9457) and every failure on this side, one type for
// all of them:
//
//	var ferr *formfeed.Error
//	if errors.As(err, &ferr) && ferr.Code == "quota_exceeded" { … }
//
// Code is the problem's code (quota_exceeded, template_not_found, …), else http_<status>; for what
// went wrong before an answer it is network_error, timeout, not_ready, download_failed,
// invalid_response or invalid_request. A cancelled or expired context is not an Error: the call
// answers ctx.Err() itself.
type Error struct {
	// Code names the problem, as the docs list it under https://docs.formfeed.dev/errors.
	Code string
	// Message is the problem's detail, else its title, else "HTTP <status>".
	Message string
	// Status is the HTTP status, 0 when there was no answer.
	Status int
	// Problem is the problem document as the API sent it; nil when the answer had none.
	Problem *Problem
	// RequestID is the X-Request-Id the API answered with, which support asks for.
	RequestID string
	// Err is the cause of a failure on this side, such as the network error; nil for a problem.
	Err error
}

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString("formfeed: ")
	b.WriteString(e.Code)
	if e.Status != 0 {
		fmt.Fprintf(&b, " (HTTP %d)", e.Status)
	}
	if e.Message != "" {
		b.WriteString(": ")
		b.WriteString(e.Message)
	}
	if e.RequestID != "" {
		b.WriteString(" [request ")
		b.WriteString(e.RequestID)
		b.WriteString("]")
	}
	return b.String()
}

// Unwrap returns the cause of a failure on this side, so errors.Is sees through a network error.
func (e *Error) Unwrap() error { return e.Err }

// Problem is an RFC 9457 problem document. Members holds every member as sent, those a problem
// adds beside the standard ones included: errors, index, feature, limit, einvoice, accessibility, …
type Problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail"`
	Code      string `json:"code"`
	RequestID string `json:"request_id"`
	// RenderID names the failed render of a problem that a render's failure answered.
	RenderID string `json:"render_id"`
	// Members is the whole document, decoded.
	Members map[string]any `json:"-"`
	// Raw is the document as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads a problem leniently, keeping every member in Members.
func (p *Problem) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain Problem
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	if err := decodeLenient(data, &v.Members); err != nil {
		return err
	}
	v.Raw = raw(data)
	*p = Problem(v)
	return nil
}
