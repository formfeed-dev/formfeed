using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// A batch, or a render queued with its own webhook URL: its renders in the order of the request and,
/// once they are done, a ZIP of their files.
/// </summary>
public sealed class Job : IJsonOnDeserialized
{
    /// <summary>The job id, <c>job_</c> and 32 hexadecimal digits.</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary><c>batch</c>, or <c>single</c> for the job a render with its own webhook URL gets.</summary>
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    /// <summary><c>queued</c>, <c>processing</c>, <c>completed</c>, <c>partially_failed</c> or <c>failed</c>.</summary>
    [JsonPropertyName("status")]
    public string Status { get; set; } = "";

    /// <summary>The number of items.</summary>
    [JsonPropertyName("total")]
    public int Total { get; set; }

    /// <summary>The items that succeeded so far.</summary>
    [JsonPropertyName("succeeded")]
    public int Succeeded { get; set; }

    /// <summary>The items that failed so far.</summary>
    [JsonPropertyName("failed")]
    public int Failed { get; set; }

    /// <summary>The link to the ZIP of the succeeded outputs, once a batch with <c>Zip</c> has finished.</summary>
    [JsonPropertyName("zip_url")]
    public string? ZipUrl { get; set; }

    /// <summary>When <see cref="ZipUrl"/> stops working.</summary>
    [JsonPropertyName("zip_expires_at")]
    public DateTimeOffset? ZipExpiresAt { get; set; }

    /// <summary>The ZIP's copy in the workspace's own bucket.</summary>
    [JsonPropertyName("storage")]
    public JsonElement? Storage { get; set; }

    /// <summary>Every item as a render, in the order of the request.</summary>
    [JsonIgnore]
    public IReadOnlyList<Render> Items { get; set; } = [];

    /// <summary>The <c>Meta</c> of the batch, unchanged.</summary>
    [JsonPropertyName("meta")]
    public IReadOnlyDictionary<string, JsonElement> Meta { get; set; } = Maps.Empty;

    /// <summary>When the job was created.</summary>
    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When its last item finished.</summary>
    [JsonPropertyName("completed_at")]
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>No render of it is queued or running any more.</summary>
    [JsonIgnore]
    public bool IsFinished => Status is not ("queued" or "processing");

    /// <summary>Reads a job, also one a <c>job.*</c> webhook event carries as its <c>data</c>.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not a job.</exception>
    public static Job FromJson(JsonElement json)
    {
        var job = ModelReader.Read(json, FormfeedJson.Default.Job);
        job.Items = ModelReader.Objects(json, "items", Render.FromJson);
        job.Raw = json.Clone();
        return job;
    }

    /// <summary>Reads a job from its JSON text.</summary>
    /// <exception cref="JsonException">when the text is not JSON.</exception>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not a job.</exception>
    public static Job FromJson(string json) => FromJson(ModelReader.Parse(json));

    void IJsonOnDeserialized.OnDeserialized()
    {
        Id ??= "";
        Type ??= "";
        Status ??= "";
        Meta ??= Maps.Empty;
    }
}

/// <summary>One page of a list, newest first, and the cursor of the next.</summary>
/// <typeparam name="T">What the list holds.</typeparam>
public sealed class Page<T>
{
    /// <summary>A page of the items given.</summary>
    public Page(IReadOnlyList<T> data, string? nextCursor)
    {
        Data = data ?? [];
        NextCursor = nextCursor;
    }

    /// <summary>The items of this page.</summary>
    public IReadOnlyList<T> Data { get; }

    /// <summary>The cursor of the next page; null on the last.</summary>
    public string? NextCursor { get; }
}

/// <summary>Reads pages of a list.</summary>
public static class Page
{
    /// <summary>Reads a page whose items <paramref name="item"/> reads, such as <see cref="Render.FromJson(JsonElement)"/>; entries that are not objects are left out.</summary>
    /// <typeparam name="T">What the list holds.</typeparam>
    public static Page<T> FromJson<T>(JsonElement json, Func<JsonElement, T> item) =>
        new(ModelReader.Objects(json, "data", Guard.NotNull(item, nameof(item))), ModelReader.String(json, "next_cursor"));
}
