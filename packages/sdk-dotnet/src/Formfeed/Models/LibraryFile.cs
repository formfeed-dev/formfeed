using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>A file of the workspace's library: an image or PDF a template names, served at <see cref="Url"/>.</summary>
public sealed class LibraryFile : IJsonOnDeserialized
{
    /// <summary>The file id, <c>fil_</c> and 32 hexadecimal digits.</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>The library name templates reference it by, such as <c>brand/logo.png</c>.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>The media type, such as <c>image/png</c>.</summary>
    [JsonPropertyName("content_type")]
    public string ContentType { get; set; } = "";

    /// <summary>The size in bytes.</summary>
    [JsonPropertyName("bytes")]
    public long Bytes { get; set; }

    /// <summary>The hash of the stored bytes.</summary>
    [JsonPropertyName("sha256")]
    public string Sha256 { get; set; } = "";

    /// <summary>The CDN address, the one <c>asset(name)</c> produces in a template.</summary>
    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    /// <summary>When the file was first stored.</summary>
    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When the name was last replaced.</summary>
    [JsonPropertyName("updated_at")]
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads a library file.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not one.</exception>
    public static LibraryFile FromJson(JsonElement json)
    {
        var file = ModelReader.Read(json, FormfeedJson.Default.LibraryFile);
        file.Raw = json.Clone();
        return file;
    }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Id ??= "";
        Name ??= "";
        ContentType ??= "";
        Sha256 ??= "";
        Url ??= "";
    }
}

/// <summary>A template of the workspace, without its versions' content.</summary>
public sealed class Template : IJsonOnDeserialized
{
    /// <summary>The template id, <c>tpl_</c> and 32 hexadecimal digits.</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>The name a render uses as <c>Template</c>, unique in the workspace.</summary>
    [JsonPropertyName("slug")]
    public string Slug { get; set; } = "";

    /// <summary>The template's name.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>Its description.</summary>
    [JsonPropertyName("description")]
    public string? Description { get; set; }

    /// <summary><c>pdf</c>, <c>image</c>, <c>docx</c> or <c>pptx</c>.</summary>
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = "";

    /// <summary>The template language: <c>jinja2</c>, <c>liquid</c> or <c>handlebars</c>.</summary>
    [JsonPropertyName("engine")]
    public string Engine { get; set; } = "";

    /// <summary>Its tags.</summary>
    [JsonPropertyName("tags")]
    public IReadOnlyList<string> Tags { get; set; } = [];

    /// <summary>The number of the published version; null before the first publish.</summary>
    [JsonPropertyName("published_version")]
    public int? PublishedVersion { get; set; }

    /// <summary>The number of the newest version, published or not.</summary>
    [JsonPropertyName("latest_version")]
    public int LatestVersion { get; set; }

    /// <summary>When the template was created.</summary>
    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When it last changed.</summary>
    [JsonPropertyName("updated_at")]
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads a template.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not one.</exception>
    public static Template FromJson(JsonElement json)
    {
        var template = ModelReader.Read(json, FormfeedJson.Default.Template);
        template.Raw = json.Clone();
        return template;
    }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Id ??= "";
        Slug ??= "";
        Name ??= "";
        Kind ??= "";
        Engine ??= "";
        Tags ??= [];
    }
}

/// <summary>A registered webhook endpoint. <see cref="Secret"/> is only in the answer that created it.</summary>
public sealed class WebhookEndpoint : IJsonOnDeserialized
{
    /// <summary>The endpoint id, a UUID.</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>The address deliveries go to.</summary>
    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    /// <summary>The events it receives, such as <c>render.completed</c>.</summary>
    [JsonPropertyName("events")]
    public IReadOnlyList<string> Events { get; set; } = [];

    /// <summary>The render environments whose events it receives: <c>live</c>, <c>test</c>.</summary>
    [JsonPropertyName("environments")]
    public IReadOnlyList<string> Environments { get; set; } = [];

    /// <summary>Whether events are delivered.</summary>
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>Your note on the endpoint.</summary>
    [JsonPropertyName("description")]
    public string? Description { get; set; }

    /// <summary>Events in a row whose retries were exhausted; five switch the endpoint off.</summary>
    [JsonPropertyName("consecutive_failures")]
    public int ConsecutiveFailures { get; set; }

    /// <summary>The signing secret (<c>whsec_…</c>), in the answer of <see cref="WebhookService.CreateAsync"/> only.</summary>
    [JsonPropertyName("secret")]
    public string? Secret { get; set; }

    /// <summary>When the endpoint was registered.</summary>
    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When it last changed.</summary>
    [JsonPropertyName("updated_at")]
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads a webhook endpoint.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not one.</exception>
    public static WebhookEndpoint FromJson(JsonElement json)
    {
        var endpoint = ModelReader.Read(json, FormfeedJson.Default.WebhookEndpoint);
        endpoint.Raw = json.Clone();
        return endpoint;
    }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Id ??= "";
        Url ??= "";
        Events ??= [];
        Environments ??= [];
    }
}
