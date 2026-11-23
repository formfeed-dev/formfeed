using System.Text.Json;
using System.Text.Json.Serialization;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// An API problem (RFC 9457) as the API sent it: its <see cref="Type"/> names the docs page of its
/// <see cref="Code"/>, and <see cref="Raw"/> holds the members a code adds, such as <c>errors</c>,
/// <c>feature</c>, <c>limit</c> or an e-invoice's report.
/// </summary>
public sealed class Problem
{
    /// <summary>The problem's page, <c>https://docs.formfeed.dev/errors/…</c>.</summary>
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    /// <summary>A short English summary.</summary>
    [JsonPropertyName("title")]
    public string? Title { get; set; }

    /// <summary>The HTTP status.</summary>
    [JsonPropertyName("status")]
    public int? Status { get; set; }

    /// <summary>What went wrong, in English.</summary>
    [JsonPropertyName("detail")]
    public string? Detail { get; set; }

    /// <summary>The stable code, such as <c>quota_exceeded</c>.</summary>
    [JsonPropertyName("code")]
    public string? Code { get; set; }

    /// <summary>The request id, as <c>X-Request-Id</c> says it too.</summary>
    [JsonPropertyName("request_id")]
    public string? RequestId { get; set; }

    /// <summary>The problem as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads a problem document.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not an object.</exception>
    public static Problem FromJson(JsonElement json)
    {
        var problem = ModelReader.Read(json, FormfeedJson.Default.Problem);
        problem.Raw = json.Clone();
        return problem;
    }
}
