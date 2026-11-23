using System;
using System.Buffers;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Formfeed.Internal;

// Typed reads of an answer that never refuse it (plan 25): a field the API leaves out keeps its
// default, a value of another type than the SDK expects reads as missing, as the PHP SDK's Fields
// does, so an SDK of today reads the answers of a later API. The contract goldens hold that.

internal static class Maps
{
    public static readonly IReadOnlyDictionary<string, JsonElement> Empty =
        new ReadOnlyDictionary<string, JsonElement>(new Dictionary<string, JsonElement>());
}

/// <summary>A string, or a number as its text; anything else reads as missing.</summary>
internal sealed class LenientString : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.String:
                return reader.GetString();
            case JsonTokenType.Number:
                return Encoding.UTF8.GetString(reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan.ToArray());
            default:
                reader.Skip();
                return null;
        }
    }

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value);

    public override string ReadAsPropertyName(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetString() ?? "";

    public override void WriteAsPropertyName(Utf8JsonWriter writer, string value, JsonSerializerOptions options) =>
        writer.WritePropertyName(value);
}

internal static class Numbers
{
    /// <summary>The number at the reader, a fraction cut towards zero as PHP's <c>(int)</c> does; null for anything else.</summary>
    public static long? Whole(ref Utf8JsonReader reader)
    {
        if (reader.TokenType != JsonTokenType.Number)
        {
            reader.Skip();
            return null;
        }
        if (reader.TryGetInt64(out var whole))
        {
            return whole;
        }
        var value = reader.GetDouble();
        return value >= long.MaxValue ? long.MaxValue : value <= long.MinValue ? long.MinValue : (long)value;
    }

    public static double? Real(ref Utf8JsonReader reader)
    {
        if (reader.TokenType != JsonTokenType.Number)
        {
            reader.Skip();
            return null;
        }
        return reader.GetDouble();
    }

    public static int Narrow(long value) =>
        value > int.MaxValue ? int.MaxValue : value < int.MinValue ? int.MinValue : (int)value;
}

internal sealed class LenientInt32 : JsonConverter<int>
{
    public override int Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Numbers.Whole(ref reader) is { } value ? Numbers.Narrow(value) : 0;

    public override void Write(Utf8JsonWriter writer, int value, JsonSerializerOptions options) =>
        writer.WriteNumberValue(value);
}

internal sealed class LenientNullableInt32 : JsonConverter<int?>
{
    public override bool HandleNull => true;

    public override int? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Numbers.Whole(ref reader) is { } value ? Numbers.Narrow(value) : null;

    public override void Write(Utf8JsonWriter writer, int? value, JsonSerializerOptions options)
    {
        if (value is { } number)
        {
            writer.WriteNumberValue(number);
        }
        else
        {
            writer.WriteNullValue();
        }
    }
}

internal sealed class LenientInt64 : JsonConverter<long>
{
    public override long Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Numbers.Whole(ref reader) ?? 0;

    public override void Write(Utf8JsonWriter writer, long value, JsonSerializerOptions options) =>
        writer.WriteNumberValue(value);
}

internal sealed class LenientNullableInt64 : JsonConverter<long?>
{
    public override bool HandleNull => true;

    public override long? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Numbers.Whole(ref reader);

    public override void Write(Utf8JsonWriter writer, long? value, JsonSerializerOptions options)
    {
        if (value is { } number)
        {
            writer.WriteNumberValue(number);
        }
        else
        {
            writer.WriteNullValue();
        }
    }
}

internal sealed class LenientDouble : JsonConverter<double>
{
    public override double Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Numbers.Real(ref reader) ?? 0;

    public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options) =>
        writer.WriteNumberValue(value);
}

internal sealed class LenientNullableDouble : JsonConverter<double?>
{
    public override bool HandleNull => true;

    public override double? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Numbers.Real(ref reader);

    public override void Write(Utf8JsonWriter writer, double? value, JsonSerializerOptions options)
    {
        if (value is { } number)
        {
            writer.WriteNumberValue(number);
        }
        else
        {
            writer.WriteNullValue();
        }
    }
}

internal sealed class LenientBoolean : JsonConverter<bool>
{
    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.True:
                return true;
            case JsonTokenType.False:
                return false;
            default:
                reader.Skip();
                return false;
        }
    }

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options) =>
        writer.WriteBooleanValue(value);
}

internal static class Moments
{
    public static DateTimeOffset? Read(ref Utf8JsonReader reader)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            reader.Skip();
            return null;
        }
        return DateTimeOffset.TryParse(
            reader.GetString(),
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal,
            out var moment)
            ? moment
            : null;
    }

    public static void Write(Utf8JsonWriter writer, DateTimeOffset value) => writer.WriteStringValue(value);
}

internal sealed class LenientDateTimeOffset : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Moments.Read(ref reader) ?? default;

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        Moments.Write(writer, value);
}

internal sealed class LenientNullableDateTimeOffset : JsonConverter<DateTimeOffset?>
{
    public override bool HandleNull => true;

    public override DateTimeOffset? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Moments.Read(ref reader);

    public override void Write(Utf8JsonWriter writer, DateTimeOffset? value, JsonSerializerOptions options)
    {
        if (value is { } moment)
        {
            Moments.Write(writer, moment);
        }
        else
        {
            writer.WriteNullValue();
        }
    }
}

/// <summary>The strings of a list; other entries are left out, and anything but a list reads as an empty one.</summary>
internal sealed class LenientStrings : JsonConverter<IReadOnlyList<string>>
{
    public override bool HandleNull => true;

    public override IReadOnlyList<string> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray)
        {
            reader.Skip();
            return [];
        }
        var list = new List<string>();
        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            if (reader.TokenType == JsonTokenType.String)
            {
                list.Add(reader.GetString() ?? "");
            }
            else
            {
                reader.Skip();
            }
        }
        return list;
    }

    public override void Write(Utf8JsonWriter writer, IReadOnlyList<string> value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        foreach (var item in value)
        {
            writer.WriteStringValue(item);
        }
        writer.WriteEndArray();
    }
}

/// <summary>An object as a map of its members; anything else reads as an empty map.</summary>
internal sealed class LenientMap : JsonConverter<IReadOnlyDictionary<string, JsonElement>>
{
    public override bool HandleNull => true;

    public override IReadOnlyDictionary<string, JsonElement> Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartObject)
        {
            reader.Skip();
            return Maps.Empty;
        }
        var map = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            var name = reader.GetString() ?? "";
            reader.Read();
            map[name] = JsonElement.ParseValue(ref reader);
        }
        return new ReadOnlyDictionary<string, JsonElement>(map);
    }

    public override void Write(
        Utf8JsonWriter writer,
        IReadOnlyDictionary<string, JsonElement> value,
        JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        foreach (var entry in value)
        {
            writer.WritePropertyName(entry.Key);
            entry.Value.WriteTo(writer);
        }
        writer.WriteEndObject();
    }
}
