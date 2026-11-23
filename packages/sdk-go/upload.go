package formfeed

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Upload is a file sent with a request: a PDF for the PDF tools, an office document to convert, an
// e-invoice XML to validate, an image or PDF for the file library. It is held in memory, so that a
// retry sends the same bytes again, and sent as multipart; the API keeps only what the library
// stores.
type Upload struct {
	// Name is the file name, such as contract.pdf, which a tool's result is named after; in the
	// file library it is the library name (brand/logo.png).
	Name string
	// ContentType is sent with the bytes; when empty, the extension of Name decides. The API reads
	// the format from the bytes either way.
	ContentType string
	// Contents are the bytes.
	Contents []byte
}

// UploadFromBytes is an upload of bytes you hold.
func UploadFromBytes(name string, contents []byte) *Upload {
	return &Upload{Name: name, Contents: contents}
}

// UploadFromFile reads a file into an upload named after it.
func UploadFromFile(path string) (*Upload, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("formfeed: cannot read %s: %w", path, err)
	}
	return &Upload{Name: filepath.Base(path), Contents: contents}, nil
}

// UploadFromReader reads r to its end into an upload.
func UploadFromReader(name string, r io.Reader) (*Upload, error) {
	contents, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("formfeed: cannot read %s: %w", name, err)
	}
	return &Upload{Name: name, Contents: contents}, nil
}

func (u *Upload) fileName() string {
	if u.Name == "" {
		return "document"
	}
	return u.Name
}

func (u *Upload) contentType() string {
	if u.ContentType != "" {
		return u.ContentType
	}
	return typeOf(u.Name)
}

// typeOf is what a name says a file is.
func typeOf(name string) string {
	switch strings.ToLower(strings.TrimPrefix(filepath.Ext(name), ".")) {
	case "pdf":
		return "application/pdf"
	case "xml":
		return "application/xml"
	case "docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case "pptx":
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	case "odt":
		return "application/vnd.oasis.opendocument.text"
	case "ods":
		return "application/vnd.oasis.opendocument.spreadsheet"
	case "odp":
		return "application/vnd.oasis.opendocument.presentation"
	case "rtf":
		return "application/rtf"
	case "html", "htm":
		return "text/html"
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "svg":
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}
