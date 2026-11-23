using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Formfeed.Internal;

/// <summary>
/// A multipart body the way the API reads it, byte for byte as the PHP SDK sends it: the file as
/// <c>file</c> first, then the fields, strings as they are, booleans and numbers as text, lists and
/// objects as JSON text. A field without a value is left out, as a form field cannot say null, but
/// for redact's <c>fill</c>, whose null draws no box and goes as the text <c>null</c>.
/// </summary>
internal sealed class Multipart
{
    private readonly Upload? file;

    public Multipart(FieldList fields, Upload? file, JsonSerializerOptions? serializer)
    {
        this.file = file;
        Boundary = "formfeed-" + RandomHex(12);
        var text = new List<KeyValuePair<string, string>>();
        foreach (var field in fields)
        {
            if (field.Value is null && field.Key != "fill")
            {
                continue;
            }
            text.Add(new KeyValuePair<string, string>(field.Key, Text(field.Value, serializer)));
        }
        Fields = text;
    }

    public string Boundary { get; }

    public string ContentType => "multipart/form-data; boundary=" + Boundary;

    /// <summary>The fields as they are sent.</summary>
    public IReadOnlyList<KeyValuePair<string, string>> Fields { get; }

    public byte[] Body()
    {
        using var body = new MemoryStream();
        if (file is not null)
        {
            Ascii(body, $"--{Boundary}\r\n");
            Utf8(body, $"Content-Disposition: form-data; name=\"file\"; filename=\"{Quoted(file.Name)}\"\r\n");
            Utf8(body, $"Content-Type: {file.ContentType}\r\n\r\n");
            var contents = file.Contents.ToArray();
            body.Write(contents, 0, contents.Length);
            Ascii(body, "\r\n");
        }
        foreach (var field in Fields)
        {
            Ascii(body, $"--{Boundary}\r\n");
            Utf8(body, $"Content-Disposition: form-data; name=\"{Quoted(field.Key)}\"\r\n\r\n");
            Utf8(body, field.Value);
            Ascii(body, "\r\n");
        }
        Ascii(body, $"--{Boundary}--\r\n");
        return body.ToArray();
    }

    private static string Text(object? value, JsonSerializerOptions? serializer) => value switch
    {
        string text => text,
        bool flag => flag ? "true" : "false",
        int or long or short or byte or sbyte or ushort or uint or ulong or float or double or decimal =>
            Convert.ToString(value, CultureInfo.InvariantCulture) ?? "",
        _ => Encoding.UTF8.GetString(JsonWire.Encode(value, serializer)),
    };

    private static string Quoted(string value) =>
        value.Replace("\"", "%22").Replace("\r", "").Replace("\n", "");

    private static void Ascii(Stream to, string text) => Utf8(to, text);

    private static void Utf8(Stream to, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        to.Write(bytes, 0, bytes.Length);
    }

    private static string RandomHex(int length)
    {
        var bytes = new byte[length];
        using (var random = RandomNumberGenerator.Create())
        {
            random.GetBytes(bytes);
        }
        return Hex.Lower(bytes);
    }
}
