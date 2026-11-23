package formfeed

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync/atomic"
)

// marshal writes JSON as the API reads it: compact, and without the HTML escapes of
// json.Marshal, so `<h1>` stays `<h1>` on the wire as it does in the other SDKs.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// member is one member of a JSON object, its value as written.
type member struct {
	name  string
	value json.RawMessage
}

// members reads a JSON object's members in the order they are written.
func members(data []byte) ([]member, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	open, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if open != json.Delim('{') {
		return nil, fmt.Errorf("formfeed: %s is not a JSON object", data)
	}
	var out []member
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		name, _ := key.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, member{name: name, value: value})
	}
	return out, nil
}

// withExtra marshals v, an object, with the members of extra laid over it: a member of the same
// name is replaced, a new one is added at the end, in the order of its name.
func withExtra(v any, extra map[string]any) ([]byte, error) {
	data, err := marshal(v)
	if err != nil || len(extra) == 0 {
		return data, err
	}
	fields, err := members(data)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(extra))
	for name := range extra {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		value, err := marshal(extra[name])
		if err != nil {
			return nil, err
		}
		at := slices.IndexFunc(fields, func(m member) bool { return m.name == name })
		if at >= 0 {
			fields[at].value = value
		} else {
			fields = append(fields, member{name: name, value: value})
		}
	}
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, m := range fields {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, err := marshal(m.name)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		buf.Write(m.value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// strictDecoding makes the models refuse a value of the wrong type instead of reading it as the
// zero value. Only the contract goldens' test turns it on: an answer of today must fit exactly.
var strictDecoding atomic.Bool

// decodeLenient decodes as encoding/json does, but a value of another type than the model's (a
// later API's change) leaves that field at its zero value instead of failing the whole answer.
// Unknown members are ignored anyway, so an SDK of today reads the answers of a later API.
func decodeLenient(data []byte, v any) error {
	err := json.Unmarshal(data, v)
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && !strictDecoding.Load() {
		return nil
	}
	return err
}

// isNull reports whether data is the JSON literal null, which a model's UnmarshalJSON leaves alone.
func isNull(data []byte) bool {
	return bytes.Equal(bytes.TrimSpace(data), []byte("null"))
}

// raw is a copy of data, kept beside a model as the answer the API sent.
func raw(data []byte) json.RawMessage {
	return append(json.RawMessage(nil), bytes.TrimSpace(data)...)
}
