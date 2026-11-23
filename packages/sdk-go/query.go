package formfeed

import (
	"strconv"
	"strings"
)

// escape encodes a path segment or query value as RFC 3986 does (PHP's rawurlencode): everything
// but letters, digits, `-`, `_`, `.` and `~`, so `brand/logo.png` stays one segment.
func escape(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&15])
		}
	}
	return b.String()
}

// query is a query string of the values that are set, in the order they are added.
type query []string

func (q *query) add(key, value string) {
	if value != "" {
		*q = append(*q, escape(key)+"="+escape(value))
	}
}

func (q *query) addInt(key string, value int) {
	if value != 0 {
		q.add(key, strconv.Itoa(value))
	}
}

// String is `?a=1&b=2`, or empty when nothing is set.
func (q query) String() string {
	if len(q) == 0 {
		return ""
	}
	return "?" + strings.Join(q, "&")
}
