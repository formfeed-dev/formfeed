package formfeed

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// multipartPayload is a multipart body the way the API reads it: the file as `file`, then the
// request's members as fields, strings as they are, booleans and numbers as text, objects and lists
// as JSON text. A null member is left out, as a form field cannot say null, but for redact's
// `fill`, whose null draws no box and goes as the text `null`.
func multipartPayload(fields []member, file *Upload) (*payload, error) {
	var random [12]byte
	_, _ = rand.Read(random[:])
	boundary := "formfeed-" + hex.EncodeToString(random[:])

	var b bytes.Buffer
	if file != nil {
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString(`Content-Disposition: form-data; name="file"; filename="` + quoted(file.fileName()) + "\"\r\n")
		b.WriteString("Content-Type: " + file.contentType() + "\r\n\r\n")
		b.Write(file.Contents)
		b.WriteString("\r\n")
	}
	for _, field := range fields {
		text, ok, err := fieldText(field)
		if err != nil {
			return nil, &Error{Code: "invalid_request", Message: "the request cannot be sent as a form: " + err.Error(), Err: err}
		}
		if !ok {
			continue
		}
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString(`Content-Disposition: form-data; name="` + quoted(field.name) + "\"\r\n\r\n")
		b.WriteString(text)
		b.WriteString("\r\n")
	}
	b.WriteString("--" + boundary + "--\r\n")
	return &payload{contentType: "multipart/form-data; boundary=" + boundary, data: b.Bytes()}, nil
}

// fieldText is a member's value as a form field, and false for a member that is left out.
func fieldText(field member) (string, bool, error) {
	value := bytes.TrimSpace(field.value)
	switch {
	case len(value) == 0:
		return "", false, nil
	case value[0] == '"':
		var s string
		err := json.Unmarshal(value, &s)
		return s, err == nil, err
	case bytes.Equal(value, []byte("null")):
		if field.name == "fill" {
			return "null", true, nil
		}
		return "", false, nil
	default:
		// true, false, a number as JSON writes it, or an object or list as compact JSON text
		return string(value), true, nil
	}
}

func quoted(value string) string {
	return strings.NewReplacer(`"`, "%22", "\r", "", "\n", "").Replace(value)
}
