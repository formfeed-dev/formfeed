using System.Collections.Generic;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>E-invoices: which rules one passed.</summary>
public sealed class EinvoiceService
{
    private readonly Transport transport;

    internal EinvoiceService(Transport transport) => this.transport = transport;

    /// <summary>
    /// Which rules an e-invoice of this workspace passed, answered from the report its render keeps,
    /// free. Needs <c>einvoice:validate</c>.
    /// </summary>
    /// <param name="renderId">The render that made the e-invoice.</param>
    /// <param name="rules"><c>auto</c>, <c>factur-x</c>, <c>xrechnung</c> or <c>en16931</c>; the render's own when null.</param>
    /// <param name="idempotencyKey">Ties the check to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    /// <returns>The report: <c>result</c>, the <c>checks</c> with their findings, <c>validator</c>, <c>rules</c> and <c>versions</c>.</returns>
    public Task<JsonElement> ValidateAsync(
        string renderId,
        string? rules = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        transport.ObjectAsync(
            HttpMethod.Post,
            "/einvoices/validate",
            new FieldList().Set("render_id", Guard.NotNull(renderId, nameof(renderId))).Add("rules", rules),
            idempotencyKey ?? Ids.Key(),
            cancellationToken);

    /// <inheritdoc cref="ValidateAsync(string, string?, string?, CancellationToken)"/>
    public Task<JsonElement> ValidateAsync(
        Render render,
        string? rules = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        ValidateAsync(Guard.NotNull(render, nameof(render)).Id, rules, idempotencyKey, cancellationToken);

    /// <summary>
    /// Which rules an e-invoice Formfeed did not make passed: its XML (CII or UBL), up to 4 MB, from
    /// the Starter plan; a PDF is not taken. It takes one of the organisation's validations of the
    /// day. Needs <c>einvoice:validate</c>.
    /// </summary>
    /// <param name="file">The e-invoice.</param>
    /// <param name="rules"><c>auto</c> (the API's default), <c>factur-x</c>, <c>xrechnung</c> or <c>en16931</c>.</param>
    /// <param name="idempotencyKey">Ties the check to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    /// <returns>The report: <c>result</c>, the <c>checks</c> with their findings, <c>validator</c>, <c>rules</c> and <c>versions</c>.</returns>
    public Task<JsonElement> ValidateAsync(
        Upload file,
        string? rules = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        transport.ObjectAsync(
            HttpMethod.Post,
            "/einvoices/validate",
            transport.Multipart(new FieldList().Add("rules", rules), Guard.NotNull(file, nameof(file))),
            idempotencyKey ?? Ids.Key(),
            cancellationToken);
}

/// <summary>
/// The workspace's file library: images and PDFs a template names with <c>asset('logo.png')</c>, and
/// the sources of image watermarks and merges. Needs <c>file:read</c>, <c>file:write</c> or
/// <c>file:delete</c>. Files are served without a signature, so keep confidential documents out of it.
/// </summary>
public sealed class FileService
{
    private readonly Transport transport;

    internal FileService(Transport transport) => this.transport = transport;

    /// <summary>Uploads a file under its <see cref="Upload.Name"/>; one of the same name is replaced in place and keeps its address.</summary>
    public async Task<LibraryFile> UploadAsync(Upload file, CancellationToken cancellationToken = default)
    {
        Guard.NotNull(file, nameof(file));
        var json = await transport
            .ObjectAsync(HttpMethod.Post, "/files", transport.Multipart(new FieldList().Set("name", file.Name), file), null, cancellationToken)
            .ConfigureAwait(false);
        return LibraryFile.FromJson(json);
    }

    /// <summary>One page of files, newest first.</summary>
    public async Task<Page<LibraryFile>> ListAsync(FileListQuery? query = null, CancellationToken cancellationToken = default) =>
        await ListPageAsync(query, query?.Cursor, cancellationToken).ConfigureAwait(false);

    /// <summary>Every file the query matches, page by page as you iterate.</summary>
    public async IAsyncEnumerable<LibraryFile> ListAllAsync(
        FileListQuery? query = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        string? cursor = null;
        do
        {
            var page = await ListPageAsync(query, cursor, cancellationToken).ConfigureAwait(false);
            foreach (var file in page.Data)
            {
                yield return file;
            }
            cursor = page.NextCursor;
        }
        while (!string.IsNullOrEmpty(cursor));
    }

    /// <summary>A file by its id or its name.</summary>
    public async Task<LibraryFile> GetAsync(string idOrName, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Get, "/files/" + Ids.Path(idOrName), null, null, cancellationToken)
            .ConfigureAwait(false);
        return LibraryFile.FromJson(json);
    }

    /// <summary>Removes the file and its bytes; templates that name it render a missing image afterwards.</summary>
    public Task DeleteAsync(string idOrName, CancellationToken cancellationToken = default) =>
        transport.JsonAsync(HttpMethod.Delete, "/files/" + Ids.Path(idOrName), null, null, cancellationToken);

    /// <inheritdoc cref="DeleteAsync(string, CancellationToken)"/>
    public Task DeleteAsync(LibraryFile file, CancellationToken cancellationToken = default) =>
        DeleteAsync(Guard.NotNull(file, nameof(file)).Id, cancellationToken);

    private async Task<Page<LibraryFile>> ListPageAsync(FileListQuery? query, string? cursor, CancellationToken cancellationToken)
    {
        var path = "/files" + (query ?? new FileListQuery()).ToQuery(cursor);
        var json = await transport.ObjectAsync(HttpMethod.Get, path, null, null, cancellationToken).ConfigureAwait(false);
        return Page.FromJson(json, LibraryFile.FromJson);
    }
}

/// <summary>
/// The workspace's templates, read and checked. Writing them (versions, publishing, channels) is the
/// command line's and the app's; <see cref="FormfeedClient.RequestAsync"/> reaches those calls.
/// </summary>
public sealed class TemplateService
{
    private readonly Transport transport;

    internal TemplateService(Transport transport) => this.transport = transport;

    /// <summary>One page of templates, most recently changed first.</summary>
    public async Task<Page<Template>> ListAsync(TemplateListQuery? query = null, CancellationToken cancellationToken = default) =>
        await ListPageAsync(query, query?.Cursor, cancellationToken).ConfigureAwait(false);

    /// <summary>Every template the query matches, page by page as you iterate.</summary>
    public async IAsyncEnumerable<Template> ListAllAsync(
        TemplateListQuery? query = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        string? cursor = null;
        do
        {
            var page = await ListPageAsync(query, cursor, cancellationToken).ConfigureAwait(false);
            foreach (var template in page.Data)
            {
                yield return template;
            }
            cursor = page.NextCursor;
        }
        while (!string.IsNullOrEmpty(cursor));
    }

    /// <summary>A template by its slug, <c>tpl_…</c> id or UUID.</summary>
    public async Task<Template> GetAsync(string idOrSlug, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Get, "/templates/" + Ids.Path(idOrSlug), null, null, cancellationToken)
            .ConfigureAwait(false);
        return Template.FromJson(json);
    }

    /// <summary>
    /// The JSON Schema of the template's data: stored, else inferred from the sample data. Of the
    /// published (else the latest) version, or of <paramref name="version"/>: <c>published</c>,
    /// <c>latest</c>, a number or a channel name.
    /// </summary>
    public Task<JsonElement> GetSchemaAsync(
        string idOrSlug,
        string? version = null,
        CancellationToken cancellationToken = default) =>
        transport.ObjectAsync(
            HttpMethod.Get,
            "/templates/" + Ids.Path(idOrSlug) + "/schema" + new Query().Add("version", version),
            null,
            null,
            cancellationToken);

    /// <summary>
    /// Checks a version with data without rendering: syntax, header and footer, missing partials,
    /// runtime errors and the data against the stored schema. Free. Without data, the version's sample
    /// data is checked.
    /// </summary>
    /// <returns><c>ok</c>, the <c>template</c> checked and its <c>diagnostics</c>.</returns>
    public Task<JsonElement> ValidateAsync(
        string idOrSlug,
        TemplateValidation? input = null,
        CancellationToken cancellationToken = default) =>
        transport.ObjectAsync(
            HttpMethod.Post,
            "/templates/" + Ids.Path(idOrSlug) + "/validate",
            (input ?? new TemplateValidation()).ToFields(),
            null,
            cancellationToken);

    private async Task<Page<Template>> ListPageAsync(TemplateListQuery? query, string? cursor, CancellationToken cancellationToken)
    {
        var path = "/templates" + (query ?? new TemplateListQuery()).ToQuery(cursor);
        var json = await transport.ObjectAsync(HttpMethod.Get, path, null, null, cancellationToken).ConfigureAwait(false);
        return Page.FromJson(json, Template.FromJson);
    }
}

/// <summary>
/// The workspace's webhook endpoints. Needs <c>webhook:manage</c>. Verify a delivery with
/// <see cref="Webhook"/>.
/// </summary>
public sealed class WebhookService
{
    private readonly Transport transport;

    internal WebhookService(Transport transport) => this.transport = transport;

    /// <summary>Every endpoint of the workspace.</summary>
    public async Task<IReadOnlyList<WebhookEndpoint>> ListAsync(CancellationToken cancellationToken = default)
    {
        var json = await transport.ObjectAsync(HttpMethod.Get, "/webhooks", null, null, cancellationToken).ConfigureAwait(false);
        return ModelReader.Objects(json, "data", WebhookEndpoint.FromJson);
    }

    /// <summary>Registers an endpoint; the answer carries its <see cref="WebhookEndpoint.Secret"/>, once.</summary>
    public async Task<WebhookEndpoint> CreateAsync(WebhookCreate endpoint, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Post, "/webhooks", Guard.NotNull(endpoint, nameof(endpoint)).ToFields(), null, cancellationToken)
            .ConfigureAwait(false);
        return WebhookEndpoint.FromJson(json);
    }

    /// <summary>Changes an endpoint; what the update leaves null stays.</summary>
    public async Task<WebhookEndpoint> UpdateAsync(string id, WebhookUpdate update, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Put, "/webhooks/" + Ids.Path(id), Guard.NotNull(update, nameof(update)).ToFields(), null, cancellationToken)
            .ConfigureAwait(false);
        return WebhookEndpoint.FromJson(json);
    }

    /// <summary>Removes an endpoint.</summary>
    public Task DeleteAsync(string id, CancellationToken cancellationToken = default) =>
        transport.JsonAsync(HttpMethod.Delete, "/webhooks/" + Ids.Path(id), null, null, cancellationToken);

    /// <summary>Sends a test delivery to the endpoint.</summary>
    /// <returns><c>queued</c>.</returns>
    public Task<JsonElement> TestAsync(string id, CancellationToken cancellationToken = default) =>
        transport.ObjectAsync(HttpMethod.Post, "/webhooks/" + Ids.Path(id) + "/test", null, null, cancellationToken);

    /// <summary>Sends a stored event (<c>evt_…</c>) again as a new delivery to an endpoint.</summary>
    /// <returns>The new delivery: <c>delivery_id</c>, <c>event_id</c>, <c>event</c> and <c>endpoint_id</c>.</returns>
    public Task<JsonElement> ResendAsync(string eventId, string endpointId, CancellationToken cancellationToken = default) =>
        transport.ObjectAsync(
            HttpMethod.Post,
            "/webhooks/events/" + Ids.Path(eventId) + "/resend",
            new FieldList().Set("endpoint_id", Guard.NotNull(endpointId, nameof(endpointId))),
            null,
            cancellationToken);
}

/// <summary>The key's account and the units of a period.</summary>
public sealed class AccountService
{
    private readonly Transport transport;

    internal AccountService(Transport transport) => this.transport = transport;

    /// <summary>The key's workspace and organisation, its environment, and the plan with the period's units and limits.</summary>
    public Task<JsonElement> GetAsync(CancellationToken cancellationToken = default) =>
        transport.ObjectAsync(HttpMethod.Get, "/account", null, null, cancellationToken);

    /// <summary>The units of the current period, or of <c>YYYY-MM</c>, with a daily series and a breakdown per template.</summary>
    public async Task<Usage> GetUsageAsync(string period = "current", CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Get, "/usage?period=" + Ids.Path(period ?? "current"), null, null, cancellationToken)
            .ConfigureAwait(false);
        return Usage.FromJson(json);
    }
}
