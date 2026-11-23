package formfeed

import (
	"context"
	"encoding/json"
	"net/http"
)

// PDFService holds the tools for existing PDFs: on the output of an earlier render, a PDF of the
// file library, or, for Info, Split, Compress, ToImage, Redact and Fill, an upload, which is never
// stored. Every tool but Info answers a new render, on the Starter plan and above: Merge, Protect,
// Watermark, Split, Compress, Redact and Fill cost 0.5 units each on live keys, ToImage one unit
// per picture; Info is free. Each tool that renders sends an Idempotency-Key, as RendersService.Create
// does.
type PDFService struct{ t *transport }

// Merge joins PDFs in the order of Sources.
func (s *PDFService) Merge(ctx context.Context, req MergeRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/merge", "", nil, req, opts)
}

// Protect encrypts a PDF with AES-256.
func (s *PDFService) Protect(ctx context.Context, req ProtectRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/protect", req.Source, nil, req, opts)
}

// Watermark stamps a text or a library image on the pages.
func (s *PDFService) Watermark(ctx context.Context, req WatermarkRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/watermark", req.Source, nil, req, opts)
}

// Info reads a PDF's page count, page sizes, encryption, metadata and form, with every field's
// name, type, value and options, which is how a form's names are found for Fill. Free; it creates
// no render.
func (s *PDFService) Info(ctx context.Context, req InfoRequest) (*PDFInfo, error) {
	p, err := toolPayload(req.Source, req.File, req, "Source")
	if err != nil {
		return nil, err
	}
	return call[PDFInfo](ctx, s.t, http.MethodPost, "/pdf/info", p, "")
}

// Split cuts a PDF into parts: a ZIP of the parts, or the PDF itself for one part.
func (s *PDFService) Split(ctx context.Context, req SplitRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/split", req.Source, req.File, req, opts)
}

// Compress makes a PDF smaller; the render keeps the source when it cannot.
func (s *PDFService) Compress(ctx context.Context, req CompressRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/compress", req.Source, req.File, req, opts)
}

// ToImage draws pages as PNG or JPEG pictures: one page answers the picture, several a ZIP of them.
func (s *PDFService) ToImage(ctx context.Context, req ToImageRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/to-image", req.Source, req.File, req, opts)
}

// Redact removes what lies under the rectangles and every place a text stands, from the file
// itself, and reads the result again: text still there fails the render with
// redaction_incomplete, which names regions and texts by number, never a text.
func (s *PDFService) Redact(ctx context.Context, req RedactRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/redact", req.Source, req.File, req, opts)
}

// Fill fills a form's fields by their full names and keeps it fillable, or with Flatten draws the
// values into the pages. Render.Form says what it did.
func (s *PDFService) Fill(ctx context.Context, req FillRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/fill", req.Source, req.File, req, opts)
}

// Convert converts an office document to a PDF render (Starter plan and above).
func (s *PDFService) Convert(ctx context.Context, req ConvertRequest, opts ...CallOption) (*Render, error) {
	return s.tool(ctx, "/pdf/convert", req.Source, req.File, req, opts)
}

func (s *PDFService) tool(ctx context.Context, path, source string, file *Upload, req json.Marshaler, opts []CallOption) (*Render, error) {
	p, err := toolPayload(source, file, req, "Source")
	if err != nil {
		return nil, err
	}
	return call[Render](ctx, s.t, http.MethodPost, path, p, idempotencyKey(opts, true))
}

// toolPayload is a tool's request: a stored source by its id as JSON, an upload as multipart
// beside the request's other members.
func toolPayload(source string, file *Upload, req json.Marshaler, sourceName string) (*payload, error) {
	if file != nil && source != "" {
		return nil, &Error{Code: "invalid_request", Message: "give a " + sourceName + " or a File, not both"}
	}
	data, err := req.MarshalJSON()
	if err != nil {
		return nil, &Error{Code: "invalid_request", Message: "the request cannot be sent: " + err.Error(), Err: err}
	}
	if file == nil {
		return &payload{contentType: "application/json", data: data}, nil
	}
	fields, err := members(data)
	if err != nil {
		return nil, &Error{Code: "invalid_request", Message: "the request cannot be sent: " + err.Error(), Err: err}
	}
	return multipartPayload(fields, file)
}

// EinvoicesService says which rules an e-invoice passed. Needs the einvoice:validate scope.
type EinvoicesService struct{ t *transport }

// Validate judges an e-invoice: a render of this workspace's own e-invoice (RenderID), answered
// from the report it keeps, free; or an XML Formfeed did not make (File), which takes one of the
// organisation's validations of the day. It sends an Idempotency-Key, as RendersService.Create
// does.
func (s *EinvoicesService) Validate(ctx context.Context, req ValidateEinvoiceRequest, opts ...CallOption) (*EinvoiceReport, error) {
	p, err := toolPayload(req.RenderID, req.File, req, "RenderID")
	if err != nil {
		return nil, err
	}
	return call[EinvoiceReport](ctx, s.t, http.MethodPost, "/einvoices/validate", p, idempotencyKey(opts, true))
}
