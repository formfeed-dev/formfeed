using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// The PDF tools, on the output of an earlier render, a PDF of the file library, or, for info,
/// split, compress, to-image, redact, fill and convert, an <see cref="Upload"/>, which is never
/// stored. Every tool but info answers a new render, on the Starter plan and above: merge, protect,
/// watermark, split, compress, redact and fill cost 0.5 units each on live keys, to-image one unit
/// per picture; info is free. Each of them sends an Idempotency-Key, generated unless you pass one.
/// </summary>
public sealed class PdfService
{
    private readonly Transport transport;

    internal PdfService(Transport transport) => this.transport = transport;

    /// <summary>Joins PDFs in the order given.</summary>
    /// <param name="sources">Renders, library files, their ids or library names.</param>
    /// <param name="options">The output's name and retention.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> MergeAsync(
        IEnumerable<StoredPdf> sources,
        MergeOptions? options = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default)
    {
        var ids = new List<string>();
        foreach (var source in Guard.NotNull(sources, nameof(sources)))
        {
            ids.Add(Guard.NotNull(source, nameof(sources)).Id);
        }
        var fields = (options ?? new MergeOptions()).ToFields().Set("sources", ids);
        return RenderAsync("/pdf/merge", fields, idempotencyKey, cancellationToken);
    }

    /// <summary>Encrypts a PDF with AES-256.</summary>
    /// <param name="source">A render, a library file, its id or library name.</param>
    /// <param name="options">The passwords and permissions.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> ProtectAsync(
        StoredPdf source,
        ProtectOptions options,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/protect", Stored(source, Guard.NotNull(options, nameof(options))), idempotencyKey, cancellationToken);

    /// <summary>Stamps a text or a library image on the pages.</summary>
    /// <param name="source">A render, a library file, its id or library name.</param>
    /// <param name="options">The text or image and how it is drawn.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> WatermarkAsync(
        StoredPdf source,
        WatermarkOptions options,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/watermark", Stored(source, Guard.NotNull(options, nameof(options))), idempotencyKey, cancellationToken);

    /// <summary>
    /// Page count, page sizes, encryption, metadata and the form with every field's name, type, value
    /// and options, which is how a form's names are found for <see cref="FillAsync"/>. Free; creates
    /// no render and sends no Idempotency-Key.
    /// </summary>
    /// <param name="source">A stored PDF or an upload.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public async Task<PdfInfo> GetInfoAsync(PdfSource source, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Post, "/pdf/info", Body(source, new FieldList()), null, cancellationToken)
            .ConfigureAwait(false);
        return PdfInfo.FromJson(json);
    }

    /// <summary>
    /// Cuts a PDF into parts, <c>Every</c> pages each or one per entry of <c>Ranges</c>: a ZIP of the
    /// parts, or the PDF itself for one part.
    /// </summary>
    /// <param name="source">A stored PDF or an upload.</param>
    /// <param name="options">Where to cut.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> SplitAsync(
        PdfSource source,
        SplitOptions options,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/split", Body(source, Guard.NotNull(options, nameof(options)).ToFields()), idempotencyKey, cancellationToken);

    /// <summary>Makes a PDF smaller; the render keeps the source when it cannot.</summary>
    /// <param name="source">A stored PDF or an upload.</param>
    /// <param name="options">The output's name and retention.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> CompressAsync(
        PdfSource source,
        CompressOptions? options = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/compress", Body(source, (options ?? new CompressOptions()).ToFields()), idempotencyKey, cancellationToken);

    /// <summary>Draws pages as PNG or JPEG pictures: one page answers the picture, several a ZIP of them.</summary>
    /// <param name="source">A stored PDF or an upload.</param>
    /// <param name="options">The pages, format and resolution.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> ToImageAsync(
        PdfSource source,
        ToImageOptions? options = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/to-image", Body(source, (options ?? new ToImageOptions()).ToFields()), idempotencyKey, cancellationToken);

    /// <summary>
    /// Removes what lies under the rectangles and every place a text stands, from the file itself, and
    /// reads the result again: text still there fails the render with <c>redaction_incomplete</c>,
    /// which names regions and texts by number, never a text.
    /// </summary>
    /// <param name="source">A stored PDF or an upload.</param>
    /// <param name="options">The rectangles and texts.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> RedactAsync(
        PdfSource source,
        RedactOptions options,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/redact", Body(source, Guard.NotNull(options, nameof(options)).ToFields()), idempotencyKey, cancellationToken);

    /// <summary>
    /// Fills a form's fields by their full names and keeps it fillable, or with <c>Flatten</c> draws the
    /// values into the pages. The values are never stored.
    /// </summary>
    /// <param name="source">A stored PDF or an upload.</param>
    /// <param name="options">The values.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> FillAsync(
        PdfSource source,
        FillOptions options,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/fill", Body(source, Guard.NotNull(options, nameof(options)).ToFields()), idempotencyKey, cancellationToken);

    /// <summary>
    /// Converts an office document to a PDF render (Starter plan and above): an upload (Word, Excel,
    /// PowerPoint, OpenDocument, RTF or HTML, up to 20 MB, not kept), or the output of a Word or
    /// PowerPoint template render.
    /// </summary>
    /// <param name="source">An upload, or a render or its id.</param>
    /// <param name="options">The pages and layout.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public Task<Render> ConvertAsync(
        PdfSource source,
        ConvertOptions? options = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        RenderAsync("/pdf/convert", Body(source, (options ?? new ConvertOptions()).ToFields()), idempotencyKey, cancellationToken);

    private async Task<Render> RenderAsync(
        string path,
        object body,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Post, path, body, idempotencyKey ?? Ids.Key(), cancellationToken)
            .ConfigureAwait(false);
        return Render.FromJson(json);
    }

    private static FieldList Stored(StoredPdf source, PdfToolOptions options) =>
        options.ToFields().Set("source", Guard.NotNull(source, nameof(source)).Id);

    /// <summary>A tool's request: a stored source by its id as JSON, an upload as multipart beside the options.</summary>
    private object Body(PdfSource source, FieldList options)
    {
        Guard.NotNull(source, nameof(source));
        return source.Upload is { } upload
            ? transport.Multipart(options, upload)
            : options.Set("source", source.Stored!.Id);
    }
}
