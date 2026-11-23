using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Formfeed.Internal;

/// <summary>
/// The models' JSON, generated at build time, so reading an answer needs no reflection and the SDK
/// trims. Every scalar goes through the lenient converters (<c>Lenient.cs</c>).
/// </summary>
[JsonSourceGenerationOptions(
    GenerationMode = JsonSourceGenerationMode.Metadata,
    Converters = new[]
    {
        typeof(LenientString),
        typeof(LenientInt32),
        typeof(LenientNullableInt32),
        typeof(LenientInt64),
        typeof(LenientNullableInt64),
        typeof(LenientDouble),
        typeof(LenientNullableDouble),
        typeof(LenientBoolean),
        typeof(LenientDateTimeOffset),
        typeof(LenientNullableDateTimeOffset),
        typeof(LenientStrings),
        typeof(LenientMap),
    })]
[JsonSerializable(typeof(Render))]
[JsonSerializable(typeof(Job))]
[JsonSerializable(typeof(RenderInput))]
[JsonSerializable(typeof(Problem))]
[JsonSerializable(typeof(LibraryFile))]
[JsonSerializable(typeof(Template))]
[JsonSerializable(typeof(Usage))]
[JsonSerializable(typeof(UsageDay))]
[JsonSerializable(typeof(UsageByTemplate))]
[JsonSerializable(typeof(PdfInfo))]
[JsonSerializable(typeof(PdfPage))]
[JsonSerializable(typeof(WebhookEndpoint))]
[JsonSerializable(typeof(WebhookEvent))]
internal sealed partial class FormfeedJson : JsonSerializerContext
{
}

internal static class ModelReader
{
    /// <summary>The model of an object; an answer the SDK cannot read at all is <c>invalid_response</c>.</summary>
    public static T Read<T>(JsonElement json, JsonTypeInfo<T> info)
        where T : class
    {
        if (json.ValueKind != JsonValueKind.Object)
        {
            throw new FormfeedException(
                "invalid_response",
                $"a {typeof(T).Name} is a JSON object, not {json.ValueKind}");
        }
        try
        {
            return json.Deserialize(info)
                ?? throw new FormfeedException("invalid_response", $"no {typeof(T).Name} in the answer");
        }
        catch (JsonException e)
        {
            throw new FormfeedException(
                "invalid_response",
                $"the answer is not a {typeof(T).Name} this SDK can read: {e.Message}",
                0,
                null,
                null,
                e);
        }
    }

    /// <summary>The entries of a member's list that are objects, each read with <paramref name="read"/>.</summary>
    public static IReadOnlyList<T> Objects<T>(JsonElement json, string name, Func<JsonElement, T> read)
    {
        if (json.ValueKind != JsonValueKind.Object
            || !json.TryGetProperty(name, out var list)
            || list.ValueKind != JsonValueKind.Array)
        {
            return [];
        }
        var items = new List<T>();
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object)
            {
                items.Add(read(item));
            }
        }
        return items;
    }

    /// <summary>A member that is a string, else null.</summary>
    public static string? String(JsonElement json, string name) =>
        json.ValueKind == JsonValueKind.Object
        && json.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>Parses JSON text, a UTF-8 byte order mark included.</summary>
    public static JsonElement Parse(byte[] utf8)
    {
        var start = utf8.Length >= 3 && utf8[0] == 0xEF && utf8[1] == 0xBB && utf8[2] == 0xBF ? 3 : 0;
        using var document = JsonDocument.Parse(new ReadOnlyMemory<byte>(utf8, start, utf8.Length - start));
        return document.RootElement.Clone();
    }

    public static JsonElement Parse(string text) => Parse(Encoding.UTF8.GetBytes(text));
}
