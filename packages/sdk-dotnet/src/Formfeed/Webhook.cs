using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// Checks a webhook delivery: <c>Webhook-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</c>, the HMAC-SHA256
/// of <c>&lt;t&gt;.&lt;raw body&gt;</c> with the endpoint's secret, at most 300 seconds either way,
/// compared in constant time. Pass the body exactly as it arrived: the signature covers the bytes on
/// the wire, not JSON written again.
/// </summary>
/// <example>
/// <code>
/// var body = await new StreamReader(request.Body).ReadToEndAsync();
/// var evt = Webhook.Parse(secret, request.Headers["Webhook-Signature"], body);
/// </code>
/// </example>
public static class Webhook
{
    /// <summary>How far a delivery's time may lie from the clock: five minutes either way.</summary>
    public static readonly TimeSpan DefaultTolerance = TimeSpan.FromSeconds(300);

    // what PHP's trim() takes off, the rule every Formfeed SDK reads the header by
    private static readonly char[] Blank = [' ', '\t', '\n', '\r', '\0', '\x0B'];

    /// <summary>Whether the signature matches the body and is recent enough.</summary>
    /// <param name="secret">The endpoint's signing secret, <c>whsec_…</c>.</param>
    /// <param name="signatureHeader">The <c>Webhook-Signature</c> header; null when there was none.</param>
    /// <param name="rawBody">The body as it arrived, read as UTF-8.</param>
    /// <param name="tolerance">How far the delivery's time may lie from <paramref name="now"/>; five minutes by default.</param>
    /// <param name="now">The clock; the current time by default.</param>
    public static bool Verify(
        string secret,
        string? signatureHeader,
        string rawBody,
        TimeSpan? tolerance = null,
        DateTimeOffset? now = null) =>
        Verify(secret, signatureHeader, Encoding.UTF8.GetBytes(rawBody ?? ""), tolerance, now);

    /// <summary>Whether the signature matches the body's bytes and is recent enough.</summary>
    /// <param name="secret">The endpoint's signing secret, <c>whsec_…</c>.</param>
    /// <param name="signatureHeader">The <c>Webhook-Signature</c> header; null when there was none.</param>
    /// <param name="rawBody">The bytes of the body as they arrived.</param>
    /// <param name="tolerance">How far the delivery's time may lie from <paramref name="now"/>; five minutes by default.</param>
    /// <param name="now">The clock; the current time by default.</param>
    public static bool Verify(
        string secret,
        string? signatureHeader,
        byte[] rawBody,
        TimeSpan? tolerance = null,
        DateTimeOffset? now = null)
    {
        if (string.IsNullOrEmpty(signatureHeader) || string.IsNullOrEmpty(secret))
        {
            return false;
        }
        var parts = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in signatureHeader!.Split(','))
        {
            var trimmed = pair.Trim(Blank);
            var at = trimmed.IndexOf('=');
            var key = (at < 0 ? trimmed : trimmed.Substring(0, at)).Trim(Blank);
            parts[key] = at < 0 ? "" : trimmed.Substring(at + 1).Trim(Blank);
        }
        var t = parts.TryGetValue("t", out var stamp) ? stamp : "";
        var v1 = parts.TryGetValue("v1", out var signature) ? signature.ToLowerInvariant() : "";
        if (!IsDigits(t) || v1.Length != 64 || !IsHex(v1))
        {
            return false;
        }
        if (!long.TryParse(t, NumberStyles.None, CultureInfo.InvariantCulture, out var time))
        {
            return false;
        }
        var clock = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
        if (Math.Abs(clock - time) > (tolerance ?? DefaultTolerance).TotalSeconds)
        {
            return false;
        }

        var prefix = Encoding.UTF8.GetBytes(time.ToString(CultureInfo.InvariantCulture) + ".");
        var message = new byte[prefix.Length + (rawBody?.Length ?? 0)];
        Buffer.BlockCopy(prefix, 0, message, 0, prefix.Length);
        if (rawBody is not null)
        {
            Buffer.BlockCopy(rawBody, 0, message, prefix.Length, rawBody.Length);
        }
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return EqualInConstantTime(Hex.Lower(hmac.ComputeHash(message)), v1);
    }

    /// <summary>The event of a verified delivery.</summary>
    /// <param name="secret">The endpoint's signing secret, <c>whsec_…</c>.</param>
    /// <param name="signatureHeader">The <c>Webhook-Signature</c> header; null when there was none.</param>
    /// <param name="rawBody">The body as it arrived, read as UTF-8.</param>
    /// <param name="tolerance">How far the delivery's time may lie from <paramref name="now"/>; five minutes by default.</param>
    /// <param name="now">The clock; the current time by default.</param>
    /// <exception cref="WebhookSignatureException">when the signature does not match.</exception>
    /// <exception cref="JsonException">when the body is not JSON.</exception>
    public static WebhookEvent Parse(
        string secret,
        string? signatureHeader,
        string rawBody,
        TimeSpan? tolerance = null,
        DateTimeOffset? now = null) =>
        Parse(secret, signatureHeader, Encoding.UTF8.GetBytes(rawBody ?? ""), tolerance, now);

    /// <summary>The event of a verified delivery, from the body's bytes.</summary>
    /// <param name="secret">The endpoint's signing secret, <c>whsec_…</c>.</param>
    /// <param name="signatureHeader">The <c>Webhook-Signature</c> header; null when there was none.</param>
    /// <param name="rawBody">The bytes of the body as they arrived.</param>
    /// <param name="tolerance">How far the delivery's time may lie from <paramref name="now"/>; five minutes by default.</param>
    /// <param name="now">The clock; the current time by default.</param>
    /// <exception cref="WebhookSignatureException">when the signature does not match.</exception>
    /// <exception cref="JsonException">when the body is not JSON.</exception>
    public static WebhookEvent Parse(
        string secret,
        string? signatureHeader,
        byte[] rawBody,
        TimeSpan? tolerance = null,
        DateTimeOffset? now = null)
    {
        if (!Verify(secret, signatureHeader, rawBody, tolerance, now))
        {
            throw new WebhookSignatureException("invalid webhook signature");
        }
        var json = ModelReader.Parse(rawBody);
        if (json.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("the webhook body is not a JSON object");
        }
        return WebhookEvent.FromJson(json);
    }

    private static bool IsDigits(string text)
    {
        if (text.Length == 0)
        {
            return false;
        }
        foreach (var c in text)
        {
            if (c is < '0' or > '9')
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsHex(string text)
    {
        foreach (var c in text)
        {
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Compares two strings of the same length without stopping at the first difference.</summary>
    private static bool EqualInConstantTime(string expected, string actual)
    {
        if (expected.Length != actual.Length)
        {
            return false;
        }
        var difference = 0;
        for (var i = 0; i < expected.Length; i++)
        {
            difference |= expected[i] ^ actual[i];
        }
        return difference == 0;
    }
}

/// <summary>A webhook delivery whose signature does not match its body, or that is too old.</summary>
public sealed class WebhookSignatureException : Exception
{
    /// <summary>The error with its message.</summary>
    public WebhookSignatureException(string message)
        : base(message)
    {
    }

    /// <summary>The error with its message and cause.</summary>
    public WebhookSignatureException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>The error with the default message.</summary>
    public WebhookSignatureException()
        : base("invalid webhook signature")
    {
    }
}
