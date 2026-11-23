using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Formfeed.Internal;

internal static class Ids
{
    /// <summary>A fresh Idempotency-Key, a UUID v4: every call that creates a render sends one, so a retry cannot charge twice.</summary>
    public static string Key() => Guid.NewGuid().ToString("D");

    /// <summary>One path segment, encoded.</summary>
    public static string Path(string id) => Uri.EscapeDataString(id);
}

internal static class Hex
{
    public static string Lower(byte[] bytes)
    {
        var text = new StringBuilder(bytes.Length * 2);
        foreach (var value in bytes)
        {
            text.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }
        return text.ToString();
    }
}

/// <summary><c>?a=1&amp;b=2</c> of the values that are set, or nothing; booleans as <c>true</c> and <c>false</c>.</summary>
internal sealed class Query
{
    private readonly List<string> pairs = [];

    public Query Add(string name, string? value)
    {
        if (!string.IsNullOrEmpty(value))
        {
            pairs.Add(Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(value));
        }
        return this;
    }

    public Query Add(string name, int? value) =>
        Add(name, value?.ToString(CultureInfo.InvariantCulture));

    public Query Add(string name, bool? value) =>
        Add(name, value is null ? null : value.Value ? "true" : "false");

    /// <summary>A time as ISO 8601: <c>2026-11-01T00:00:00Z</c>, or with its offset.</summary>
    public Query Add(string name, DateTimeOffset? value) =>
        Add(name, value is not { } moment
            ? null
            : moment.Offset == TimeSpan.Zero
                ? moment.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", CultureInfo.InvariantCulture)
                : moment.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz", CultureInfo.InvariantCulture));

    public override string ToString() => pairs.Count == 0 ? "" : "?" + string.Join("&", pairs);
}
