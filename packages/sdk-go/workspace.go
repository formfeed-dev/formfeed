package formfeed

import (
	"context"
	"iter"
	"net/http"
)

// FilesService is the workspace's file library: images and PDFs a template names with
// asset('logo.png'), and the sources of image watermarks and merges. Needs file:read, file:write or
// file:delete. Files are served without a signature, so keep confidential documents out of it.
type FilesService struct{ t *transport }

// Upload adds a file under its Name; one of the same name is replaced in place and keeps its URL.
func (s *FilesService) Upload(ctx context.Context, file *Upload) (*LibraryFile, error) {
	if file == nil {
		return nil, &Error{Code: "invalid_request", Message: "no file to upload"}
	}
	name, err := marshal(file.fileName())
	if err != nil {
		return nil, &Error{Code: "invalid_request", Message: err.Error(), Err: err}
	}
	p, err := multipartPayload([]member{{name: "name", value: name}}, file)
	if err != nil {
		return nil, err
	}
	return call[LibraryFile](ctx, s.t, http.MethodPost, "/files", p, "")
}

// List reads one page of files, newest first.
func (s *FilesService) List(ctx context.Context, opts FileListOptions) (*Page[LibraryFile], error) {
	return call[Page[LibraryFile]](ctx, s.t, http.MethodGet, "/files"+opts.query(), nil, "")
}

// All iterates over every file the options match, page after page; an error ends it as its last
// value.
func (s *FilesService) All(ctx context.Context, opts FileListOptions) iter.Seq2[*LibraryFile, error] {
	return pages(func(cursor string) (*Page[LibraryFile], error) {
		page := opts
		page.Cursor = cursor
		return s.List(ctx, page)
	}, opts.Cursor)
}

// Get reads a file by its id (fil_…) or name.
func (s *FilesService) Get(ctx context.Context, idOrName string) (*LibraryFile, error) {
	return call[LibraryFile](ctx, s.t, http.MethodGet, "/files/"+escape(idOrName), nil, "")
}

// Delete removes a file and its bytes; templates that name it render a missing image afterwards.
func (s *FilesService) Delete(ctx context.Context, idOrName string) error {
	return s.t.json(ctx, http.MethodDelete, "/files/"+escape(idOrName), nil, "", nil)
}

// TemplatesService reads and checks the workspace's templates. Writing them (versions, publishing,
// channels) is the command line's and the app's; Client.Request reaches those calls.
type TemplatesService struct{ t *transport }

// List reads one page of templates.
func (s *TemplatesService) List(ctx context.Context, opts TemplateListOptions) (*Page[Template], error) {
	return call[Page[Template]](ctx, s.t, http.MethodGet, "/templates"+opts.query(), nil, "")
}

// All iterates over every template the options match, page after page; an error ends it as its
// last value.
func (s *TemplatesService) All(ctx context.Context, opts TemplateListOptions) iter.Seq2[*Template, error] {
	return pages(func(cursor string) (*Page[Template], error) {
		page := opts
		page.Cursor = cursor
		return s.List(ctx, page)
	}, opts.Cursor)
}

// Get reads a template by its slug, tpl_… id or UUID.
func (s *TemplatesService) Get(ctx context.Context, idOrSlug string) (*Template, error) {
	return call[Template](ctx, s.t, http.MethodGet, "/templates/"+escape(idOrSlug), nil, "")
}

// Schema reads the JSON Schema of the template's data: stored, else inferred from the sample data.
// Of the published (else the latest) version, or of version: published, latest, a number or a
// channel name.
func (s *TemplatesService) Schema(ctx context.Context, idOrSlug, version string) (map[string]any, error) {
	var q query
	q.add("version", version)
	out, err := call[map[string]any](ctx, s.t, http.MethodGet, "/templates/"+escape(idOrSlug)+"/schema"+q.String(), nil, "")
	if err != nil {
		return nil, err
	}
	return *out, nil
}

// Validate checks a version with data without rendering: syntax, header and footer, missing
// partials, runtime errors and the data against the stored schema. Free. Without Data, the
// version's sample data is checked.
func (s *TemplatesService) Validate(ctx context.Context, idOrSlug string, req ValidateTemplateRequest) (*TemplateValidation, error) {
	p, err := jsonPayload(req)
	if err != nil {
		return nil, err
	}
	return call[TemplateValidation](ctx, s.t, http.MethodPost, "/templates/"+escape(idOrSlug)+"/validate", p, "")
}

// WebhooksService manages the workspace's webhook endpoints. Needs webhook:manage. Verify a
// delivery with [Webhook].
type WebhooksService struct{ t *transport }

// List reads the registered endpoints, without their secrets.
func (s *WebhooksService) List(ctx context.Context) ([]WebhookEndpoint, error) {
	out, err := call[struct {
		Data []WebhookEndpoint `json:"data"`
	}](ctx, s.t, http.MethodGet, "/webhooks", nil, "")
	if err != nil {
		return nil, err
	}
	return out.Data, nil
}

// Create registers an endpoint; the answer carries its Secret, this once.
func (s *WebhooksService) Create(ctx context.Context, req CreateWebhookRequest) (*WebhookEndpoint, error) {
	p, err := jsonPayload(req)
	if err != nil {
		return nil, err
	}
	return call[WebhookEndpoint](ctx, s.t, http.MethodPost, "/webhooks", p, "")
}

// Update changes the fields the request sets; the others stay.
func (s *WebhooksService) Update(ctx context.Context, id string, req UpdateWebhookRequest) (*WebhookEndpoint, error) {
	p, err := jsonPayload(req)
	if err != nil {
		return nil, err
	}
	return call[WebhookEndpoint](ctx, s.t, http.MethodPut, "/webhooks/"+escape(id), p, "")
}

// Delete removes an endpoint.
func (s *WebhooksService) Delete(ctx context.Context, id string) error {
	return s.t.json(ctx, http.MethodDelete, "/webhooks/"+escape(id), nil, "", nil)
}

// Test sends a test delivery to the endpoint.
func (s *WebhooksService) Test(ctx context.Context, id string) (*WebhookTest, error) {
	return call[WebhookTest](ctx, s.t, http.MethodPost, "/webhooks/"+escape(id)+"/test", nil, "")
}

// Resend sends a stored event (evt_…) again, as a new delivery to an endpoint.
func (s *WebhooksService) Resend(ctx context.Context, eventID, endpointID string) (*WebhookResend, error) {
	p, err := jsonPayload(map[string]string{"endpoint_id": endpointID})
	if err != nil {
		return nil, err
	}
	return call[WebhookResend](ctx, s.t, http.MethodPost, "/webhooks/events/"+escape(eventID)+"/resend", p, "")
}

// AccountService reads the key's account and the usage of a billing period.
type AccountService struct{ t *transport }

// Get reads the key's organisation, workspace, plan, period, units, limits and environment.
func (s *AccountService) Get(ctx context.Context) (map[string]any, error) {
	out, err := call[map[string]any](ctx, s.t, http.MethodGet, "/account", nil, "")
	if err != nil {
		return nil, err
	}
	return *out, nil
}

// Usage reads the units of the current period, or of period (YYYY-MM), with a daily series and a
// breakdown per template.
func (s *AccountService) Usage(ctx context.Context, period string) (*Usage, error) {
	if period == "" {
		period = "current"
	}
	return call[Usage](ctx, s.t, http.MethodGet, "/usage?period="+escape(period), nil, "")
}
