using System;
using System.Collections;
using System.Collections.Generic;
#if NET
using System.Diagnostics.CodeAnalysis;
#endif
using System.Globalization;
using System.IO;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Formfeed.Internal;

/// <summary>
/// Writes a request as JSON without reflection, so the SDK trims: dictionaries, lists, strings,
/// numbers, booleans, dates and the JSON types of System.Text.Json are written as they are. A value
/// of any other type (an object of your own in <c>Data</c>) goes through the
/// <see cref="FormfeedClientOptions.JsonSerializerOptions"/>, or the default options where an
/// application allows reflection.
/// </summary>
internal static class JsonWire
{
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        // the body goes to an API, never into a page: non-ASCII text stays as it is, as PHP sends it
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static byte[] Encode(object? value, JsonSerializerOptions? serializer)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            Write(writer, value, serializer);
        }
        return buffer.ToArray();
    }

    public static void Write(Utf8JsonWriter writer, object? value, JsonSerializerOptions? serializer)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                return;
            case string text:
                writer.WriteStringValue(text);
                return;
            case bool flag:
                writer.WriteBooleanValue(flag);
                return;
            case char character:
                writer.WriteStringValue(character.ToString());
                return;
            case int number:
                writer.WriteNumberValue(number);
                return;
            case long number:
                writer.WriteNumberValue(number);
                return;
            case short number:
                writer.WriteNumberValue(number);
                return;
            case byte number:
                writer.WriteNumberValue(number);
                return;
            case sbyte number:
                writer.WriteNumberValue(number);
                return;
            case ushort number:
                writer.WriteNumberValue(number);
                return;
            case uint number:
                writer.WriteNumberValue(number);
                return;
            case ulong number:
                writer.WriteNumberValue(number);
                return;
            case float number:
                writer.WriteNumberValue(Finite(number));
                return;
            case double number:
                writer.WriteNumberValue(Finite(number));
                return;
            case decimal number:
                writer.WriteNumberValue(number);
                return;
            case DateTimeOffset moment:
                writer.WriteStringValue(moment);
                return;
            case DateTime moment:
                writer.WriteStringValue(moment);
                return;
            case Guid id:
                writer.WriteStringValue(id);
                return;
            case Uri uri:
                writer.WriteStringValue(uri.IsAbsoluteUri ? uri.AbsoluteUri : uri.OriginalString);
                return;
            case Enum member:
                writer.WriteStringValue(member.ToString());
                return;
            case JsonElement element:
                if (element.ValueKind == JsonValueKind.Undefined)
                {
                    writer.WriteNullValue();
                }
                else
                {
                    element.WriteTo(writer);
                }
                return;
            case JsonDocument document:
                document.WriteTo(writer);
                return;
            case JsonNode node:
                node.WriteTo(writer);
                return;
            case byte[] bytes:
                writer.WriteBase64StringValue(bytes);
                return;
            // the SDK's own requests, also when one is handed to RequestAsync
            case RenderRequest request:
                Write(writer, request.ToFields(), serializer);
                return;
            case BatchRequest request:
                Write(writer, request.ToFields(), serializer);
                return;
            case PdfToolOptions request:
                Write(writer, request.ToFields(), serializer);
                return;
            case RedactRegion request:
                Write(writer, request.ToFields(), serializer);
                return;
            case TemplateValidation request:
                Write(writer, request.ToFields(), serializer);
                return;
            case WebhookCreate request:
                Write(writer, request.ToFields(), serializer);
                return;
            case WebhookUpdate request:
                Write(writer, request.ToFields(), serializer);
                return;
            case IEnumerable<KeyValuePair<string, object?>> map:
                writer.WriteStartObject();
                foreach (var entry in map)
                {
                    writer.WritePropertyName(entry.Key);
                    Write(writer, entry.Value, serializer);
                }
                writer.WriteEndObject();
                return;
            case IDictionary dictionary:
                writer.WriteStartObject();
                foreach (DictionaryEntry entry in dictionary)
                {
                    writer.WritePropertyName(Convert.ToString(entry.Key, CultureInfo.InvariantCulture) ?? "");
                    Write(writer, entry.Value, serializer);
                }
                writer.WriteEndObject();
                return;
            case IEnumerable list:
                writer.WriteStartArray();
                foreach (var item in list)
                {
                    Write(writer, item, serializer);
                }
                writer.WriteEndArray();
                return;
            default:
                WriteOther(writer, value, serializer);
                return;
        }
    }

    private static void WriteOther(Utf8JsonWriter writer, object value, JsonSerializerOptions? serializer)
    {
        var type = value.GetType();
        var options = serializer ?? ReflectionOptions();
        JsonTypeInfo info;
        try
        {
            info = options?.GetTypeInfo(type) ?? throw new NotSupportedException("reflection is disabled");
        }
        catch (Exception e) when (e is NotSupportedException or InvalidOperationException)
        {
            throw new ArgumentException(
                $"cannot write a {type.Name} as JSON: use dictionaries, lists and JSON values, or set "
                + "FormfeedClientOptions.JsonSerializerOptions to options whose resolver knows the type",
                nameof(value),
                e);
        }
        JsonSerializer.Serialize(writer, value, info);
    }

    /// <summary>
    /// The default options where the application serializes by reflection, else null: a trimmed or
    /// native AOT application switches reflection off, and there only options the caller gave can
    /// write an object of the caller's own, which the error then says.
    /// </summary>
#if NET
    [UnconditionalSuppressMessage(
        "Trimming",
        "IL2026",
        Justification = "Reached only while JsonSerializer.IsReflectionEnabledByDefault, which trimming switches off.")]
    [UnconditionalSuppressMessage(
        "AOT",
        "IL3050",
        Justification = "Reached only while JsonSerializer.IsReflectionEnabledByDefault, which native AOT switches off.")]
#endif
    private static JsonSerializerOptions? ReflectionOptions() =>
        JsonSerializer.IsReflectionEnabledByDefault ? JsonSerializerOptions.Default : null;

    private static double Finite(double number) =>
        double.IsNaN(number) || double.IsInfinity(number)
            ? throw new ArgumentException($"JSON has no number {number}", nameof(number))
            : number;

    private static float Finite(float number) =>
        float.IsNaN(number) || float.IsInfinity(number)
            ? throw new ArgumentException($"JSON has no number {number}", nameof(number))
            : number;
}
