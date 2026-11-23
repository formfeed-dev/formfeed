using System;

namespace Formfeed;

/// <summary>
/// A PDF Formfeed stores: the output of a render (a <see cref="Render"/> or its <c>rnd_…</c> id) or a
/// PDF of the file library (a <see cref="LibraryFile"/>, its <c>fil_…</c> id or its name, such as
/// <c>terms.pdf</c>). A string, a render or a library file converts to it by itself.
/// </summary>
public sealed class StoredPdf
{
    private StoredPdf(string id) => Id = id;

    /// <summary>The id or library name the request names.</summary>
    public string Id { get; }

    /// <summary>A render id, a library file id or a library name.</summary>
    public static StoredPdf FromId(string id) =>
        new(string.IsNullOrEmpty(id) ? throw new ArgumentException("a source needs an id or a name", nameof(id)) : id);

    /// <summary>The output of a render.</summary>
    public static StoredPdf FromRender(Render render) =>
        FromId((render ?? throw new ArgumentNullException(nameof(render))).Id);

    /// <summary>A PDF of the library.</summary>
    public static StoredPdf FromFile(LibraryFile file) =>
        FromId((file ?? throw new ArgumentNullException(nameof(file))).Id);

    /// <summary>A render id, a library file id or a library name.</summary>
    public static implicit operator StoredPdf(string id) => FromId(id);

    /// <summary>The output of a render.</summary>
    public static implicit operator StoredPdf(Render render) => FromRender(render);

    /// <summary>A PDF of the library.</summary>
    public static implicit operator StoredPdf(LibraryFile file) => FromFile(file);

    /// <inheritdoc/>
    public override string ToString() => Id;
}

/// <summary>
/// The source of a PDF tool: a PDF Formfeed stores (<see cref="StoredPdf"/>), sent by its id as JSON,
/// or an <see cref="Formfeed.Upload"/>, sent as multipart and never stored. A string, a render, a
/// library file or an upload converts to it by itself.
/// </summary>
public sealed class PdfSource
{
    private PdfSource(StoredPdf? stored, Upload? upload)
    {
        Stored = stored;
        Upload = upload;
    }

    /// <summary>The stored PDF, or null for an upload.</summary>
    public StoredPdf? Stored { get; }

    /// <summary>The upload, or null for a stored PDF.</summary>
    public Upload? Upload { get; }

    /// <summary>A stored PDF.</summary>
    public static PdfSource FromStored(StoredPdf stored) =>
        new(stored ?? throw new ArgumentNullException(nameof(stored)), null);

    /// <summary>A file of yours, sent with the request and not kept.</summary>
    public static PdfSource FromUpload(Upload upload) =>
        new(null, upload ?? throw new ArgumentNullException(nameof(upload)));

    /// <summary>A render id, a library file id or a library name.</summary>
    public static PdfSource FromId(string id) => FromStored(StoredPdf.FromId(id));

    /// <summary>A render id, a library file id or a library name.</summary>
    public static implicit operator PdfSource(string id) => FromId(id);

    /// <summary>The output of a render.</summary>
    public static implicit operator PdfSource(Render render) => FromStored(StoredPdf.FromRender(render));

    /// <summary>A PDF of the library.</summary>
    public static implicit operator PdfSource(LibraryFile file) => FromStored(StoredPdf.FromFile(file));

    /// <summary>A stored PDF.</summary>
    public static implicit operator PdfSource(StoredPdf stored) => FromStored(stored);

    /// <summary>A file of yours, sent with the request and not kept.</summary>
    public static implicit operator PdfSource(Upload upload) => FromUpload(upload);

    /// <inheritdoc/>
    public override string ToString() => Stored?.Id ?? Upload?.Name ?? "";
}
