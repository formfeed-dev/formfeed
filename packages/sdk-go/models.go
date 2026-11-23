package formfeed

import "encoding/json"

// The models read the API's answers tolerantly on purpose, so an SDK of today reads the answers of
// a later API: unknown members are ignored, a member of another type than the field's leaves the
// field at its zero value, and values the API enumerates (a status, an output format) are plain
// strings, which a new value never breaks. Null reads as the zero value: an empty DownloadURL, a
// PageCount of 0, a nil Template. Timestamps are the RFC 3339 strings the API sends; read one with
// time.Parse(time.RFC3339, …). Raw holds the answer as it came, members of later API versions
// included.

// Render is a render: a template, HTML, URL or Markdown render, or the result of a PDF tool.
type Render struct {
	// ID is the render id, rnd_ and 32 hexadecimal digits.
	ID string `json:"id"`
	// Status is queued, rendering, succeeded or failed.
	Status string `json:"status"`
	// Output is pdf, png, jpg, webp, docx, pptx, or zip for a tool that made several files.
	Output string `json:"output"`
	// DownloadURL is the link to the file; empty while queued, for a failed render and once the
	// output was deleted or expired. A signed link works for seven days at most: read the render
	// again for a fresh one.
	DownloadURL string `json:"download_url"`
	// ExpiresAt is when DownloadURL stops working.
	ExpiresAt string `json:"expires_at"`
	// Bytes is the size of the file.
	Bytes int64 `json:"bytes"`
	// PageCount is the pages of a PDF; 0 for other outputs and while queued.
	PageCount int `json:"page_count"`
	// Units is what the render cost; 0 for test keys and an answer from the dedup cache.
	Units float64 `json:"units"`
	// Region is the region the render ran in, eu.
	Region string `json:"region"`
	// Environment is live or test, after the key that made it.
	Environment string `json:"environment"`
	// Template is the template and version that rendered; nil for HTML, URL, Markdown and PDF
	// tool renders and for an answer from the dedup cache.
	Template *RenderTemplate `json:"template"`
	// EngineVersion says what produced the file, for reproducibility; empty until it succeeded.
	EngineVersion string `json:"engine_version"`
	// TemplateChecksum is the checksum of the template version that rendered.
	TemplateChecksum string `json:"template_checksum"`
	// OutputSHA256 is the SHA-256 of the file, as hexadecimal.
	OutputSHA256 string `json:"output_sha256"`
	// Deduplicated is true when the answer came from the dedup cache.
	Deduplicated bool `json:"deduplicated"`
	// Storage is the copy to the workspace's own bucket; nil when none applies.
	Storage *StorageDelivery `json:"storage"`
	// Einvoice is the e-invoice report: profile, flavour, validation, display; nil for a render
	// that made none. A failed render keeps it too, which is where it says why.
	Einvoice map[string]any `json:"einvoice"`
	// Accessibility is the validator's PDF/UA-1 verdict; nil unless the render set settings.pdf.ua.
	Accessibility map[string]any `json:"accessibility"`
	// PDFA is the validator's PDF/A verdict; nil unless the render set settings.pdf.pdfa.
	PDFA map[string]any `json:"pdfa"`
	// Form is what a fill did; nil for every render but those of PDFService.Fill.
	Form *FormFill `json:"form"`
	// Timings are the milliseconds per phase of a render that succeeded (compile_ms, render_ms, …).
	Timings map[string]int64 `json:"timings"`
	// Error is why a failed render failed; nil unless Status is failed.
	Error *RenderError `json:"error"`
	// Meta is the meta of the request, unchanged.
	Meta        map[string]any `json:"meta"`
	CreatedAt   string         `json:"created_at"`
	CompletedAt string         `json:"completed_at"`
	// Raw is the render as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// Finished reports whether the render succeeded or failed, after which nothing changes any more.
func (r *Render) Finished() bool {
	return r.Status == "succeeded" || r.Status == "failed"
}

// UnmarshalJSON reads a render leniently and keeps it in Raw.
func (r *Render) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain Render
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*r = Render(v)
	return nil
}

// RenderTemplate is the template and version of a render.
type RenderTemplate struct {
	// ID is the template id, tpl_…, which a render request takes as Template.
	ID      string `json:"id"`
	Slug    string `json:"slug"`
	Version int    `json:"version"`
	// Channel is the release channel the version came from; empty when the request named a version
	// number or latest.
	Channel string `json:"channel"`
	// Canary is true when the channel's canary share picked this version.
	Canary bool `json:"canary"`
}

// RenderError is the error a failed render stored: its code and English message, and in Details
// every member, those that say more included.
type RenderError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"-"`
}

// UnmarshalJSON reads the error leniently, keeping every member in Details.
func (e *RenderError) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain RenderError
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	if err := decodeLenient(data, &v.Details); err != nil {
		return err
	}
	*e = RenderError(v)
	return nil
}

// StorageDelivery is where the copy to the workspace's own bucket goes and how far it got.
type StorageDelivery struct {
	// Status is pending, delivered or failed.
	Status string `json:"status"`
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
	// URL is the object below the connection's public base URL; empty without one.
	URL string `json:"url"`
	// Reason says why a copy failed or was not made.
	Reason string        `json:"reason"`
	Error  *StorageError `json:"error"`
}

// StorageError is the provider's answer to a failed copy.
type StorageError struct {
	Code       string `json:"code"`
	HTTPStatus int    `json:"http_status"`
	Message    string `json:"message"`
}

// FormFill is what a fill did. Its entries name fields, never their values.
type FormFill struct {
	Filled int `json:"filled"`
	// Skipped are the fields left out, with the reason unknown or invalid.
	Skipped []struct {
		Field  string `json:"field"`
		Reason string `json:"reason"`
	} `json:"skipped"`
	// Warnings are the calculations and display formats of the form that no viewer has run.
	Warnings []struct {
		Field string `json:"field"`
		Code  string `json:"code"`
	} `json:"warnings"`
	// XFARemoved is true when the form was a hybrid whose XFA part was removed.
	XFARemoved bool `json:"xfa_removed"`
}

// Job is a batch, or a render queued with its own webhook URL: its renders in the order of the
// request and, once they are done, a ZIP of their files.
type Job struct {
	ID string `json:"id"`
	// Type is single or batch.
	Type string `json:"type"`
	// Status is queued, processing, completed, partially_failed or failed.
	Status    string `json:"status"`
	Total     int    `json:"total"`
	Succeeded int    `json:"succeeded"`
	Failed    int    `json:"failed"`
	// ZipURL is the link to the ZIP of a batch that asked for one, once it has finished.
	ZipURL       string           `json:"zip_url"`
	ZipExpiresAt string           `json:"zip_expires_at"`
	Storage      *StorageDelivery `json:"storage"`
	// Items are the renders, in the order of the request.
	Items       []Render       `json:"items"`
	Meta        map[string]any `json:"meta"`
	CreatedAt   string         `json:"created_at"`
	CompletedAt string         `json:"completed_at"`
	// Raw is the job as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// Finished reports whether no render of the job is queued or running any more.
func (j *Job) Finished() bool {
	return j.Status != "queued" && j.Status != "processing"
}

// UnmarshalJSON reads a job leniently and keeps it in Raw.
func (j *Job) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain Job
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*j = Job(v)
	return nil
}

// Page is one page of a list, newest first, and the cursor of the next, empty on the last.
type Page[T any] struct {
	Data       []T    `json:"data"`
	NextCursor string `json:"next_cursor"`
}

// RenderInput is the stored request of a render, to render it again: a template render carries
// Template and Data, an ad-hoc one HTML, URL or Markdown. Passwords are never included.
type RenderInput struct {
	RenderID string `json:"render_id"`
	// Template is the template, version and channel; nil for an ad-hoc render.
	Template    *RenderTemplate `json:"template"`
	Data        map[string]any  `json:"data"`
	HTML        string          `json:"html"`
	Markdown    string          `json:"markdown"`
	URL         string          `json:"url"`
	Engine      string          `json:"engine"`
	Locale      string          `json:"locale"`
	Output      string          `json:"output"`
	Settings    map[string]any  `json:"settings"`
	Filename    string          `json:"filename"`
	Post        map[string]any  `json:"post"`
	Meta        map[string]any  `json:"meta"`
	Environment string          `json:"environment"`
	CreatedAt   string          `json:"created_at"`
	// Raw is the request as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads a render's request leniently and keeps it in Raw.
func (r *RenderInput) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain RenderInput
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*r = RenderInput(v)
	return nil
}

// LibraryFile is a file of the workspace's library: an image or PDF a template names, served at URL.
type LibraryFile struct {
	// ID is the file id, fil_….
	ID string `json:"id"`
	// Name is the library name, the address a template names (logo.png, brand/header.svg).
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
	// URL is the CDN URL, the one asset(name) produces.
	URL       string `json:"url"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	// Raw is the file as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads a file leniently and keeps it in Raw.
func (f *LibraryFile) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain LibraryFile
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*f = LibraryFile(v)
	return nil
}

// Template is a template of the workspace, without its versions' content.
type Template struct {
	// ID is the template id, tpl_….
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Kind is pdf, image, docx or pptx.
	Kind string `json:"kind"`
	// Engine is jinja2, liquid or handlebars.
	Engine string   `json:"engine"`
	Tags   []string `json:"tags"`
	// PublishedVersion is the number of the published version; 0 while none is.
	PublishedVersion int    `json:"published_version"`
	LatestVersion    int    `json:"latest_version"`
	CreatedAt        string `json:"created_at"`
	UpdatedAt        string `json:"updated_at"`
	// Raw is the template as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads a template leniently and keeps it in Raw.
func (t *Template) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain Template
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*t = Template(v)
	return nil
}

// TemplateValidation is what TemplatesService.Validate found.
type TemplateValidation struct {
	// OK is false when at least one diagnostic is an error.
	OK bool `json:"ok"`
	// Template is the template and the version that was checked.
	Template struct {
		ID      string `json:"id"`
		Slug    string `json:"slug"`
		Version int    `json:"version"`
	} `json:"template"`
	// Diagnostics are every finding, errors and warnings alike.
	Diagnostics []Diagnostic `json:"diagnostics"`
	// Raw is the answer as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads a validation leniently and keeps it in Raw.
func (v *TemplateValidation) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain TemplateValidation
	var p plain
	if err := decodeLenient(data, &p); err != nil {
		return err
	}
	p.Raw = raw(data)
	*v = TemplateValidation(p)
	return nil
}

// Diagnostic is one finding of a check. Only error findings make a validation fail.
type Diagnostic struct {
	// Severity is error, warning or info.
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	// Location is where in the template source, line and column from 1.
	Location *struct {
		Line   int `json:"line"`
		Column int `json:"column"`
	} `json:"location"`
	// Path is where in the data, for data errors: data.invoice.lines[0].qty.
	Path string `json:"path"`
	// Part and Paragraph place a finding in a Word or PowerPoint template.
	Part      string `json:"part"`
	Paragraph int    `json:"paragraph"`
}

// Usage is the units of a billing period, with a daily series and a breakdown per template.
type Usage struct {
	// Period is the month the period started in, YYYY-MM.
	Period string `json:"period"`
	// PeriodStart is the first day of the period, PeriodEnd the first day after it (YYYY-MM-DD).
	PeriodStart    string  `json:"period_start"`
	PeriodEnd      string  `json:"period_end"`
	Included       float64 `json:"included"`
	Used           float64 `json:"used"`
	OverageUsed    float64 `json:"overage_used"`
	OverageBalance float64 `json:"overage_balance"`
	// HardCapUnits is the units at which overage stops live renders; nil on a plan without
	// overage and for an earlier period.
	HardCapUnits *float64 `json:"hard_cap_units"`
	Daily        []struct {
		Date    string  `json:"date"`
		Units   float64 `json:"units"`
		Renders int     `json:"renders"`
	} `json:"daily"`
	ByTemplate []struct {
		Template string  `json:"template"`
		Units    float64 `json:"units"`
	} `json:"by_template"`
	// Raw is the usage as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads the usage leniently and keeps it in Raw.
func (u *Usage) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain Usage
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*u = Usage(v)
	return nil
}

// PDFInfo is what a PDF holds: its pages and their sizes, whether it is encrypted, its metadata,
// and its form with every field's full name, the names PDFService.Fill takes.
type PDFInfo struct {
	// Source is the render id or library file the info is of, or the upload's name.
	Source    string    `json:"source"`
	PageCount int       `json:"page_count"`
	Pages     []PDFPage `json:"pages"`
	Encrypted bool      `json:"encrypted"`
	// Metadata holds title, author, subject, producer and creator.
	Metadata map[string]any `json:"metadata"`
	// Form is nil when the file needs a password to open.
	Form *PDFForm `json:"form"`
	// Raw is the info as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads the info leniently and keeps it in Raw.
func (i *PDFInfo) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain PDFInfo
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*i = PDFInfo(v)
	return nil
}

// PDFPage is the size of one page, in points and millimetres.
type PDFPage struct {
	WidthPt  float64 `json:"width_pt"`
	HeightPt float64 `json:"height_pt"`
	WidthMM  float64 `json:"width_mm"`
	HeightMM float64 `json:"height_mm"`
}

// PDFForm is the form of a PDF.
type PDFForm struct {
	// Type is acroform, hybrid (with an XFA part) or xfa (which Fill refuses); empty without a form.
	Type string `json:"type"`
	// Signed is true when the form holds a signature; Fill refuses such a file.
	Signed bool           `json:"signed"`
	Fields []PDFFormField `json:"fields"`
}

// PDFFormField is one field of a form.
type PDFFormField struct {
	// Name is the full name, parts joined by dots, which Fill takes.
	Name string `json:"name"`
	// Label is what the field is for, from its tooltip.
	Label string `json:"label"`
	// Type is text, checkbox, radio, dropdown, listbox, signature or button.
	Type string `json:"type"`
	// Value is a string, a bool or a []any of strings; nil when unset.
	Value any `json:"value"`
	// Options are what Fill takes for a choice, a radio group or a check box with several
	// on-values.
	Options    []string `json:"options"`
	Required   bool     `json:"required"`
	Readonly   bool     `json:"readonly"`
	Calculated bool     `json:"calculated"`
	Format     string   `json:"format"`
	Pages      []int    `json:"pages"`
}

// WebhookEndpoint is a registered webhook endpoint. Secret is only in the answer that created it.
type WebhookEndpoint struct {
	// ID is the endpoint id, a UUID.
	ID           string   `json:"id"`
	URL          string   `json:"url"`
	Events       []string `json:"events"`
	Environments []string `json:"environments"`
	// Enabled is whether events are delivered; true when the answer leaves it out.
	Enabled             bool   `json:"enabled"`
	Description         string `json:"description"`
	ConsecutiveFailures int    `json:"consecutive_failures"`
	// Secret signs the deliveries (whsec_…); verify them with [Webhook].
	Secret    string `json:"secret"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	// Raw is the endpoint as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads an endpoint leniently and keeps it in Raw.
func (w *WebhookEndpoint) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain WebhookEndpoint
	v := plain{Enabled: true}
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*w = WebhookEndpoint(v)
	return nil
}

// WebhookTest is the answer to WebhooksService.Test.
type WebhookTest struct {
	// Queued is true once the test event is queued; the delivery log shows its outcome.
	Queued bool `json:"queued"`
}

// WebhookResend is the new delivery of WebhooksService.Resend.
type WebhookResend struct {
	DeliveryID string `json:"delivery_id"`
	EventID    string `json:"event_id"`
	Event      string `json:"event"`
	EndpointID string `json:"endpoint_id"`
}

// EinvoiceReport says which rules an e-invoice passed, by which validator and release, and which
// bytes it judged; not whether the document is a proper invoice for VAT purposes. Raw holds the
// members not typed here (source, route, display, allowance).
type EinvoiceReport struct {
	ID string `json:"id"`
	// Result is passed, failed or not_checked, and takes new values.
	Result string `json:"result"`
	// Reason says why a file was not checked; Explanation says it in a sentence.
	Reason      string `json:"reason"`
	Explanation string `json:"explanation"`
	Validator   string `json:"validator"`
	Rules       string `json:"rules"`
	Scenario    string `json:"scenario"`
	Profile     string `json:"profile"`
	// Checks are what the file was held to, each with its own result.
	Checks []struct {
		// Kind is syntax, schema, rules or container.
		Kind string `json:"kind"`
		Name string `json:"name"`
		// Result is passed, failed or not_run.
		Result   string `json:"result"`
		Messages []struct {
			Part     string `json:"part"`
			Severity string `json:"severity"`
			Rule     string `json:"rule"`
			Message  string `json:"message"`
			Location string `json:"location"`
		} `json:"messages"`
	} `json:"checks"`
	Truncated   bool              `json:"truncated"`
	Versions    map[string]string `json:"versions"`
	XMLSHA256   string            `json:"xml_sha256"`
	PDFSHA256   string            `json:"pdf_sha256"`
	ValidatedAt string            `json:"validated_at"`
	// Raw is the report as the API sent it.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON reads a report leniently and keeps it in Raw.
func (r *EinvoiceReport) UnmarshalJSON(data []byte) error {
	if isNull(data) {
		return nil
	}
	type plain EinvoiceReport
	var v plain
	if err := decodeLenient(data, &v); err != nil {
		return err
	}
	v.Raw = raw(data)
	*r = EinvoiceReport(v)
	return nil
}
