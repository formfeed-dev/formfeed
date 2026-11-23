package formfeed

// The requests leave out what is not set: an empty string, a zero number, false and a nil map or
// list are not sent, and the API applies its default. An empty but non-nil map is sent as {}. Where
// a zero value is a value of its own (Dedupe: false, an Opacity of 0) the field is a pointer; set
// it with Ptr. Extra lays members over the request that this release of the SDK does not know yet,
// a nil value sending null; a member of the same name is replaced.

// RenderRequest is one render. Send exactly one source: Template, HTML, URL or Markdown.
type RenderRequest struct {
	// Template is the template by slug or id (tpl_…).
	Template string `json:"template,omitempty"`
	// Version is published (the default), a release channel such as staging, latest (test keys
	// only) or a version number.
	Version string `json:"version,omitempty"`
	// HTML is ad-hoc HTML, at most 5 MB; with an Engine a template over Data.
	HTML string `json:"html,omitempty"`
	// URL is a public https page to print.
	URL string `json:"url,omitempty"`
	// Markdown is a Markdown document, at most 1 MB; with an Engine a template over Data first.
	Markdown string `json:"markdown,omitempty"`
	// Engine is the template language of HTML or Markdown: jinja2, liquid or handlebars.
	Engine string `json:"engine,omitempty"`
	// Data is what the template renders with.
	Data map[string]any `json:"data,omitzero"`
	// Output is pdf, png, jpg, webp, docx or pptx; left out, the template decides.
	Output string `json:"output,omitempty"`
	// Settings are merged over the template's: paper, margins, pdf (ua, pdfa, metadata), image,
	// markdown, … as the settings reference lists them.
	Settings map[string]any `json:"settings,omitzero"`
	// Filename names the output file.
	Filename string `json:"filename,omitempty"`
	// ExpiresIn is the seconds until the output expires; it can only shorten the retention.
	ExpiresIn int `json:"expires_in,omitempty"`
	// Access is signed (a link that works for seven days at most) or public.
	Access string `json:"access,omitempty"`
	// Mode is sync (the default: the answer is the finished render) or async (the answer is the
	// queued render; wait for it with RendersService.WaitFor).
	Mode string `json:"mode,omitempty"`
	// Locale formats dates and numbers and selects the translation dictionary.
	Locale string `json:"locale,omitempty"`
	// WebhookURL receives render.completed or render.failed for this render.
	WebhookURL string `json:"webhook_url,omitempty"`
	// WebhookSecret signs the deliveries to WebhookURL; 16 to 200 characters.
	WebhookSecret string `json:"webhook_secret,omitempty"`
	// Meta is your own data, returned unchanged with the render and in its webhook events.
	Meta map[string]any `json:"meta,omitzero"`
	// Region is the workspace's region; leave it out.
	Region string `json:"region,omitempty"`
	// Dedupe answers a request identical to one of the last 24 hours from the earlier render at
	// zero units; true by default, Ptr(false) always renders.
	Dedupe *bool `json:"dedupe,omitempty"`
	// CanaryKey decides a channel's canary split: renders with the same value land on the same
	// version.
	CanaryKey string `json:"canary_key,omitempty"`
	// ValidateData checks Data against the template's stored schema before anything is rendered.
	ValidateData bool `json:"validate_data,omitempty"`
	// Post is the post-processing of a PDF: merge_after, watermark, password and einvoice.
	Post map[string]any `json:"post,omitzero"`
	// Storage is the copy for the workspace's own bucket: false leaves it out, a map with key names
	// its object.
	Storage any `json:"storage,omitempty"`
	// Extra holds members this release does not know yet.
	Extra map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r RenderRequest) MarshalJSON() ([]byte, error) {
	type plain RenderRequest
	return withExtra(plain(r), r.Extra)
}

// BatchRequest is up to 1,000 renders queued as one job. Template, Output and CanaryKey fill in
// what an item leaves out.
type BatchRequest struct {
	Template  string `json:"template,omitempty"`
	CanaryKey string `json:"canary_key,omitempty"`
	Output    string `json:"output,omitempty"`
	// Items are the renders, each a render request; their Mode is ignored.
	Items []RenderRequest `json:"items"`
	// Zip packs the outputs of the items that succeeded into one ZIP, Job.ZipURL.
	Zip bool `json:"zip,omitempty"`
	// WebhookURL receives an event for every item and job.completed or job.failed at the end.
	WebhookURL    string         `json:"webhook_url,omitempty"`
	WebhookSecret string         `json:"webhook_secret,omitempty"`
	Meta          map[string]any `json:"meta,omitzero"`
	Extra         map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r BatchRequest) MarshalJSON() ([]byte, error) {
	type plain BatchRequest
	return withExtra(plain(r), r.Extra)
}

// RenderListOptions narrows RendersService.List and All.
type RenderListOptions struct {
	// Template is a slug, tpl_… id or UUID.
	Template string
	// Status is queued, rendering, succeeded or failed.
	Status string
	// Environment is live or test.
	Environment string
	// Since and Until bound created_at, ISO 8601 with an offset (2026-11-01T00:00:00Z).
	Since string
	Until string
	Limit int
	// Cursor is the NextCursor of the page before; All starts there.
	Cursor string
}

func (o RenderListOptions) query() string {
	var q query
	q.add("template", o.Template)
	q.add("status", o.Status)
	q.add("environment", o.Environment)
	q.add("since", o.Since)
	q.add("until", o.Until)
	q.addInt("limit", o.Limit)
	q.add("cursor", o.Cursor)
	return q.String()
}

// FileListOptions narrows FilesService.List and All.
type FileListOptions struct {
	// Prefix keeps the names that start with it (brand/).
	Prefix string
	Limit  int
	Cursor string
}

func (o FileListOptions) query() string {
	var q query
	q.add("prefix", o.Prefix)
	q.addInt("limit", o.Limit)
	q.add("cursor", o.Cursor)
	return q.String()
}

// TemplateListOptions narrows TemplatesService.List and All.
type TemplateListOptions struct {
	// Kind is pdf, image, docx or pptx; Engine jinja2, liquid or handlebars.
	Kind   string
	Engine string
	Tag    string
	// Q searches names and slugs.
	Q      string
	Limit  int
	Cursor string
}

func (o TemplateListOptions) query() string {
	var q query
	q.add("kind", o.Kind)
	q.add("engine", o.Engine)
	q.add("tag", o.Tag)
	q.add("q", o.Q)
	q.addInt("limit", o.Limit)
	q.add("cursor", o.Cursor)
	return q.String()
}

// The PDF tools work on a Source, the id of an earlier render (rnd_…) or a PDF of the file library
// by its id (fil_…) or name (terms.pdf), or, where the request has one, on a File, an upload that
// is never stored. Give one of them. Filename, ExpiresIn, Access, Meta and Storage say where the
// result is stored, as on a render.

// MergeRequest joins PDFs in the order given.
type MergeRequest struct {
	// Sources are render ids, library file ids or library names; 2 to 50 of them.
	Sources   []string       `json:"sources"`
	Filename  string         `json:"filename,omitempty"`
	ExpiresIn int            `json:"expires_in,omitempty"`
	Access    string         `json:"access,omitempty"`
	Meta      map[string]any `json:"meta,omitzero"`
	Storage   any            `json:"storage,omitempty"`
	Extra     map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r MergeRequest) MarshalJSON() ([]byte, error) {
	type plain MergeRequest
	return withExtra(plain(r), r.Extra)
}

// ProtectRequest encrypts a PDF with AES-256.
type ProtectRequest struct {
	Source string `json:"source,omitempty"`
	// UserPassword is needed to open the document.
	UserPassword string `json:"user_password,omitempty"`
	// OwnerPassword lifts the restrictions; a random one nobody knows when empty.
	OwnerPassword string `json:"owner_password,omitempty"`
	// Permissions are what a reader without the owner password may do: print, copy, modify,
	// annotate. A nil list allows all four, an empty one none.
	Permissions []string       `json:"permissions,omitzero"`
	Filename    string         `json:"filename,omitempty"`
	ExpiresIn   int            `json:"expires_in,omitempty"`
	Access      string         `json:"access,omitempty"`
	Meta        map[string]any `json:"meta,omitzero"`
	Storage     any            `json:"storage,omitempty"`
	Extra       map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r ProtectRequest) MarshalJSON() ([]byte, error) {
	type plain ProtectRequest
	return withExtra(plain(r), r.Extra)
}

// WatermarkRequest stamps a text or a library image on the pages; give Text or Image.
type WatermarkRequest struct {
	Source string `json:"source,omitempty"`
	Text   string `json:"text,omitempty"`
	// Image is a PNG or JPEG of the file library, by id or name.
	Image string `json:"image,omitempty"`
	// Opacity runs from 0 to 1, 0.2 when nil.
	Opacity *float64 `json:"opacity,omitempty"`
	// Rotation is degrees clockwise as in CSS; when nil a text runs diagonally and an image stands
	// upright.
	Rotation *float64 `json:"rotation,omitempty"`
	// Color is the hex colour of a text, grey when empty.
	Color     string         `json:"color,omitempty"`
	Filename  string         `json:"filename,omitempty"`
	ExpiresIn int            `json:"expires_in,omitempty"`
	Access    string         `json:"access,omitempty"`
	Meta      map[string]any `json:"meta,omitzero"`
	Storage   any            `json:"storage,omitempty"`
	Extra     map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r WatermarkRequest) MarshalJSON() ([]byte, error) {
	type plain WatermarkRequest
	return withExtra(plain(r), r.Extra)
}

// InfoRequest names the PDF PDFService.Info reads.
type InfoRequest struct {
	Source string         `json:"source,omitempty"`
	File   *Upload        `json:"-"`
	Extra  map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r InfoRequest) MarshalJSON() ([]byte, error) {
	type plain InfoRequest
	return withExtra(plain(r), r.Extra)
}

// SplitRequest cuts a PDF into parts, Every pages each or one per entry of Ranges.
type SplitRequest struct {
	Source string  `json:"source,omitempty"`
	File   *Upload `json:"-"`
	// Every is the pages per part.
	Every int `json:"every,omitempty"`
	// Ranges are one page selection per part, such as 1-3,5 or 4- (page 4 to the last).
	Ranges    []string       `json:"ranges,omitempty"`
	Filename  string         `json:"filename,omitempty"`
	ExpiresIn int            `json:"expires_in,omitempty"`
	Access    string         `json:"access,omitempty"`
	Meta      map[string]any `json:"meta,omitzero"`
	Storage   any            `json:"storage,omitempty"`
	Extra     map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r SplitRequest) MarshalJSON() ([]byte, error) {
	type plain SplitRequest
	return withExtra(plain(r), r.Extra)
}

// CompressRequest makes a PDF smaller.
type CompressRequest struct {
	Source    string         `json:"source,omitempty"`
	File      *Upload        `json:"-"`
	Filename  string         `json:"filename,omitempty"`
	ExpiresIn int            `json:"expires_in,omitempty"`
	Access    string         `json:"access,omitempty"`
	Meta      map[string]any `json:"meta,omitzero"`
	Storage   any            `json:"storage,omitempty"`
	Extra     map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r CompressRequest) MarshalJSON() ([]byte, error) {
	type plain CompressRequest
	return withExtra(plain(r), r.Extra)
}

// ToImageRequest draws pages as pictures: one page answers the picture, several a ZIP of them.
type ToImageRequest struct {
	Source string  `json:"source,omitempty"`
	File   *Upload `json:"-"`
	// Pages are the pages to draw, such as 1, 1-3,5 or 2-; every page when empty.
	Pages string `json:"pages,omitempty"`
	// Format is png (the default) or jpg.
	Format string `json:"format,omitempty"`
	// DPI runs from 36 to 300, 150 when 0.
	DPI int `json:"dpi,omitempty"`
	// Quality is the JPEG quality, 1 to 100.
	Quality   int            `json:"quality,omitempty"`
	Filename  string         `json:"filename,omitempty"`
	ExpiresIn int            `json:"expires_in,omitempty"`
	Access    string         `json:"access,omitempty"`
	Meta      map[string]any `json:"meta,omitzero"`
	Storage   any            `json:"storage,omitempty"`
	Extra     map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r ToImageRequest) MarshalJSON() ([]byte, error) {
	type plain ToImageRequest
	return withExtra(plain(r), r.Extra)
}

// RedactRequest removes what lies under Regions and every place a Text stands, from the file
// itself; give Regions, Text or both.
type RedactRequest struct {
	Source  string         `json:"source,omitempty"`
	File    *Upload        `json:"-"`
	Regions []RedactRegion `json:"regions,omitempty"`
	// Text are texts to remove wherever they stand, found whatever their whitespace; never stored.
	Text []string `json:"text,omitempty"`
	// MatchCase finds a text only in the case it is written in.
	MatchCase bool `json:"match_case,omitempty"`
	// WholeWords finds a text only where a word boundary stands on each side of it.
	WholeWords bool `json:"whole_words,omitempty"`
	// Fill is the hex colour of the box drawn over each redaction, black when empty.
	Fill string `json:"fill,omitempty"`
	// NoFill draws no box at all: it sends fill as null.
	NoFill    bool           `json:"-"`
	Filename  string         `json:"filename,omitempty"`
	ExpiresIn int            `json:"expires_in,omitempty"`
	Access    string         `json:"access,omitempty"`
	Meta      map[string]any `json:"meta,omitzero"`
	Storage   any            `json:"storage,omitempty"`
	Extra     map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members, and fill as null for NoFill.
func (r RedactRequest) MarshalJSON() ([]byte, error) {
	type plain RedactRequest
	extra := r.Extra
	if r.NoFill {
		extra = make(map[string]any, len(r.Extra)+1)
		for name, value := range r.Extra {
			extra[name] = value
		}
		extra["fill"] = nil
	}
	return withExtra(plain(r), extra)
}

// RedactRegion is a rectangle as a viewer shows the page: points from its top-left corner, y
// running down.
type RedactRegion struct {
	// Page is the page number, from 1.
	Page   int     `json:"page"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// FillRequest fills a form's fields by their full names, as PDFService.Info lists them, or with
// Flatten draws the values into the pages. The values are never stored.
type FillRequest struct {
	Source string  `json:"source,omitempty"`
	File   *Upload `json:"-"`
	// Fields are the values by full name: a string (or number) for a text field, a bool for a
	// check box, an option for a choice or radio group, a []string for a list box.
	Fields map[string]any `json:"fields,omitzero"`
	// Flatten draws the values into the pages and removes the fields.
	Flatten bool `json:"flatten,omitempty"`
	// Strict fails on a name the form lacks or a value its field does not take; true when nil,
	// Ptr(false) lists both in Render.Form instead.
	Strict    *bool          `json:"strict,omitempty"`
	Filename  string         `json:"filename,omitempty"`
	ExpiresIn int            `json:"expires_in,omitempty"`
	Access    string         `json:"access,omitempty"`
	Meta      map[string]any `json:"meta,omitzero"`
	Storage   any            `json:"storage,omitempty"`
	Extra     map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r FillRequest) MarshalJSON() ([]byte, error) {
	type plain FillRequest
	return withExtra(plain(r), r.Extra)
}

// ConvertRequest converts an office document to a PDF: a File (Word, Excel, PowerPoint,
// OpenDocument, RTF or HTML, up to 20 MB, never kept) or the Source of a Word or PowerPoint
// template render.
type ConvertRequest struct {
	Source string  `json:"source,omitempty"`
	File   *Upload `json:"-"`
	// PageRanges are the pages to convert, such as 1-3,5; all when empty.
	PageRanges string `json:"page_ranges,omitempty"`
	// Landscape is for spreadsheets and documents without their own page setup.
	Landscape bool `json:"landscape,omitempty"`
	// SinglePageSheets puts each spreadsheet sheet on one page.
	SinglePageSheets bool           `json:"single_page_sheets,omitempty"`
	Filename         string         `json:"filename,omitempty"`
	ExpiresIn        int            `json:"expires_in,omitempty"`
	Access           string         `json:"access,omitempty"`
	Meta             map[string]any `json:"meta,omitzero"`
	Storage          any            `json:"storage,omitempty"`
	Extra            map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r ConvertRequest) MarshalJSON() ([]byte, error) {
	type plain ConvertRequest
	return withExtra(plain(r), r.Extra)
}

// ValidateEinvoiceRequest names the e-invoice EinvoicesService.Validate judges: the RenderID of
// this workspace's own e-invoice, answered from the report it keeps, free; or a File, an XML
// Formfeed did not make (up to 4 MB, Starter plan and above), which takes one of the
// organisation's validations of the day.
type ValidateEinvoiceRequest struct {
	RenderID string  `json:"render_id,omitempty"`
	File     *Upload `json:"-"`
	// Rules is auto, factur-x, xrechnung or en16931; the render's own when empty.
	Rules string         `json:"rules,omitempty"`
	Extra map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r ValidateEinvoiceRequest) MarshalJSON() ([]byte, error) {
	type plain ValidateEinvoiceRequest
	return withExtra(plain(r), r.Extra)
}

// ValidateTemplateRequest is what TemplatesService.Validate checks.
type ValidateTemplateRequest struct {
	// Version is published (the default), latest, a version number or a channel name.
	Version string `json:"version,omitempty"`
	// Data is the data to check; the version's sample data when nil.
	Data  map[string]any `json:"data,omitzero"`
	Extra map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r ValidateTemplateRequest) MarshalJSON() ([]byte, error) {
	type plain ValidateTemplateRequest
	return withExtra(plain(r), r.Extra)
}

// CreateWebhookRequest registers an endpoint.
type CreateWebhookRequest struct {
	// URL is an https URL on a public host.
	URL string `json:"url"`
	// Events are the events to receive; render.completed, render.failed, job.completed and
	// job.failed when nil. quota.* and storage.* arrive only when listed.
	Events []string `json:"events,omitempty"`
	// Environments are live and test, both when nil.
	Environments []string       `json:"environments,omitempty"`
	Description  string         `json:"description,omitempty"`
	Extra        map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members.
func (r CreateWebhookRequest) MarshalJSON() ([]byte, error) {
	type plain CreateWebhookRequest
	return withExtra(plain(r), r.Extra)
}

// UpdateWebhookRequest changes the fields it sets; the others stay.
type UpdateWebhookRequest struct {
	URL          string   `json:"url,omitempty"`
	Events       []string `json:"events,omitempty"`
	Environments []string `json:"environments,omitempty"`
	// Enabled switches the endpoint off, or on again, which resets its failures.
	Enabled     *bool   `json:"enabled,omitempty"`
	Description *string `json:"description,omitempty"`
	// ClearDescription removes the description: it sends description as null.
	ClearDescription bool           `json:"-"`
	Extra            map[string]any `json:"-"`
}

// MarshalJSON writes the request with its Extra members, and description as null for
// ClearDescription.
func (r UpdateWebhookRequest) MarshalJSON() ([]byte, error) {
	type plain UpdateWebhookRequest
	extra := r.Extra
	if r.ClearDescription {
		extra = make(map[string]any, len(r.Extra)+1)
		for name, value := range r.Extra {
			extra[name] = value
		}
		extra["description"] = nil
	}
	return withExtra(plain(r), extra)
}
