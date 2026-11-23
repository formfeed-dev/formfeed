using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// A file sent with a request: a PDF for the PDF tools, an office document to convert, an e-invoice
/// to validate, a file for the library. It is held in memory and sent as multipart; the API keeps
/// only what the library stores.
/// </summary>
public sealed class Upload
{
    private Upload(ReadOnlyMemory<byte> contents, string name, string contentType)
    {
        Contents = contents;
        Name = name;
        ContentType = contentType;
    }

    /// <summary>The bytes.</summary>
    public ReadOnlyMemory<byte> Contents { get; }

    /// <summary>The file name; for the library also the name templates use, such as <c>brand/logo.png</c>.</summary>
    public string Name { get; }

    /// <summary>The media type, from the name's extension unless given.</summary>
    public string ContentType { get; }

    /// <summary>A file of the disk, under its own name unless <paramref name="name"/> gives another.</summary>
    /// <exception cref="IOException">when the file cannot be read.</exception>
    public static Upload FromPath(string path, string? name = null, string? contentType = null)
    {
        var contents = File.ReadAllBytes(path);
        var fileName = name ?? Path.GetFileName(path);
        return new Upload(contents, fileName, contentType ?? TypeOf(fileName));
    }

    /// <summary>Bytes you have, under a name.</summary>
    public static Upload FromBytes(ReadOnlyMemory<byte> contents, string name, string? contentType = null) =>
        new(contents, Guard.NotNull(name, nameof(name)), contentType ?? TypeOf(name));

    /// <summary>The rest of a stream, read into memory, under a name.</summary>
    public static async Task<Upload> FromStreamAsync(
        Stream stream,
        string name,
        string? contentType = null,
        CancellationToken cancellationToken = default)
    {
        Guard.NotNull(stream, nameof(stream));
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, 81920, cancellationToken).ConfigureAwait(false);
        return FromBytes(buffer.ToArray(), name, contentType);
    }

    /// <summary>What the name says the file is; the API reads the format from the bytes either way.</summary>
    internal static string TypeOf(string name)
    {
        var extension = Path.GetExtension(name).TrimStart('.').ToUpperInvariant();
        return extension switch
        {
            "PDF" => "application/pdf",
            "XML" => "application/xml",
            "DOCX" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "XLSX" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "PPTX" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "ODT" => "application/vnd.oasis.opendocument.text",
            "ODS" => "application/vnd.oasis.opendocument.spreadsheet",
            "ODP" => "application/vnd.oasis.opendocument.presentation",
            "RTF" => "application/rtf",
            "HTML" or "HTM" => "text/html",
            "PNG" => "image/png",
            "JPG" or "JPEG" => "image/jpeg",
            "WEBP" => "image/webp",
            "GIF" => "image/gif",
            "SVG" => "image/svg+xml",
            _ => "application/octet-stream",
        };
    }
}
